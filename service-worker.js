// ================================================================
// Service Worker — ARVEXA Admin
// ================================================================
const CACHE = 'arvexa-admin-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  
  // Ne pas intercepter : POST, API, externe
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  
  // Network-first
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
