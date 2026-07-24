// Supabase 配置
// 本地开发时自动连接本地 Supabase，线上环境连接生产 Supabase
const isLocalhost = window.location.hostname === 'localhost' ||
                    window.location.hostname === '127.0.0.1';

const SUPABASE_URL = isLocalhost
  ? 'http://127.0.0.1:54321'
  : 'https://foasqldyszkabzycnawo.supabase.co';

const SUPABASE_ANON_KEY = isLocalhost
  ? 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'
  : 'sb_publishable_Q1Rhs4-SPbDZZMtjtvTT5A_YF2OubHp';

console.log('[Supabase] 当前连接:', isLocalhost ? '本地环境' : '线上环境', SUPABASE_URL);

window.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
