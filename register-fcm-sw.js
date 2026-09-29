// ================================================================
// REGISTER FCM SERVICE WORKER — ARVEXA Admin
// ================================================================

(function() {
  'use strict';

  if (!('serviceWorker' in navigator)) {
    console.log('[FCM-SW] Non supporté');
    return;
  }

  window.arvexaFcmRegistration = new Promise((resolve, reject) => {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('firebase-messaging-sw.js', {
        scope: './firebase-cloud-messaging-push-scope'
      })
      .then((registration) => {
        console.log('[FCM-SW] ✅ Enregistré. Scope:', registration.scope);
        resolve(registration);
      })
      .catch((error) => {
        console.error('[FCM-SW] ❌ Erreur:', error);
        reject(error);
      });
    });
  });
})();
