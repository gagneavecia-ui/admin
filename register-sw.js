// ================================================================
// REGISTER SW — ARVEXA Admin
// ================================================================

(function () {
  'use strict';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('service-worker.js', { scope: './', updateViaCache: 'none' })
        .then((reg) => console.log('[Admin SW] Enregistré:', reg.scope))
        .catch((err) => console.error('[Admin SW] Erreur:', err));
    });
  }

  window.addEventListener('online', () => console.log('[Admin SW] En ligne'));
  window.addEventListener('offline', () => console.log('[Admin SW] Hors ligne'));
})();
