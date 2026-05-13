import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// 1. 환경 변수 로드 (.env 파일 직접 파싱하여 process.env에 로드 - dotenv 의존성 배제)
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const parts = trimmed.split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join('=').trim();
          process.env[key] = val;
        }
      }
    });
  }
} catch (e) {
  console.warn("⚠️ .env 파일을 로드하는 도중 에러가 발생했습니다:", e.message);
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ 오류: Supabase URL 또는 인증 키(Service Role Key)가 누락되었습니다.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// 🔍 식재료 자동 카테고리 매핑용 데이터 정의 및 분석 엔진
const CATEGORY_DETAILS = {
  1: { name: "채소", location: "fresh", defaultExpiry: 7 },
  2: { name: "곡류", location: "outer", defaultExpiry: 30 },
  3: { name: "육류", location: "fresh", defaultExpiry: 7 },
  4: { name: "수산물", location: "chilled", defaultExpiry: 7 },
  5: { name: "과일류", location: "fresh", defaultExpiry: 7 },
  6: { name: "유제품", location: "chilled", defaultExpiry: 7 },
  7: { name: "알류", location: "fresh", defaultExpiry: 14 },
  8: { name: "빵", location: "outer", defaultExpiry: 3 },
  9: { name: "샐러드", location: "fresh", defaultExpiry: 3 },
  10: { name: "과자", location: "outer", defaultExpiry: 30 },
  11: { name: "음료", location: "chilled", defaultExpiry: 30 },
  12: { name: "간편식", location: "chilled", defaultExpiry: 30 },
  13: { name: "반찬", location: "chilled", defaultExpiry: 3 },
  14: { name: "냉동식품", location: "frozen", defaultExpiry: 30 },
  15: { name: "미분류", location: "chilled", defaultExpiry: 7 }
}

const KEYWORD_MAPPINGS = [
  {
    categoryId: 3, // 육류
    keywords: ["삼겹살", "목살", "소고기", "돼지고기", "닭고기", "오리고기", "한우", "갈비", "베이컨", "사골", "통닭", "소시지", "햄", "육류", "고기", "돈까스", "차돌박이", "등심", "안심", "닭가슴살", "순대", "목우촌", "치킨"]
  },
  {
    categoryId: 6, // 유제품
    keywords: ["우유", "요거트", "치즈", "버터", "생크림", "요플레", "유제품", "치즈케익", "연유", "휘핑"]
  },
  {
    categoryId: 7, // 알류
    keywords: ["계란", "달걀", "메추리알", "알류", "날달걀", "훈제란", "란", "구운란"]
  },
  {
    categoryId: 8, // 빵
    keywords: ["식빵", "소금빵", "크로와상", "도넛", "케이크", "베이커리", "단팥빵", "샌드위치", "빵", "토스트", "머핀", "바게트", "베이글"]
  },
  {
    categoryId: 1, // 채소
    keywords: ["상추", "깻잎", "배추", "무", "양파", "당근", "마늘", "파", "파프리카", "브로콜리", "시금치", "양배추", "감자", "고구마", "채소", "야채", "고추", "버섯", "호박", "오이", "콩나물", "대파", "쪽파", "팽이버섯", "가지"]
  },
  {
    categoryId: 2, // 곡류
    keywords: ["쌀", "보리", "현미", "밀가루", "잡곡", "곡물", "곡류", "햇반", "즉석밥", "누룽지"]
  },
  {
    categoryId: 4, // 수산물
    keywords: ["생선", "고등어", "갈치", "조기", "새우", "오징어", "조개", "낙지", "게", "회", "수산물", "굴", "명란", "어묵", "연어", "참치", "전복", "오징어", "꽃게"]
  },
  {
    categoryId: 5, // 과일류
    keywords: ["사과", "바나나", "딸기", "수박", "참외", "포도", "귤", "오렌지", "망고", "체리", "토마토", "과일", "레몬", "복숭아", "참다래", "키위", "자두", "파인애플", "멜론"]
  },
  {
    categoryId: 9, // 샐러드
    keywords: ["샐러드", "셀러드", "양상추", "시저", "리코타", "훈제연어샐러드"]
  },
  {
    categoryId: 10, // 과자
    keywords: ["과자", "초콜릿", "사탕", "젤리", "감자칩", "스낵", "쿠키", "껌", "초코", "비스킷", "캬라멜"]
  },
  {
    categoryId: 11, // 음료
    keywords: ["물", "생수", "탄산수", "콜라", "사이다", "주스", "커피", "차", "음료", "맥주", "소주", "와인", "막걸리", "두유", "에이드", "식혜", "녹차", "홍차"]
  },
  {
    categoryId: 12, // 간편식
    keywords: ["라면", "컵라면", "컵반", "만두", "피자", "핫도그", "햄버거", "도시락", "밀키트", "간편식", "즉석", "떡볶이", "볶음밥", "파스타", "짜장면"]
  },
  {
    categoryId: 13, // 반찬
    keywords: ["김치", "멸치볶음", "장조림", "나물", "반찬", "젓갈", "진미채", "무침", "조림", "깍두기", "장아찌", "피클", "단무지"]
  },
  {
    categoryId: 14, // 냉동식품
    keywords: ["아이스크림", "냉동만두", "냉동피자", "냉동식품", "냉동"]
  }
];

/**
 * 🧠 한글 끝단어 우선 매칭을 이용한 고성능 식재료 카테고리 매핑 엔진
 */
function classifyFood(name) {
  if (!name) return { categoryId: 15, location: 'chilled', shelfLife: 7 };
  
  let bestMatch = null;
  let lastIndex = -1;
  
  for (const mapping of KEYWORD_MAPPINGS) {
    for (const keyword of mapping.keywords) {
      const idx = name.lastIndexOf(keyword);
      if (idx !== -1 && idx >= lastIndex) {
        lastIndex = idx;
        bestMatch = mapping.categoryId;
      }
    }
  }
  
  const categoryId = bestMatch || 15;
  const details = CATEGORY_DETAILS[categoryId] || CATEGORY_DETAILS[15];
  
  return {
    categoryId: categoryId,
    location: details.location,
    shelfLife: details.defaultExpiry
  };
}

async function runMigration() {
  console.log("====================================================");
  console.log("🔄 [마이그레이션]: 기존 15번(미분류) 식재료 재분류를 가동합니다.");
  console.log("====================================================");

  let updatedCount = 0;
  let totalProcessed = 0;
  let hasMore = true;
  const pageSize = 500;

  while (hasMore) {
    // 15번(미분류) 카테고리인 항목들을 한 페이지 단위로 SELECT
    const { data: rows, error: selectError } = await supabase
      .from('expert_food_intelligence')
      .select('*')
      .eq('category_id', 15)
      .limit(pageSize);

    if (selectError) {
      console.error("❌ DB 데이터 조회 실패:", selectError.message);
      break;
    }

    if (!rows || rows.length === 0) {
      console.log("✅ 미분류(15번) 상태의 식재료가 더 이상 없습니다.");
      break;
    }

    console.log(`📦 미분류 항목 ${rows.length}개 조회 완료. 재분류 처리 중...`);

    const updatePayloads = [];

    for (const item of rows) {
      const mapping = classifyFood(item.item_name);
      
      // 실제 매핑 결과가 15번이 아닌 다른 카테고리로 변경되었을 때만 업데이트 페이로드에 추가
      if (mapping.categoryId !== 15) {
        updatePayloads.push({
          id: item.id,
          item_name: item.item_name,
          category_id: mapping.categoryId,
          shelf_life: mapping.shelfLife,
          storage_method: mapping.location,
          nutrition_info: item.nutrition_info,
          storage_tip: item.storage_tip
        });
        
        // 매칭 상황 실시간 20개마다 하나씩 로그 표시
        if (updatePayloads.length % 20 === 0) {
          console.log(` - 매칭 성공: "${item.item_name}" ➡️ ${CATEGORY_DETAILS[mapping.categoryId].name} (ID: ${mapping.categoryId})`);
        }
      }
    }

    totalProcessed += rows.length;

    if (updatePayloads.length > 0) {
      console.log(`🚀 ${updatePayloads.length}개의 정제된 데이터를 Supabase에 일괄 Upsert 중...`);
      const { error: upsertError } = await supabase
        .from('expert_food_intelligence')
        .upsert(updatePayloads, { onConflict: 'id' });

      if (upsertError) {
        console.error("❌ 일괄 적재 실패:", upsertError.message);
        break;
      }

      updatedCount += updatePayloads.length;
      console.log(`⚡ 현재까지 총 ${totalProcessed}개 중 ${updatedCount}개 식재료 재분류 완료.`);
    } else {
      console.log(`ℹ️ 이번 배치(${rows.length}개)에서는 매칭된 키워드가 없어 미분류(15번)로 유지되었습니다.`);
    }

    // 만약 조회된 행 개수가 pageSize보다 작다면 더 이상 처리할 다음 페이지가 없음
    if (rows.length < pageSize) {
      hasMore = false;
    }
    
    // API 레이트 리밋 방지차 간격 주기
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log("====================================================");
  console.log(`🎉 [마이그레이션 완료]: 총 ${totalProcessed}개의 미분류 식재료를 탐색하여 ${updatedCount}개의 식재료를 알맞은 카테고리로 완벽 재분류하였습니다!`);
  console.log("====================================================");
}

runMigration();
