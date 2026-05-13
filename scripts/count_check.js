import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Load .env
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const parts = trimmed.split('=');
      if (parts.length >= 2) {
        process.env[trimmed.split('=')[0].trim()] = parts.slice(1).join('=').trim();
      }
    }
  });
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function checkTables() {
  const t1 = await supabase.from('expert_food_intelligence').select('id', { count: 'exact', head: true });
  console.log('expert_food_intelligence count:', t1.count, 'error:', t1.error);

  const t2 = await supabase.from('coolbox_sync_state').select('*');
  console.log('coolbox_sync_state entries:', t2.data, 'error:', t2.error);

  const t3 = await supabase.from('coolbox_ingredient_aliases').select('id', { count: 'exact', head: true });
  console.log('coolbox_ingredient_aliases count:', t3.count, 'error:', t3.error);

  const t4 = await supabase.from('coolbox_food_knowledge_cache').select('id', { count: 'exact', head: true });
  console.log('coolbox_food_knowledge_cache count:', t4.count, 'error:', t4.error);
}

checkTables();
