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

const STRAVA_CLIENT_ID = isLocalhost
  ? '267602'   // 本地测试 Strava App
  : '252161';  // 线上生产 Strava App

console.log('[Supabase] 当前连接:', isLocalhost ? '本地环境' : '线上环境', SUPABASE_URL);

window.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 全局缓存当前登录用户，避免首页等页面重复调用 auth.getUser()
window.getCachedUser = (function () {
  let promise = null;
  return async function () {
    if (window.currentUser !== undefined) return window.currentUser;
    if (promise) return promise;
    promise = supabaseClient.auth.getUser().then(({ data, error }) => {
      window.currentUser = error || !data.user ? null : data.user;
      return window.currentUser;
    });
    return promise;
  };
})();

// 当认证状态变化时，重置缓存
window.supabaseClient.auth.onAuthStateChange((event, session) => {
  window.currentUser = session?.user || null;
});
