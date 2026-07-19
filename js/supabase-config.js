// Supabase 配置
// 从 Supabase Project Settings -> API 中获取并替换下面的占位符
const SUPABASE_URL = 'https://foasqldyszkabzycnawo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Q1Rhs4-SPbDZZMtjtvTT5A_YF2OubHp';

if (SUPABASE_URL.includes('你的项目') || SUPABASE_ANON_KEY.includes('你的-anon-key')) {
  console.warn('[Supabase] 请先配置 SUPABASE_URL 和 SUPABASE_ANON_KEY');
}

window.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
