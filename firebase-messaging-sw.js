// ================================================================
// FIREBASE MESSAGING SERVICE WORKER — ARVEXA Admin
// ================================================================

importScripts('https://www.gstatic.com/firebasejs/12.12.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.12.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDHscOXw3rLuhV6z1Cny-bdYCumqpnG7QE",
  authDomain: "arvexa-fbf10.firebaseapp.com",
  projectId: "arvexa-fbf10",
  storageBucket: "arvexa-fbf10.firebasestorage.app",
  messagingSenderId: "920108330053",
  appId: "1:920108330053:web:f532d71cbc2c824bc7472c"
});

const messaging = firebase.messaging();

function getSafeNotificationUrl(value) {
  const fallback = new URL('admin.html', self.location.origin).href;
  if (typeof value !== 'string' || !value) return fallback;
  try {
    const candidate = new URL(value, self.location.origin);
    if (candidate.origin !== self.location.origin) return fallback;
    return candidate.href;
  } catch (error) {
    return fallback;
  }
}

messaging.onBackgroundMessage((payload) => {
  console.log('[FCM-Admin-SW] Message reçu:', payload);

  const notificationTitle =
    payload.data?.title ||
    payload.notification?.title ||
    'ARVEXA Admin';

  const notificationBody =
    payload.data?.body ||
    payload.notification?.body ||
    '';

  const clickAction = getSafeNotificationUrl(
    payload.data?.click_action ||
    payload.notification?.click_action ||
    payload.fcmOptions?.link
  );

  const notificationOptions = {
    body: notificationBody,
    icon: 'https://arvexaschool.vercel.app/icon.png',
    badge: 'https://arvexaschool.vercel.app/icon.png',
    vibrate: [200, 100, 200],
    tag: 'arvexa-admin-notif-' + Date.now(),
    renotify: true,
    requireInteraction: false,
    data: {
      url: clickAction,
      timestamp: Date.now(),
      kind: payload.data?.kind || 'generic'
    }
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url || 'admin.html';
  const kind = event.notification.data?.kind;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          if ('navigate' in client) {
            client.navigate(kind === 'subscription_request' ? 'admin.html#subscriptions' : url);
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(kind === 'subscription_request' ? 'admin.html#subscriptions' : url);
      }
    })
  );
});

console.log('[FCM-Admin-SW] Chargé.');
