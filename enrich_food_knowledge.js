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

반드시 하단에 지정된 순수 JSON 포맷으로만 응답해 주세요. 다른 수식어나 마크다운 코드 없이 JSON 객체 그 자체만 출력해야 합니다.
{
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
    // 📥 2-A. coolbox_ingredient_aliases (별칭 사전) 테이블 적재
    // ---------------------------------------------------------------------
    console.log(`- 2-A단계: '${item_name}'의 별칭 사전(Aliases) ${parsedData.aliases.length}건 적재 중...`);
    
    // 유니크 매핑을 위해 기본명과 AI 추출 별칭 리스트 합산 및 공백 제거
    const uniqueAliases = Array.from(new Set([item_name, ...parsedData.aliases]))
      .map(name => name.trim())
      .filter(Boolean);

    const aliasPayloads = uniqueAliases.map(alias => ({
      alias_name: alias,
      standard_item_name: item_name,
      category_id: category_id
    }));

    const { error: aliasErr } = await supabase
      .from('coolbox_ingredient_aliases')
      .upsert(aliasPayloads, { onConflict: 'alias_name' });

    if (aliasErr) {
      console.error(`❌ [2-A] 별칭 적재 에러:`, aliasErr.message);
    }

    // ---------------------------------------------------------------------
    // 📥 2-B. coolbox_food_knowledge_cache (푸드 널리지 캐시) 테이블 적재
    // ---------------------------------------------------------------------
    console.log(`- 2-B단계: '${item_name}'의 RAG 지식 데이터 캐싱 적재 중...`);

    const cachePayload = {
      ingredient_name: item_name,
      short_storage_guide: parsedData.enriched_knowledge.short_storage_guide,
      easy_recipe: parsedData.enriched_knowledge.easy_recipe,
      nutrition_summary: parsedData.enriched_knowledge.nutrition_summary,
      raw_source_id: id,
      updated_at: new Date().toISOString()
    };

    const { error: cacheErr } = await supabase
      .from('coolbox_food_knowledge_cache')
      .upsert(cachePayload, { onConflict: 'ingredient_name' });

    if (cacheErr) {
      console.error(`❌ [2-B] 지식 캐시 적재 에러:`, cacheErr.message);
    } else {
      console.log(`✅ [PART 2] '${item_name}'의 지식 파티셔닝 적재 및 캐싱 완수.`);
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
  
  const aliasPayloads = mockAliases.map(alias => ({
    alias_name: alias,
    standard_item_name: item_name,
    category_id: category_id
  }));

  await supabase.from('coolbox_ingredient_aliases').upsert(aliasPayloads, { onConflict: 'alias_name' });
  
  await supabase.from('coolbox_food_knowledge_cache').upsert({
    ingredient_name: item_name,
    short_storage_guide: `${item_name}은(는) 신선 보관해야 합니다.`,
    easy_recipe: `1. 흐르는 물에 깨끗이 세척하기\n2. 조리 마지막 단계에 넣기`,
    nutrition_summary: `풍부한 무기질과 식이섬유를 포함하고 있어 식단 밸런스에 훌륭합니다.`,
    raw_source_id: id,
    updated_at: new Date().toISOString()
  }, { onConflict: 'ingredient_name' });

  await updateLastId(id);
  console.log(`✅ [PART 2-폴백] '${item_name}' 모크 데이터 생성 및 동기화 인덱스 업데이트 완료.`);
}


// =========================================================================
// 🤖 PART 3. AI 챗봇의 지식 가져오기 및 매칭 비교 (AI RAG Retrieval & Match)
// =========================================================================
async function retrieveKnowledgeForChatbot(userQuery) {
  console.log(`\n🤖 [PART 3] 챗봇의 질문 분석 시작: "${userQuery}"`);

  const extractedKeyword = "대파"; 
  console.log(`- Step 3-A: 별칭 사전을 뒤져 '${extractedKeyword}'의 표준 식재료명 교정 조회...`);
  
  const { data: aliasMatch } = await supabase
    .from('coolbox_ingredient_aliases')
    .select('standard_item_name')
    .eq('alias_name', extractedKeyword)
    .maybeSingle();

  const standardName = aliasMatch ? aliasMatch.standard_item_name : extractedKeyword;
  console.log(`-> 교정 완료된 표준명: "${standardName}"`);

  console.log(`- Step 3-B: 널리지 캐시에서 '${standardName}'의 RAG 지식 보관 세트 초고속 로드...`);
  const { data: cachedKnowledge } = await supabase
    .from('coolbox_food_knowledge_cache')
    .select('short_storage_guide, easy_recipe, nutrition_summary')
    .eq('ingredient_name', standardName)
    .maybeSingle();

  // [시나리오 4]: 'coolbox_price_history' 테이블에서 해당 품목의 최근 마트별 평균 가격 동향 수집
  console.log(`- Step 3-C: 가격 변동 테이블(coolbox_price_history)에서 최근 평균/최저가 추이 로드...`);
  const { data: priceStats } = await supabase
    .from('coolbox_price_history')
    .select('price, market_name, purchase_date')
    .eq('standard_item_name', standardName)
    .order('purchase_date', { ascending: false });

  console.log("✅ [PART 3] AI 챗봇이 답변을 생성하기 위한 핵심 Grounding Context 로드 완료.");
  if (cachedKnowledge) {
    console.log(`>> 캐시된 보관법: ${cachedKnowledge.short_storage_guide}`);
    console.log(`>> 추천 요리법:\n${cachedKnowledge.easy_recipe}`);
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
