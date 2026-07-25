const CACHE_NAME = 'ridelog-v1';

const PRECACHE_ASSETS = [
  './index.html',
  './new-journey.html',
  './ongoing.html',
  './my-records.html',
  './journey-detail.html',
  './profile.html',
  './daily-segment.html',
  './strava-callback.html',
  './clear-storage.html',
  './css/style.css',
  './js/supabase.js',
  './js/supabase-config.js',
  './js/login-modal.js',
  './js/app.js',
  './js/journey-service.js',
  './images/icon.png',
  './images/favicon.png',
  './images/logo.png'
];

const EXTERNAL_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

function isSameOrigin(request) {
  return new URL(request.url).origin === self.location.origin;
}

function isApiRequest(request) {
  const url = new URL(request.url);
  return url.hostname.includes('supabase.co') ||
         url.pathname.includes('/rest/v1/') ||
         url.pathname.includes('/auth/v1/');
}

function normalizeCacheKey(request) {
  const url = new URL(request.url);
  if (isSameOrigin(request) && !url.pathname.endsWith('.html')) {
    url.search = '';
  }
  return url.href;
}

async function cacheFirst(request) {
  const cacheKey = normalizeCacheKey(request);
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(cacheKey, response.clone());
    }
    return response;
  } catch (error) {
    return new Response('离线状态，无法加载该资源', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => cached);

  return cached || fetchPromise;
}

async function networkOnly(request) {
  return fetch(request);
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (isApiRequest(request)) {
    event.respondWith(networkOnly(request));
    return;
  }

  if (EXTERNAL_ASSETS.includes(request.url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (isSameOrigin(request)) {
    event.respondWith(cacheFirst(request));
    return;
  }
});
