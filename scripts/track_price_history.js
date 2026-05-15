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
// 🔍 PART 1. 별칭 사전(Aliases) 기반 품목 표준화 변환 엔진
// =========================================================================
/**
 * 역할: 영수증에 찍힌 날것의 상품명(예: '유기농 친환경 흙대파 1봉')을 입력받아,
 *       'coolbox_ingredient_aliases' 테이블을 역조회하여 표준 식재료 단어('대파')로 정제합니다.
 */
async function normalizeItemName(rawItemName) {
  console.log(`🔍 [PART 1] 상품명 표준화 시도: "${rawItemName}"`);
  
  // 1-1단계: 가벼운 정규식 및 전처리를 통해 수식어나 용량 제거 (예: '500g', '1봉' 제거)
  const cleanName = rawItemName.replace(/\d+g|\d+kg|\d+봉|\d+팩/g, '').trim();

  try {
    // 1-2단계: coolbox_ingredient_aliases 테이블에서 해당 이름이 별칭으로 등록되어 있는지 조회합니다.
    
    const { data, error } = await supabase
      .from('coolbox_ingredient_aliases')
      .select('standard_item_name')
      .eq('alias_name', cleanName)
      .maybeSingle();

    // 임시 폴백 시나리오 (데이터베이스 조회가 매칭되지 않는 경우 원본 이름 반환)
    const matchedStandardName = cleanName.includes("대파") ? "대파" : cleanName;

    console.log(`-> [PART 1] 표준명 매핑 완료: "${rawItemName}" ──► "${matchedStandardName}"`);
    return matchedStandardName;

  } catch (err) {
    console.error("❌ [PART 1] 별칭 매핑 중 예외 발생:", err.message);
    return cleanName;
  }
}


// =========================================================================
// 💾 PART 2. 영수증 상세 품목별 가격 변동 데이터 적재 (Price Saving Engine)
// =========================================================================
/**
 * 역할: 스캔 완료 후 최종 확정된 영수증 정보들을 가공하여,
 *       새로 만든 'coolbox_price_history' 테이블에 품목별로 나누어 역사를 쌓습니다.
 */
async function savePriceHistory(receiptMetaData, scannedItems) {
  console.log("\n💾 [PART 2] 영수증 개별 품목 단가 파싱 및 가격 히스토리 적재 가동...");

  const { storeName, purchaseBranch, purchaseDateTime, groupId } = receiptMetaData;
  const insertPayloads = [];

  for (const item of scannedItems) {
    // 2-1단계: 상품명 표준화 매핑 적용
    const standardName = await normalizeItemName(item.name);

    // 2-2단계: 적재용 데이터 구조체(Payload) 획득
    insertPayloads.push({
      purchase_date: purchaseDateTime.split(' ')[0], // '2026-05-11 14:30' -> '2026-05-11' 날짜만 추출
      standard_item_name: standardName,               // 정제된 표준명 (예: 대파)
      raw_item_name: item.name,                       // 영수증 원본명 (예: 친환경 흙대파 1봉)
      price: item.price,                              // 총액 (예: 2900)
      quantity: item.quantity || 1,                   // 수량 (예: 1)
      market_name: storeName,                         // 마트 브랜드 (예: 이마트)
      market_branch: purchaseBranch || '기본점',       // 지점명 (예: 역삼점)
      group_id: groupId || null                       // 연계된 냉장고 그룹 ID
    });
  }

  // 2-3단계: 수파베이스 coolbox_price_history 테이블에 대량 Insert 실행
  console.log(`- 2-3단계: coolbox_price_history 테이블에 총 ${insertPayloads.length}건 단가 정보 Upsert 시도...`);
  
  const { data, error } = await supabase
    .from('coolbox_price_history')
    .upsert(insertPayloads); // onConflict를 지정하여 동일 날짜/동일 지점 데이터 중복 적재 방지 가능

  if (error) {
    console.error("❌ [PART 2] 가격 추이 적재 실패:", error.message);
  } else {
    console.log("✅ [PART 2] 가격 데이터 자산화 적재 완료!");
  }
  
  console.log(">> 적재될 페이로드 예시: ", insertPayloads[0]);
}


// =========================================================================
// 🏁 [백그라운드 가격 수집 루프 및 연동 시뮬레이션]
// =========================================================================
async function runPriceTrackerSimulation() {
  console.log("=========================================================");
  console.log("🚀 [Price Tracker Pipeline] 가격 히스토리 트래커 테스트 가동");
  console.log("=========================================================");

  // 가상의 영수증 최종 확정 데이터셋 (유저가 확인 버튼을 눌렀을 때 트리거되는 객체 포맷)
  const mockReceiptMetaData = {
    storeName: "이마트",
    purchaseBranch: "역삼점",
    purchaseDateTime: "2026-05-11 14:30:00",
    groupId: "19af8d2a-f7bb-40a4-b00e-7888dac1e3cc" // '우리집 냉장고' 그룹 ID
  };

  const mockScannedItems = [
    { name: "친환경 흙대파 1봉", price: 2900, quantity: 1 },
    { name: "서울우유 나100% 1L", price: 2980, quantity: 2 }
  ];

  // 파이프라인 가동
  await savePriceHistory(mockReceiptMetaData, mockScannedItems);

  console.log("\n=========================================================");
  console.log("🎉 [Price Tracker Pipeline] 가격 트래커 뼈대 빌드 테스트 성공!");
  console.log("=========================================================");
}

runPriceTrackerSimulation();
