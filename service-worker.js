// ================================================================
// SERVICE WORKER — ARVEXA Admin PWA
// Version : 1.0.0
// ================================================================

const CACHE_VERSION = 'arvexa-admin-v1.0.0';
const CACHE_SHELL = 'arvexa-admin-shell-v1';
const CACHE_IMAGES = 'arvexa-admin-images-v1';
const ALL_CACHES = [CACHE_SHELL, CACHE_IMAGES];

const PRECACHE = [
  './',
  './index.html',
  './admin.html',
  './manifest.json',
  './icon-admin-192.png',
  './icon-admin-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_SHELL).then((cache) =>
      Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.map((n) => !ALL_CACHES.includes(n) ? caches.delete(n) : null))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // Ne jamais toucher Firebase / API / CDN externes
  if (url.hostname.includes('firebase') ||
      url.hostname.includes('gstatic') ||
      url.hostname.includes('googleapis') ||
      url.hostname.includes('googleusercontent') ||
      url.hostname.includes('cloudflare') ||
      url.hostname.includes('jsdelivr') ||
      url.pathname.startsWith('/api/')) {
    return;
  }

  // HTML : network-first
  if (req.mode === 'navigate' || req.destination === 'document' || url.pathname.endsWith('.html')) {
    event.respondWith(handlePage(req));
    return;
  }

  // Assets : cache-first
  if (req.destination === 'image' || req.destination === 'style' || req.destination === 'script' ||
      /\.(png|jpg|jpeg|svg|webp|gif|ico|woff2?|ttf|otf)$/i.test(url.pathname)) {
    event.respondWith(handleAsset(req));
    return;
  }
});

async function handlePage(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(CACHE_SHELL);
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    const cached = await caches.match(req);
    if (cached) return cached;
    const fallback = await caches.match('./index.html');
    if (fallback) return fallback;
    return new Response(
      '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Hors ligne</title></head><body style="background:#0A0A0A;color:#F5F0E8;font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0;text-align:center"><div><h1>Hors ligne</h1><p>Reconnecte-toi pour accéder à la console.</p></div></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function handleAsset(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(CACHE_IMAGES);
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    return new Response('', { status: 404 });
  }
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'CLEAR_ADMIN_CACHE') {
    event.waitUntil(caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))));
  }
});

console.log('[Admin SW] Service Worker chargé');
