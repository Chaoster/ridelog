const CACHE_NAME = 'ridelog-pwa-v34';

const PRECACHE_ASSETS = [
  '/index.html',
  '/new-journey.html',
  '/ongoing.html',
  '/my-records.html',
  '/journey-detail.html',
  '/profile.html',
  '/daily-segment.html',
  '/strava-callback.html',
  '/clear-storage.html',
  '/css/style.css',
  '/js/supabase.js',
  '/js/supabase-config.js',
  '/js/login-modal.js',
  '/js/app.js',
  '/js/journey-service.js',
  '/images/icon.png',
  '/images/favicon.png',
  '/images/logo.png'
];

const EXTERNAL_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

function isSameOrigin(request) {
  try {
    return new URL(request.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

function isApiRequest(request) {
  try {
    const url = new URL(request.url);
    return url.hostname.includes('supabase.co') ||
           url.pathname.includes('/rest/v1/') ||
           url.pathname.includes('/auth/v1/');
  } catch {
    return false;
  }
}

function isExternalAsset(request) {
  try {
    return EXTERNAL_ASSETS.some(url => request.url.startsWith(url));
  } catch {
    return false;
  }
}

function isUncacheableAsset(request) {
  try {
    const url = new URL(request.url);
    return url.pathname === '/service-worker.js' || url.pathname === '/manifest.json';
  } catch {
    return false;
  }
}

function normalizeCacheKey(request) {
  try {
    const url = new URL(request.url);
    if (isSameOrigin(request) && !url.pathname.endsWith('.html')) {
      url.search = '';
    }
    return url.href;
  } catch {
    return request.url;
  }
}

function createOfflineResponse() {
  return new Response('离线状态，无法加载该资源', {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

async function cacheFirst(request) {
  const cacheKey = normalizeCacheKey(request);
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(cacheKey, response.clone());
    }
    return response || createOfflineResponse();
  } catch (error) {
    console.error('[SW] cacheFirst failed:', request.url, error);
    return createOfflineResponse();
  }
}

async function networkFirstWithCacheFallback(request) {
  const cacheKey = normalizeCacheKey(request);
  const cache = await caches.open(CACHE_NAME);

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && (networkResponse.ok || networkResponse.status === 308)) {
      cache.put(cacheKey, networkResponse.clone());
    }
    return networkResponse || await cache.match(cacheKey) || createOfflineResponse();
  } catch (error) {
    console.error('[SW] networkFirst failed:', request.url, error);
    const cached = await cache.match(cacheKey);
    return cached || createOfflineResponse();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse || cached || createOfflineResponse();
  } catch (error) {
    console.error('[SW] staleWhileRevalidate failed:', request.url, error);
    return cached || createOfflineResponse();
  }
}

async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch (error) {
    console.error('[SW] networkOnly failed:', request.url, error);
    return createOfflineResponse();
  }
}

self.addEventListener('install', event => {
  console.log('[SW] installing');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => {
        console.error('[SW] install failed:', err);
        throw err;
      })
  );
});

self.addEventListener('activate', event => {
  console.log('[SW] activating');
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

  // Skip non-http requests (e.g. chrome-extension, data URLs)
  if (!request.url.startsWith('http')) return;

  if (isApiRequest(request)) {
    event.respondWith(networkOnly(request));
    return;
  }

  // Let the browser fetch SW/manifest directly so updates always propagate
  if (isUncacheableAsset(request)) {
    return;
  }

  if (isExternalAsset(request)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (isSameOrigin(request)) {
    // Navigation requests (HTML pages): prefer network to avoid stale state
    if (request.mode === 'navigate' || request.destination === 'document') {
      event.respondWith(networkFirstWithCacheFallback(request));
      return;
    }
    // Static assets: prefer cache for offline speed
    event.respondWith(cacheFirst(request));
    return;
  }
});
