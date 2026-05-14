import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch'; // Node 18+에서는 글로벌 fetch가 있지만 하위 호환성을 위해 추가 설정 가능
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
// RLS(보안 정책)를 우회하여 백그라운드 어드민 자산화를 가능하게 해주는 서비스 마스터 키
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_KEY;
const OPENROUTER_API_KEY = process.env.VITE_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ 오류: Supabase 환경 변수 설정이 누락되었습니다.");
  process.exit(1);
}

// Supabase 마스터 권한 클라이언트 객체 생성
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);


// =========================================================================
// 🗃️ [동기화 인덱스 관리자]
// =========================================================================
async function getNextStartId() {
  try {
    const { data, error } = await supabase
      .from('coolbox_sync_state')
      .select('last_index')
      .eq('api_name', 'enrich_food_knowledge')
      .maybeSingle();

    if (error || !data) {
      return 0; // 동기화 이력이 없으면 ID 0번(처음)부터 시작
    }
    return data.last_index;
  } catch (err) {
    return 0;
  }
}

async function updateLastId(lastId) {
  try {
    await supabase
      .from('coolbox_sync_state')
      .upsert({
        api_name: 'enrich_food_knowledge',
        last_index: lastId,
        updated_at: new Date().toISOString()
      }, { onConflict: 'api_name' });
  } catch (err) {
    console.error("❌ 동기화 ID 업데이트 실패:", err.message);
  }
}


// =========================================================================
// 🧠 PART 1. 데이터 분배 및 전처리 (Data Distribution & Pre-processing)
// =========================================================================
/**
 * 역할: 공공데이터 원본('expert_food_intelligence') 중 
 *       AI 지식화 및 캐싱 가공 처리가 아직 완료되지 않은 원재료 목록을 안전하게 선별/가져옵니다.
 */
async function fetchRawPublicData() {
  console.log("🔍 [PART 1] 지식 가공이 필요한 미분류 공공데이터 조회 시작...");
  
  // 예시 흐름: 캐시 테이블(coolbox_food_knowledge_cache)에 존재하지 않는 아이템만 조인 형태로 가져오거나, 
  // 원본 테이블에서 배치 단위(예: 10~50개)로 가져오도록 설계합니다.
  const startId = await getNextStartId();
  console.log(`- 기준 시작 ID: ${startId}`);

  const { data, error } = await supabase
    .from('expert_food_intelligence')
    .select('id, item_name, storage_tip, storage_method, category_id')
    .gt('id', startId)
    .order('id', { ascending: true })
    .limit(100); // AI 토큰 속도 제한(Rate Limit)을 고려해 한 번에 5개씩 나누어 안전하게 처리합니다.


  if (error) {
    console.error("❌ [PART 1] 원본 데이터 로드 실패:", error.message);
    return [];
  }

  console.log(`✅ [PART 1] 신규 가공 대상 데이터 ${data.length}건 확보 완료.`);
  return data;
}


// =========================================================================
// 💾 PART 2. AI 가공 및 타겟 테이블 분배 저장 (AI Parsing & Data Storage)
// =========================================================================
/**
 * 역할: 1개의 원재료명을 바탕으로 OpenRouter LLM(Gemma-2-9b)을 가동하여
 *       1) 영수증 스캔용 별칭(Aliases) 사전 데이터 추출 및 적재
 *       2) AI RAG 챗봇용 축약 지식 조각(Chunk) 생성 및 캐싱 적재
 */
async function processAndDistributeKnowledge(foodItem) {
  const { id, item_name, storage_tip, storage_method, category_id } = foodItem;
  console.log(`\n⚙️ [PART 2] '${item_name}' 품목 데이터 정밀 AI 가공 및 분배 작업 개시... (ID: ${id})`);

  // 🛑 [DB 용량 및 비용 절감 1000% 필터]: 식약처 화학 첨가물이나 공장용 향료는 AI 호출도 하지 않고 DB 저장도 일절 하지 않음 (완전 폐기)!
  const skipKeywords = ["향료", "착향료", "추출물", "농축액", "분말", "색소", "산탄검", "구연산", "아스파탐", "조미료원료", "페이스트", "혼합제제", "글루텐", "덱스트린", "젖산", "효소", "카제인", "유화제", "보존료", "아미노산", "인산", "황산", "글리세린"];
  for (const kw of skipKeywords) {
    if (item_name.includes(kw)) {
      console.log(`⚡ [DROP] '${item_name}'은(는) 불필요한 공장 첨가물이므로 DB 용량 절약을 위해 저장하지 않고 완전히 버립니다.`);
      return;
    }
  }

  if (!OPENROUTER_API_KEY) {
    console.warn("⚠️ OPENROUTER_API_KEY가 설정되지 않아 실제 AI 가공을 수행할 수 없습니다. 시뮬레이션 가상 데이터로 가동합니다.");
    return await saveMockData(foodItem);
  }

  try {
    const prompt = `당신은 대한민국 최고의 식품 안전 과학 및 백과사전 전문가입니다.
식재료명: "${item_name}"
공공 보관 팁: "${storage_tip || '정보 없음'}"
권장 보관법: "${storage_method || '정보 없음'}"

위 정보를 바탕으로, 해당 식재료에 대한 요약 보관법, 요리 꿀팁, 핵심 영양소 정보 및 해당 품목이 대형 마트 영수증에 표기될 법한 다양한 동의어/별칭 리스트 5개를 추출해 주세요.

### 🛑 카테고리 정밀 재분류 지침 (90% 확신 룰)
해당 식재료를 다음 17개 카테고리 ID 중 가장 적합한 하나로 재분류하여 'best_category_id'에 적어주세요:
1:채소, 2:곡류, 3:육류, 4:수산물, 5:과일류, 6:유제품, 7:알류, 8:빵, 9:샐러드, 10:과자, 11:음료, 12:간편식, 13:반찬, 14:냉동, 15:미분류, 16:배달/외식, 17:소스/양념.
[주의 1]: 단어에 고기나 생선 이름이 들어가 있더라도 국, 탕, 찌개 등 조리된 완제품/가공식품(예: 장어탕, 삼계탕)은 원재료(육류, 수산물)로 분류하지 말고 12번(간편식) 또는 13번(반찬)으로 배정하세요.
[주의 2]: 잡채소스, 맛베이스, 조미액, 소스, 양념 등 요리에 맛을 내기 위한 조미 액체 및 소스류는 반드시 17번(소스/양념)으로 배정하세요.
단, 90% 이상 확실하게 알지 못하는 화학 원료나 모호한 품목은 무조건 15번(미분류)으로 배정하세요.

반드시 하단에 지정된 순수 JSON 포맷으로만 응답해 주세요. 다른 수식어나 마크다운 코드 없이 JSON 객체 그 자체만 출력해야 합니다.
{
  "best_category_id": 15,
  "aliases": ["영수증 표기명 1", "영수증 표기명 2", "영수증 표기명 3", "영수증 표기명 4", "영수증 표기명 5"],
  "enriched_knowledge": {
    "short_storage_guide": "100자 이내의 친절한 냉장/냉동/실온 신선 보관 팁",
    "easy_recipe": "1. 첫단계\\n2. 두번째단계 (2-3가지의 초간단 조리 활용법)",
    "nutrition_summary": "이 식재료를 먹었을 때 얻을 수 있는 대표적인 영양 성분 효능 한줄 요약"
  }
}`;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://coolbox.app"
      },
      body: JSON.stringify({
        //model: "google/gemma-2-9b-it", // 최적의 가성비를 자랑하는 구글 Gemma 9B 모델 지정
        model: "google/gemini-2.0-flash-001", // 메인 AI 엔진인 Gemini 2.0 Flash 모델로 통일 지정
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
      })
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API 호출 실패 (HTTP ${response.status})`);
    }

    const resJson = await response.json();
    const rawText = resJson.choices[0]?.message?.content;
    
    // JSON 코드블록 (\`\`\`json ... \`\`\`) 이스케이프 클리닝 후 파싱
    const cleanJsonText = rawText.replace(/```json|```/g, '').trim();
    const parsedData = JSON.parse(cleanJsonText);

    // ---------------------------------------------------------------------
    // 📥 2-A. 궁극의 백과사전 단일 마스터 테이블 (coolbox_knowledge_master) 원샷 통합 적재
    // ---------------------------------------------------------------------
    console.log(`- 2-A단계: '${item_name}'의 별칭 사전 및 AI RAG 지식 데이터 통합 마스터 적재 중...`);
    
    // 유니크 매핑을 위해 기본명과 AI 추출 별칭 리스트 합산 및 공백 제거
    const uniqueAliases = Array.from(new Set([item_name, ...parsedData.aliases]))
      .map(name => name.trim())
      .filter(Boolean);

    // 🥇 1순위: 스크립트 내부 독립형 키워드 사전 우선 대조
    let ruleCategoryId = null;
    const ruleBook = [
      { id: 17, keywords: ["고추장","된장","케찹","마요네즈","소금","후추","간장", "올리고당", "식용유", "참기름", "식초", "굴소스", "머스타드","칠리소스","와사비","쌈장","연두","케첩","돈까스소스","허니머스타드","핫소스", "데리야끼소스","타르타르소스","발사믹소스", "핫칠리소스", "탕수육소스", "마늘소스", "매실원액", "설탕", "양념", "액젓", "살사","그라나파다노", "올리브유", "올리브오일", "카놀라유", "포도씨유", "아마씨유", "해바라기씨유","들기름","미원","다시다","MSG","밀가루","빵가루","중력분","생강","고춧가루","가루"] },
      { id: 16, keywords: ["쿠팡이츠", "배달의민족", "배민", "요기요", "배달특급","땡겨요","coupang eats", "스쿨피자", "도미노피자", "미스터피자", "피자헛", "파파존스", "피자나라치킨공주", "알볼로", "굽네치킨", "교촌치킨", "BHC", "BBQ", "처갓집", "푸라닭", "네네치킨", "굽네", "지코바", "호식이", "스타벅스", "투썸플레이스", "이디야", "메가커피", "빽다방", "컴포즈", "커피빈", "할리스", "파스쿠찌", "맥도날드", "롯데리아", "버거킹", "맘스터치", "KFC", "쉑쉑", "수제버거", "엽기떡볶이", "신전떡볶이", "배스킨라빈스", "설빙", "아웃백", "빕스", "애슐리", "한솥", "도시락통", "배달", "외식", "포장", "완제품", "테이크아웃", "딜리버리"] },
      { id: 14, keywords: ["아이스크림", "냉동만두", "냉동피자", "냉동식품", "냉동", "파르페", "베스킨라빈스31"] },
      { id: 13, keywords: ["김치", "멸치볶음", "장조림", "나물", "반찬", "젓갈", "진미채", "무침", "조림", "깍두기", "장아찌", "피클", "단무지", "계란찜", "총각김치", "파김치", "콩자반","무생채", "오이무침", "계란말이", "볶음김치", "명란", "찌개", "국", "탕", "찜"] },
      { id: 12, keywords: ["라면", "컵라면", "컵반", "핫도그", "햄버거", "도시락", "밀키트", "간편식", "즉석", "떡볶이", "볶음밥", "파스타", "짜장면"] },
      { id: 11, keywords: ["물", "생수", "탄산수", "콜라", "사이다", "주스", "커피", "차", "음료", "맥주", "소주", "와인", "막걸리", "두유", "에이드", "식혜", "녹차", "홍차","물", "생수", "탄산수", "콜라", "사이다", "주스", "커피", "차", "음료", "맥주", "소주", "와인", "막걸리", "두유", "에이드", "식혜", "녹차", "홍차", "티백", "분말", "잎차", "분말차", "말차", "콤부차", "아이스티", "밀크티", "라떼분말", "드립백", "원두"] },
      { id: 10, keywords: ["과자", "초콜릿", "사탕", "젤리", "감자칩", "스낵", "쿠키", "껌", "초코", "비스킷", "캬라멜"] },
      { id: 9, keywords: ["샐러드", "다이어트", "시저", "리코타"] },
      { id: 8, keywords: ["빵", "식빵", "베이글", "크루아상", "케이크", "샌드위치", "도넛", "카스텔라", "바게트", "소금빵", "단팥빵"] },
      { id: 7, keywords: ["계란", "달걀", "메추리알", "오리알", "유정란", "왕란", "특란"] },
      { id: 6, keywords: ["우유", "치즈", "요거트", "요플레", "버터", "야쿠르트", "두유", "생크림", "유제품", "모짜렐라", "체다치즈"] },
      { id: 5, keywords: ["사과", "바나나", "딸기", "수박", "참외", "포도", "귤", "오렌지", "망고", "체리", "토마토", "과일", "레몬", "복숭아", "키위", "자두", "파인애플", "멜론"] },
      { id: 4, keywords: ["생선", "고등어", "갈치", "조기", "새우", "오징어", "조개", "낙지", "게", "회", "수산물", "굴", "명란", "어묵", "연어", "참치", "전복", "꽃게", "삼치", "미역"] },
      { id: 3, keywords: ["삼겹살", "소고기", "돼지고기", "닭고기", "오리고기", "베이컨", "소시지", "햄", "육류", "고기", "돈까스", "차돌박이", "등심", "안심", "닭가슴살", "순대", "치킨"] },
      { id: 2, keywords: ["쌀", "보리", "현미", "밀가루", "잡곡", "곡물", "곡류", "햇반", "즉석밥", "누룽지"] },
      { id: 1, keywords: ["배추", "무", "양파", "마늘", "대파", "상추", "깻잎", "오이", "당근", "버섯", "고추", "채소", "피망", "파프리카", "브로콜리", "시금치", "콩나물", "숙주"] }
    ];

    for (const rule of ruleBook) {
      for (const kw of rule.keywords) {
        if (item_name.toLowerCase().includes(kw)) {
          ruleCategoryId = rule.id;
          break;
        }
      }
      if (ruleCategoryId) break;
    }

    const targetCategoryId = ruleCategoryId || parsedData.best_category_id || category_id || 15;

    // 💡 [원샷 마스터 페이로드]: 카테고리 + 이름 + 별칭 + 3대 지식 원샷 병합
    const masterPayload = {
      category_id: targetCategoryId,
      item_name: item_name,
      aliases: uniqueAliases,
      short_storage_guide: parsedData.enriched_knowledge.short_storage_guide,
      easy_recipe: parsedData.enriched_knowledge.easy_recipe,
      nutrition_summary: parsedData.enriched_knowledge.nutrition_summary,
      updated_at: new Date().toISOString()
    };

    const { error: masterErr } = await supabase
      .from('coolbox_knowledge_master')
      .upsert(masterPayload, { onConflict: 'item_name' });

    if (masterErr) {
      console.error(`❌ [2-A] 마스터 백과사전 적재 에러:`, masterErr.message);
    } else {
      console.log(`✅ [PART 2] '${item_name}'의 별칭 및 지식 파티셔닝 원샷 적재 완수.`);
    }

    // 성공적으로 처리된 원본 ID 보존 업데이트
    await updateLastId(id);

  } catch (err) {
    console.error(`❌ [PART 2] '${item_name}' AI 가공 중 에러 발생:`, err.message);
  }
}

/**
 * 환경 변수 키가 없을 때 작동할 하이브리드 모의 적재 폴백 엔진
 */
async function saveMockData(foodItem) {
  const { id, item_name, storage_method, category_id } = foodItem;
  const mockAliases = [item_name, `국산${item_name}`, `신선${item_name}`, `${item_name}세일`];
  
  await supabase.from('coolbox_knowledge_master').upsert({
    category_id: category_id,
    item_name: item_name,
    aliases: mockAliases,
    short_storage_guide: `${item_name}은(는) 신선 보관해야 합니다.`,
    easy_recipe: `1. 흐르는 물에 깨끗이 세척하기\n2. 조리 마지막 단계에 넣기`,
    nutrition_summary: `풍부한 무기질과 식이섬유를 포함하고 있어 식단 밸런스에 훌륭합니다.`,
    updated_at: new Date().toISOString()
  }, { onConflict: 'item_name' });

  await updateLastId(id);
  console.log(`✅ [PART 2-폴백] '${item_name}' 모크 데이터 생성 및 마스터 동기화 업데이트 완료.`);
}


// =========================================================================
// 🤖 PART 3. AI 챗봇의 지식 가져오기 및 매칭 비교 (AI RAG Retrieval & Match)
// =========================================================================
async function retrieveKnowledgeForChatbot(userQuery) {
  console.log(`\n🤖 [PART 3] 챗봇의 질문 분석 시작: "${userQuery}"`);

  const extractedKeyword = "대파"; 
  console.log(`- Step 3-A: 백과사전 마스터 테이블을 뒤져 '${extractedKeyword}'의 지식 세트 원샷 로드...`);
  
  const { data: masterData } = await supabase
    .from('coolbox_knowledge_master')
    .select('item_name, short_storage_guide, easy_recipe, nutrition_summary')
    .or(`item_name.eq.${extractedKeyword},aliases.cs.{${extractedKeyword}}`)
    .maybeSingle();

  const standardName = masterData ? masterData.item_name : extractedKeyword;
  console.log(`-> 교정 완료된 표준명: "${standardName}"`);

  // [시나리오 4]: 'coolbox_price_history' 테이블에서 해당 품목의 최근 마트별 평균 가격 동향 수집
  console.log(`- Step 3-B: 가격 변동 테이블(coolbox_price_history)에서 최근 평균/최저가 추이 로드...`);
  const { data: priceStats } = await supabase
    .from('coolbox_price_history')
    .select('price, market_name, purchase_date')
    .eq('standard_item_name', standardName)
    .order('purchase_date', { ascending: false });

  console.log("✅ [PART 3] AI 챗봇이 답변을 생성하기 위한 핵심 Grounding Context 로드 완료.");
  if (masterData) {
    console.log(`>> 캐시된 보관법: ${masterData.short_storage_guide}`);
    console.log(`>> 추천 요리법:\n${masterData.easy_recipe}`);
  }
  if (priceStats && priceStats.length > 0) {
    console.log(`>> 최신 단가 히스토리: ${priceStats[0].market_name}에서 ${priceStats[0].price}원 수집됨.`);
  }
}


// =========================================================================
// 🏁 [백그라운드 제어 실행 메인 루프]
// =========================================================================
async function runPipeline() {
  console.log("=========================================================");
  console.log("🚀 [Coolbox Pipeline] 백그라운드 데이터 연동 파이프라인 작동 개시");
  console.log("=========================================================");

  // 1단계: 미가공 공공데이터 확보
  let hasMoreData = true;

  while (hasMoreData) {
    const rawItems = await fetchRawPublicData();

    if (rawItems.length === 0) {
      console.log("ℹ️ 1만 줄 공공데이터 지식화 및 적재 완수! 파이프라인 대기 중.");
      hasMoreData = false;
    } else {
      // 2단계: 품목별로 순회하며 AI 가공 및 타겟 테이블로 분배/저장 수행
      for (const item of rawItems) {
        await processAndDistributeKnowledge(item);
      }
      // API 과부하 및 속도 제한 방지를 위해 100건 처리 후 2초간 안전 대기
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // 3단계: AI 챗봇 조회 시뮬레이션 가동 확인
  await retrieveKnowledgeForChatbot("어제 산 유기농대파 보관 팁 알려줘");

  console.log("\n=========================================================");
  console.log("🎉 [Coolbox Pipeline] 모든 데이터 연결 및 파이프라인 구동 시뮬레이션 종료!");
  console.log("=========================================================");
}

runPipeline();
