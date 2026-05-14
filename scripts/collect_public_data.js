import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

// 1. 환경 변수 로드 (.env 파일 직접 파싱하여 process.env에 로드)
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

// 3대 공공데이터 API 키 클리닝
const cleanKey = (key) => key?.trim()?.replace(/[\u200B-\u200D\uFEFF]/g, '')?.replace(/[\r\n]/g, '');
const FOOD_FNCLTY_API_KEY = cleanKey(process.env.VITE_FOOD_FNCLTY_API_KEY);
const RECIPE_API_KEY = cleanKey(process.env.VITE_RECIPE_API_KEY);
const NUTRITION_API_KEY = cleanKey(process.env.VITE_NUTRITION_API_KEY);

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
  15: { name: "미분류", location: "chilled", defaultExpiry: 7 },
  16: { name: "배달/외식", location: "fresh", defaultExpiry: 0 },
  17: { name: "소스/양념", location: "outer", defaultExpiry: 30 }
};

const KEYWORD_MAPPINGS = [
  { categoryId: 1, keywords: ["상추", "깻잎", "배추", "무", "양파", "당근", "마늘", "파", "파프리카", "브로콜리", "시금치", "양배추", "감자", "고구마", "채소", "야채", "고추", "버섯", "호박", "오이", "콩나물", "대파", "쪽파", "팽이버섯", "가지", "피망", "숙주", "미나리", "부추", "쑥갓", "고사리", "도라지", "청경채", "샐러리", "깻잎순", "얼갈이", "열무", "취나물", "참나물"] },
  { categoryId: 2, keywords: ["쌀", "보리", "현미", "잡곡", "곡물", "곡류", "햇반", "즉석밥", "누룽지"] },
  { categoryId: 3, keywords: ["삼겹살", "목살", "소고기", "돼지고기", "닭고기", "오리고기", "한우", "갈비", "베이컨", "사골", "통닭", "소시지", "햄", "육류", "고기", "돈까스", "차돌박이", "등심", "안심", "닭가슴살", "순대", "목우촌", "치킨", "목심", "채끝", "우둔", "양지", "사태"] },
  { categoryId: 4, keywords: ["생선", "고등어", "갈치", "조기", "새우", "오징어", "조개", "낙지", "게", "회", "수산물", "굴", "명란", "어묵", "연어", "참치", "전복", "꽃게", "삼치", "미역", "김", "임연수", "이면수", "다시마", "미역줄기", "해삼", "톳", "매생이", "꼬시래기", "파래", "우뭇가사리"] },
  { categoryId: 5, keywords: ["사과", "바나나", "딸기", "수박", "참외", "포도", "귤", "오렌지", "망고", "체리", "토마토", "과일", "레몬", "복숭아", "참다래", "키위", "자두", "파인애플", "멜론"] },
  { categoryId: 6, keywords: ["우유", "치즈", "요거트", "요플레", "버터", "야쿠르트", "두유", "생크림", "유제품", "모짜렐라", "체다치즈", "치즈케익", "연유", "휘핑"] },
  { categoryId: 7, keywords: ["계란", "달걀", "메추리알", "오리알", "유정란", "왕란", "특란", "알류", "날달걀", "훈제란", "구운란"] },
  { categoryId: 8, keywords: ["빵", "식빵", "베이글", "크루아상", "케이크", "샌드위치", "도넛", "카스텔라", "바게트", "소금빵", "단팥빵", "베이커리", "토스트", "머핀"] },
  { categoryId: 9, keywords: ["샐러드", "다이어트", "시저", "리코타", "훈제연어샐러드", "감자샐러드", "콘샐러드", "단호박샐러드", "마카로니샐러드", "게살샐러드", "참치샐러드"] },
  { categoryId: 10, keywords: ["과자", "초콜릿", "사탕", "젤리", "감자칩", "스낵", "쿠키", "껌", "초코", "비스킷", "캬라멜"] },
  { categoryId: 11, keywords: ["물", "생수", "탄산수", "콜라", "사이다", "주스", "커피", "차", "음료", "맥주", "소주", "와인", "막걸리", "두유", "에이드", "식혜", "녹차", "홍차", "티백", "잎차", "분말차", "말차", "콤부차", "아이스티", "밀크티", "분말", "라떼분말", "드립백", "원두"] },
  { categoryId: 12, keywords: ["라면", "컵라면", "컵반", "핫도그", "햄버거", "도시락", "밀키트", "간편식", "즉석", "떡볶이", "볶음밥", "파스타", "짜장면", "햇반"] },
  { categoryId: 13, keywords: ["김치", "멸치볶음", "장조림", "나물", "반찬", "젓갈", "진미채", "무침", "조림", "깍두기", "장아찌", "피클", "단무지", "계란찜", "총각김치", "파김치", "콩자반", "무생채", "오이무침", "계란말이", "볶음김치", "명란", "국", "찌개", "찜", "매운탕", "삼계탕", "갈비탕", "추어탕", "장어탕", "설렁탕", "곰탕", "감자탕"] },
  { categoryId: 14, keywords: ["아이스크림", "냉동만두", "냉동피자", "냉동식품", "냉동", "파르페", "베스킨라빈스31"] },
  { categoryId: 16, keywords: ["쿠팡이츠", "배달의민족", "배민", "요기요", "배달특급", "땡겨요", "coupang eats", "스쿨피자", "도미노피자", "미스터피자", "피자헛", "파파존스", "피자나라치킨공주", "알볼로", "굽네치킨", "교촌치킨", "BHC", "BBQ", "처갓집", "푸라닭", "네네치킨", "굽네", "지코바", "호식이", "스타벅스", "투썸플레이스", "이디야", "메가커피", "빽다방", "컴포즈", "커피빈", "할리스", "파스쿠찌", "맥도날드", "롯데리아", "버거킹", "맘스터치", "KFC", "쉑쉑", "수제버거", "엽기떡볶이", "신전떡볶이", "배스킨라빈스", "설빙", "아웃백", "빕스", "애슐리", "한솥", "도시락통", "배달", "외식", "포장", "완제품", "테이크아웃", "딜리버리"] },
  { categoryId: 17, keywords: ["고추장","된장","케찹","마요네즈","소금","후추","간장", "올리고당", "식용유", "참기름", "식초", "굴소스", "머스타드","칠리소스","와사비","쌈장","연두","케첩","돈까스소스","허니머스타드","핫소스", "데리야끼소스","타르타르소스","발사믹소스", "핫칠리소스", "탕수육소스", "마늘소스", "매실원액", "설탕", "양념", "액젓", "살사","그라나파다노", "올리브유", "올리브오일", "카놀라유", "포도씨유", "아마씨유", "해바라기씨유","들기름","미원","다시다","MSG","밀가루","빵가루","중력분","생강","고춧가루","가루"] }
];

/**
 * 🧹 상품명 문자열에서 괄호, 대괄호, 쉼표, 특수문자, 영문자, 불필요 공백을 완벽하게 제거하는 정제 엔진
 */
function sanitizeItemName(rawName) {
  if (!rawName) return "";
  return rawName
    .replace(/\([^)]*\)/g, '')   // 소괄호와 그 안의 내용 제거
    .replace(/\[[^\]]*\]/g, '')  // 대괄호와 그 안의 내용 제거
    .replace(/[a-zA-Z]/g, '')    // 영문자 제거
    .replace(/[,\.!?@#$%^&*_+\-=<>:;`~]/g, ' ') // 쉼표 및 특수문자를 공백으로 변환
    .replace(/\s+/g, ' ')        // 다중 공백을 단일 공백으로 압축
    .trim();
}

/**
 * 🧠 한글 끝단어 우선 매칭을 이용한 고성능 식재료 카테고리 매핑 엔진
 */
function classifyFood(name) {
  if (!name) return { categoryId: 15, location: 'chilled', shelfLife: 7 };
  
  const cleanStr = sanitizeItemName(name);
  let bestMatch = null;
  let lastIndex = -1;
  
  for (const mapping of KEYWORD_MAPPINGS) {
    for (const keyword of mapping.keywords) {
      const idx = cleanStr.lastIndexOf(keyword);
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

// 2. 수집 설정 상수 정의
const MAX_CALLS_PER_DAY = 999;     // 일일 최대 호출 제한 (999회)
const INTERVAL_MS = 3000;         // 호출 간격 제한: 정확히 3초 (3,000ms)

// 🔑 [보안 및 키 정적 분석 진단]
console.log("====================================================");
console.log(`🔑 [환경 변수 로딩 진단]:`);
const checkKey = (name, key) => {
  if (!key) {
    console.log(`- ${name}: ❌ 미설정 (falsy)`);
    return;
  }
  const len = key.length;
  const isMasked = key.includes('***') || key === '***';
  const start = key.slice(0, 3);
  const end = key.slice(-3);
  console.log(`- ${name}: 설정됨 (길이: ${len}자 | 마스킹: ${isMasked} | 시작/끝: ${start}...${end})`);
};
checkKey('FOOD_FNCLTY_API_KEY', FOOD_FNCLTY_API_KEY);
checkKey('RECIPE_API_KEY', RECIPE_API_KEY);
checkKey('NUTRITION_API_KEY', NUTRITION_API_KEY);
console.log("====================================================");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ 오류: Supabase URL 또는 인증 키(Service Role Key)가 누락되었습니다.");
  process.exit(1);
}

// Supabase 마스터 권한 클라이언트 생성
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/**
 * ⏳ 호출 간격 준수를 위한 지연(Sleep) 유틸리티 함수
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 🗃️ 각 API별 최신 수집 인덱스(Start Index) 가져오기 및 업데이트 로직
 */
async function getNextStartIndex(apiName, defaultStart = 1) {
  try {
    const { data, error } = await supabase
      .from('coolbox_sync_state')
      .select('last_index')
      .eq('api_name', apiName)
      .maybeSingle();

    if (error) return defaultStart;
    return data ? data.last_index + 1 : defaultStart;
  } catch (err) {
    return defaultStart;
  }
}

async function updateLastIndex(apiName, lastIndex) {
  try {
    await supabase
      .from('coolbox_sync_state')
      .upsert({ api_name: apiName, last_index: lastIndex, updated_at: new Date().toISOString() }, { onConflict: 'api_name' });
  } catch (err) {
    console.error(`[${apiName}] 동기화 인덱스 저장 실패:`, err);
  }
}

/**
 * 🟢 [API 1] 식품기능성 (FOOD_FNCLTY) 수집 엔진 -> expert_food_intelligence 적재
 */
async function collectFoodFunctional() {
  const API_NAME = 'food_functional';
  if (!FOOD_FNCLTY_API_KEY) {
    console.log(`⚠️ [${API_NAME}] API 키가 설정되지 않아 수집을 건너뜁니다.`);
    return;
  }

  let currentIndex = await getNextStartIndex(API_NAME, 1);
  console.log(`🚀 [${API_NAME}] 수집을 시작합니다. (시작 인덱스: ${currentIndex})`);

  for (let i = 0; i < MAX_CALLS_PER_DAY; i++) {
    const startIndex = currentIndex;
    const endIndex = currentIndex;

    const url = `http://openapi.foodsafetykorea.go.kr/api/${FOOD_FNCLTY_API_KEY}/W_DI_FOODINGREDIENTFNCLTY/json/${startIndex}/${endIndex}`;
    
    try {
      console.log(`[${API_NAME}] 호출 중... (${i + 1}/${MAX_CALLS_PER_DAY}) | Index: ${startIndex}`);
      const response = await fetch(url);
      const resText = await response.text();
      
      if (response.ok) {
        try {
          const resData = JSON.parse(resText);
          const rootData = resData.W_DI_FOODINGREDIENTFNCLTY || resData;
          const rows = rootData.row || [];
          
          if (rows.length > 0) {
            const item = rows[0];
            const rawFoodName = item.PRDLST_NM || item.FOOD_NM || item.INGREDIENT_NM;
            
            if (rawFoodName) {
              const cleanFoodName = sanitizeItemName(rawFoodName);
              const mapping = classifyFood(cleanFoodName);
              const { error } = await supabase.from('expert_food_intelligence').insert({
                item_name: cleanFoodName,
                category_id: mapping.categoryId,
                shelf_life: mapping.shelfLife,
                storage_method: mapping.location,
                nutrition_info: {
                  calories: 0,
                  carbs: 0,
                  protein: 0,
                  fat: 0
                },
                storage_tip: `기능성 효능: ${item.FNCLTY_CN || item.EFFECT || "정보 없음"} (보관법: ${item.STORAGE_MTHD || "신선 보관"})`
              });
              
              if (error) {
                console.error(`❌ [${API_NAME}] DB 저장 실패: ${error.message}`);
              } else {
                console.log(`✅ [${API_NAME}] 수집 성공: ${cleanFoodName}`);
              }
            }
          } else {
            console.log(`[${API_NAME}] 더 이상 수집할 데이터가 없습니다. (Index: ${startIndex})`);
            break;
          }
        } catch (jsonErr) {
          console.error(`❌ [${API_NAME}] JSON 파싱 실패! 서버 원본 응답:\n${resText}`);
        }
      } else {
        console.error(`❌ [${API_NAME}] 호출 실패 (HTTP ${response.status}):\n${resText}`);
      }
    } catch (err) {
      console.error(`❌ [${API_NAME}] 네트워크 에러:`, err.message);
    }

    currentIndex++;
    await updateLastIndex(API_NAME, startIndex);

    if (i < MAX_CALLS_PER_DAY - 1) {
      await sleep(INTERVAL_MS);
    }
  }
}

/**
 * 🟡 [API 2] 공공 레시피 수집 엔진 (농식품부 64자 키 전용) -> coolbox_public_recipes 적재
 */
async function collectRecipes() {
  const API_NAME = 'recipe';
  if (!RECIPE_API_KEY) {
    console.log(`⚠️ [${API_NAME}] API 키가 설정되지 않아 수집을 건너뜁니다.`);
    return;
  }

  let currentIndex = await getNextStartIndex(API_NAME, 1);
  console.log(`🚀 [${API_NAME}] 수집을 시작합니다. (시작 인덱스: ${currentIndex})`);

  for (let i = 0; i < MAX_CALLS_PER_DAY; i++) {
    const startIndex = currentIndex;
    const endIndex = currentIndex;

    const url = `http://211.237.50.150:7080/openapi/${RECIPE_API_KEY}/json/Grid_20150827000000000228_1/${startIndex}/${endIndex}`;

    try {
      console.log(`[${API_NAME}] 호출 중... (${i + 1}/${MAX_CALLS_PER_DAY}) | Index: ${startIndex}`);
      const response = await fetch(url);
      const resText = await response.text();
      
      if (response.ok) {
        try {
          const resData = JSON.parse(resText);
          const rootData = resData.Grid_20150827000000000228_1 || resData;
          const rows = rootData.row || [];
          
          if (rows.length > 0) {
            const item = rows[0];
            const recipeName = `레시피 ${item.RECIPE_ID} (과정 ${item.COOKING_NO})`;
            
            if (recipeName) {
              const { error } = await supabase.from('coolbox_public_recipes').insert({
                recipe_name: recipeName,
                ingredients_summary: `레시피 고유번호: ${item.RECIPE_ID}`,
                cooking_method: item.COOKING_DC || "조리 설명 없음",
                cooking_time: `${item.COOKING_NO}단계`,
                calorie_info: item.STEP_TIP || "정보 없음"
              });
              
              if (error) {
                console.error(`❌ [${API_NAME}] DB 저장 실패: ${error.message}`);
              } else {
                console.log(`✅ [${API_NAME}] 수집 성공: ${recipeName}`);
              }
            }
          } else {
            console.log(`[${API_NAME}] 더 이상 수집할 데이터가 없습니다. (Index: ${startIndex})`);
            break;
          }
        } catch (jsonErr) {
          console.error(`❌ [${API_NAME}] JSON 파싱 실패! 서버 원본 응답:\n${resText}`);
        }
      } else {
        console.error(`❌ [${API_NAME}] 호출 실패 (HTTP ${response.status}):\n${resText}`);
      }
    } catch (err) {
      console.error(`❌ [${API_NAME}] 네트워크 에러:`, err.message);
    }

    currentIndex++;
    await updateLastIndex(API_NAME, startIndex);

    if (i < MAX_CALLS_PER_DAY - 1) {
      await sleep(INTERVAL_MS);
    }
  }
}

/**
 * 🔵 [API 3] 전국 식품 영양성분 정보 수집 엔진 (공공데이터포털 64자 키 전용) -> expert_food_intelligence 적재
 */
async function collectNutrition() {
  const API_NAME = 'nutrition';
  if (!NUTRITION_API_KEY) {
    console.log(`⚠️ [${API_NAME}] API 키가 설정되지 않아 수집을 건너뜁니다.`);
    return;
  }

  let currentIndex = await getNextStartIndex(API_NAME, 1);
  console.log(`🚀 [${API_NAME}] 수집을 시작합니다. (시작 인덱스: ${currentIndex})`);

  for (let i = 0; i < MAX_CALLS_PER_DAY; i++) {
    const startIndex = currentIndex;
    const endIndex = currentIndex;

    const url = `http://apis.data.go.kr/1471000/FoodNtrCpntDbInfo02/getFoodNtrCpntDbInq02?serviceKey=${NUTRITION_API_KEY}&pageNo=${startIndex}&numOfRows=1&type=json`;

    try {
      console.log(`[${API_NAME}] 호출 중... (${i + 1}/${MAX_CALLS_PER_DAY}) | Index: ${startIndex}`);
      const response = await fetch(url);
      const resText = await response.text();
      
      if (response.ok) {
        try {
          const resData = JSON.parse(resText);
          const rootData = resData.getFoodNtrCpntDbInq02 || resData;
          const items = rootData.body?.items || [];
          
          if (items.length > 0) {
            const item = items[0];
            const rawFoodName = item.FOOD_NM_KR || item.DESC_KOR || item.ITEM_NAME;
            
            if (rawFoodName) {
              const baseName = rawFoodName.split('_')[1] || rawFoodName.split('_')[0] || rawFoodName;
              const cleanName = sanitizeItemName(baseName);
              const mapping = classifyFood(cleanName);
              
              const { error } = await supabase.from('expert_food_intelligence').insert({
                item_name: cleanName,
                category_id: mapping.categoryId,
                shelf_life: mapping.shelfLife,
                storage_method: mapping.location,
                nutrition_info: {
                  calories: parseFloat(item.AMT_NUM1) || 0,
                  carbs: parseFloat(item.AMT_NUM7) || 0,
                  protein: parseFloat(item.AMT_NUM3) || 0,
                  fat: parseFloat(item.AMT_NUM4) || 0
                },
                storage_tip: `신선 보관하세요. (분류: ${item.DB_GRP_NM || '가공식품'}, 1회제공량: ${item.SERVING_SIZE || '100g'})`
              });
           
              if (error) {
                console.error(`❌ [${API_NAME}] DB 저장 실패: ${error.message}`);
              } else {
                console.log(`✅ [${API_NAME}] 수집 성공: ${cleanName}`);
              }
            }
          } else {
            console.log(`[${API_NAME}] 더 이상 수집할 데이터가 없습니다. (Index: ${startIndex})`);
            break;
          }
        } catch (jsonErr) {
          console.error(`❌ [${API_NAME}] JSON 파싱 실패! 서버 원본 응답:\n${resText}`);
        }
      } else {
        console.error(`❌ [${API_NAME}] 호출 실패 (HTTP ${response.status}):\n${resText}`);
      }
    } catch (err) {
      console.error(`❌ [${API_NAME}] 네트워크 에러:`, err.message);
    }

    currentIndex++;
    await updateLastIndex(API_NAME, startIndex);

    if (i < MAX_CALLS_PER_DAY - 1) {
      await sleep(INTERVAL_MS);
    }
  }
}

/**
 * 🏁 [메인 루프 가동]
 */
async function runAllCollectors() {
  console.log("====================================================");
  console.log(`⏰ [수집 개시]: ${new Date().toLocaleString()}`);
  console.log(`⚙️ [설정]: 일일 최대 ${MAX_CALLS_PER_DAY}회 호출 | 각 호출 간격 ${INTERVAL_MS / 1000}초`);
  console.log("====================================================");

  try {
    await Promise.all([
      collectFoodFunctional(),
      collectRecipes(),
      collectNutrition()
    ]);
    
    console.log("====================================================");
    console.log(`🎉 [수집 완료]: 오늘 일일 할당량 분량의 공공데이터 수집을 성공적으로 완수했습니다.`);
    console.log("====================================================");
  } catch (error) {
    console.error("❌ 수집 루프 도중 심각한 장애 발생:", error);
  }
}

runAllCollectors();

