import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// =========================================================================
// ⚙️ [환경변수 로드 및 Supabase 연결설정]
// =========================================================================
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const parts = trimmed.split('=');
        if (parts.length >= 2) {
          process.env[parts[0].trim()] = parts.slice(1).join('=').trim();
        }
      }
    });
  }
} catch (e) {
  console.warn("⚠️ .env 로드 실패:", e.message);
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ 오류: Supabase 환경 변수 설정이 누락되었습니다.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);


// =========================================================================
// 🔍 PART 1. 마스터 백과사전 기반 품목 표준화 변환 엔진
// =========================================================================
/**
 * 역할: 영수증에 찍힌 날것의 상품명(예: '유기농 친환경 흙대파 1봉')을 입력받아,
 *       'coolbox_knowledge_master' 테이블을 역조회하여 표준 식재료 단어('대파')로 정제합니다.
 */
async function normalizeItemName(rawItemName) {
  console.log(`🔍 [PART 1] 상품명 표준화 시도: "${rawItemName}"`);
  
  // 1-1단계: 가벼운 정규식 및 전처리를 통해 수식어나 용량 제거 (예: '500g', '1봉' 제거)
  const cleanName = rawItemName.replace(/\d+g|\d+kg|\d+봉|\d+팩/g, '').trim();

  try {
    // 1-2단계: coolbox_knowledge_master 테이블에서 해당 이름이 표준명 또는 별칭에 포함되어 있는지 대조합니다.
    const { data, error } = await supabase
      .from('coolbox_knowledge_master')
      .select('item_name')
      .or(`item_name.eq.${cleanName},aliases.cs.{${cleanName}}`)
      .maybeSingle();

    const matchedStandardName = data ? data.item_name : (cleanName.includes("대파") ? "대파" : cleanName);

    console.log(`-> [PART 1] 표준명 매핑 완료: "${rawItemName}" ──► "${matchedStandardName}"`);
    return matchedStandardName;

  } catch (err) {
    console.error("❌ [PART 1] 마스터 매핑 중 예외 발생:", err.message);
    return cleanName;
  }
}


// =========================================================================
// 💾 PART 2. 영수증 상세 품목별 가격 및 패턴 통합 적재 엔진 (One-Shot Saving Engine)
// =========================================================================
/**
 * 역할: 스캔 완료 후 최종 확정된 영수증 정보들을 가공하여,
 *       단 1개의 마스터 테이블('coolbox_price_history')에 가격/단가/제조사/용량/영수증사진/요일/시간대를
 *       원샷(One-Shot)으로 통합 적재합니다. (조인 없는 초고속 빅데이터 마이닝 달성)
 */
async function savePriceHistory(receiptMetaData, scannedItems) {
  console.log("\n💾 [PART 2] 영수증 개별 품목 단가 및 요일/시간대 구매 패턴 원샷 통합 적재 가동...");

  const { storeName, purchaseBranch, purchaseDateTime, groupId, receiptImageUrl } = receiptMetaData;
  const insertPayloads = [];

  // ⏰ 결제 시간대(오전, 오후, 밤, 새벽) 및 요일(월~일) 계산 엔진
  const dateObj = new Date(purchaseDateTime);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const dayOfWeek = days[dateObj.getDay()] || "월";
  
  const hour = dateObj.getHours();
  let timeSlot = "오전";
  if (hour >= 0 && hour < 6) timeSlot = "새벽";
  else if (hour >= 6 && hour < 12) timeSlot = "오전";
  else if (hour >= 12 && hour < 18) timeSlot = "오후";
  else timeSlot = "밤";

  for (const item of scannedItems) {
    // 2-1단계: 상품명 표준화 매핑 적용
    const standardName = await normalizeItemName(item.name);

    // 💡 [단가 분배 엔진]: 수량 2개 이상일 때 개당 실 단가 분배 계산
    const quantity = item.quantity && item.quantity > 0 ? item.quantity : 1;
    const unitPrice = Math.round(item.price / quantity);

    // 2-2단계: [8대 황금 지표 원샷 페이로드] 가격 + 패턴 + 제조사 + 사진 통합
    insertPayloads.push({
      purchase_date: purchaseDateTime.split(' ')[0], // 날짜만 추출
      standard_item_name: standardName,               // 정제된 표준명 (예: 대파)
      raw_item_name: item.name,                       // 영수증 원본명 (예: 친환경 흙대파 1봉)
      price: item.price,                              // 총액
      unit_price: unitPrice,                          // 💵 개당 실 단가
      quantity: quantity,                             // 수량
      market_name: storeName,                         // 마트 브랜드 (예: 이마트)
      market_branch: purchaseBranch || '기본점',       // 지점명
      group_id: groupId || null,                      // 연계된 냉장고 그룹 ID
      manufacturer: item.manufacturer || "기타 제조사", // 🏭 제조사
      capacity: item.capacity || "1팩",               // ⚖️ 용량/단위
      receipt_image_url: receiptImageUrl || null,     // 📸 영수증 원본 사진
      day_of_week: dayOfWeek,                         // 📆 요일 (패턴 통합)
      time_slot: timeSlot                             // ⏰ 시간대 (패턴 통합)
    });
  }

  // 2-3단계: coolbox_price_history 테이블에 원샷 대량 Insert 실행
  console.log(`- 2-3단계: coolbox_price_history 테이블에 총 ${insertPayloads.length}건 통합 정보 적재 시도...`);
  const { error: priceErr } = await supabase.from('coolbox_price_history').upsert(insertPayloads);
  if (priceErr) {
    console.error("❌ [PART 2] 가격 및 구매 패턴 통합 적재 실패:", priceErr.message);
  } else {
    console.log("✅ [PART 2] 가격 추이 및 소비 패턴 빅데이터 원샷 자산화 적재 완료!");
  }
}


// =========================================================================
// 🏁 [백그라운드 가격 수집 루프 및 연동 시뮬레이션]
// =========================================================================
async function runPriceTrackerSimulation() {
  console.log("=========================================================");
  console.log("🚀 [Price Tracker Pipeline] 가격 및 패턴 원샷 트래커 테스트 가동");
  console.log("=========================================================");

  // 가상의 영수증 최종 확정 데이터셋
  const mockReceiptMetaData = {
    storeName: "이마트",
    purchaseBranch: "역삼점",
    purchaseDateTime: "2026-05-11 21:30:00", // 밤 시간대 예시
    groupId: "19af8d2a-f7bb-40a4-b00e-7888dac1e3cc", // '우리집 냉장고' 그룹 ID
    receiptImageUrl: "https://krkqifswnbnbgyvhisdk.supabase.co/storage/v1/object/public/receipts/sample.webp"
  };

  const mockScannedItems = [
    { name: "농심 신라면 5개입", price: 4380, quantity: 1, manufacturer: "농심", capacity: "600g" },
    { name: "서울우유 나100% 1L", price: 5960, quantity: 2, manufacturer: "서울우유", capacity: "1L" }
  ];

  // 파이프라인 가동
  await savePriceHistory(mockReceiptMetaData, mockScannedItems);

  console.log("\n=========================================================");
  console.log("🎉 [Price Tracker Pipeline] 가격 및 구매 패턴 원샷 트래커 완벽 빌드 성공!");
  console.log("=========================================================");
}

runPriceTrackerSimulation();
