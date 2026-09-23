// ================================================================
// API ADMIN — ARVEXA School
// Hébergé sur admin-89.vercel.app
// Auth Firebase + Firestore + FCM
// ================================================================

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;
const requestLog = new Map();

const CLICK_ACTION_URL = 'https://arvexaschool.vercel.app/notifications.html';
const ICON_URL = 'https://arvexaschool.vercel.app/icon.png';

let adminServices = null;

// ────────────────────────────────────────────────────────────────
// INIT FIREBASE ADMIN (une seule fois, robuste, avec diagnostic)
// ────────────────────────────────────────────────────────────────
function getAdminServices() {
  if (adminServices) return adminServices;

  const credentials = process.env.FIREBASE_ADMIN_CREDENTIALS;

  if (!credentials || !credentials.trim()) {
    const err = new Error('firebase_admin_not_configured');
    err.details = 'FIREBASE_ADMIN_CREDENTIALS is missing or empty in Vercel env vars.';
    throw err;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(credentials);
  } catch (parseError) {
    const err = new Error('firebase_admin_invalid_json');
    err.details = 'FIREBASE_ADMIN_CREDENTIALS is not valid JSON: ' + parseError.message;
    throw err;
  }

  if (!serviceAccount.project_id) {
    const err = new Error('firebase_admin_missing_project');
    err.details = 'FIREBASE_ADMIN_CREDENTIALS has no project_id field.';
    throw err;
  }

  if (serviceAccount.project_id !== 'arvexa-fbf10') {
    const err = new Error('firebase_admin_wrong_project');
    err.details =
      'FIREBASE_ADMIN_CREDENTIALS project is "' +
      serviceAccount.project_id +
      '" but expected "arvexa-fbf10".';
    throw err;
  }

  if (!serviceAccount.private_key || serviceAccount.private_key.length < 100) {
    const err = new Error('firebase_admin_invalid_key');
    err.details = 'FIREBASE_ADMIN_CREDENTIALS private_key is invalid or too short.';
    throw err;
  }

  const admin = require('firebase-admin');

  if (!admin.apps.length) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    } catch (initError) {
      const err = new Error('firebase_admin_init_failed');
      err.details = 'admin.initializeApp failed: ' + initError.message;
      throw err;
    }
  }

  adminServices = {
    auth: admin.auth(),
    db: admin.firestore(),
    FieldValue: admin.firestore.FieldValue,
    messaging: admin.messaging(),
    projectId: serviceAccount.project_id
  };

  console.log('[ADMIN] Firebase initialized for project:', serviceAccount.project_id);
  return adminServices;
}

// ────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────
function clientIp(request) {
  return String(
    request.headers['x-forwarded-for'] || request.socket?.remoteAddress || 'unknown'
  )
    .split(',')[0]
    .trim();
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (requestLog.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  requestLog.set(ip, recent);
  return recent.length > MAX_REQUESTS_PER_WINDOW;
}

function jsonError(response, status, error, extra = {}) {
  return response.status(status).json({ success: false, error, ...extra });
}

async function verifyFirebaseToken(request) {
  const authorization = request.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    console.error('[AUTH] No Bearer token provided');
    return null;
  }
  try {
    const { auth } = getAdminServices();
    return await auth.verifyIdToken(match[1]);
  } catch (error) {
    console.error('[AUTH] verifyIdToken failed:', error.message, '| code:', error.code || 'no-code');
    return null;
  }
}

async function requireAdmin(request) {
  const user = await verifyFirebaseToken(request);
  if (!user) throw { status: 401, message: 'Connexion requise.' };

  const { db } = getAdminServices();
  const userDoc = await db.collection('users').doc(user.uid).get();
  const data = userDoc.data();

  if (!data || data.role !== 'admin') {
    throw {
      status: 403,
      message: 'Accès refusé. Réservé aux administrateurs.',
      details: `role check failed for ${user.email} (${user.uid})`
    };
  }

  return { uid: user.uid, email: user.email, data };
}

function isPremiumActive(u) {
  if (!u) return false;
  const active = u.premium === true || u.isUnlocked === true || u.hasDeposited === true;
  if (!active) return false;
  const end =
    u.subscriptionEndDate?.toDate?.() ||
    (u.subscriptionEndDate?.seconds ? new Date(u.subscriptionEndDate.seconds * 1000) : null);
  return !end || end.getTime() > Date.now();
}

function serializeUser(doc) {
  const data = doc.data() || {};
  return {
    uid: doc.id,
    firstName: data.firstName || '',
    lastName: data.lastName || '',
    email: data.email || '',
    establishment: data.establishment || '',
    classId: data.classId || '',
    profilePicture: data.profilePicture || null,
    premium: data.premium || false,
    isUnlocked: data.isUnlocked || false,
    hasDeposited: data.hasDeposited || false,
    subscriptionStatus: data.subscriptionStatus || 'none',
    subscriptionPlan: data.subscriptionPlan || null,
    subscriptionPrice: data.subscriptionPrice || null,
    subscriptionRequestDate: data.subscriptionRequestDate || null,
    subscriptionEndDate: data.subscriptionEndDate || null,
    subscriptionPaymentMethod: data.subscriptionPaymentMethod || null,
    accountStatus: data.accountStatus || 'active',
    role: data.role || 'student',
    totalStudyTime: data.totalStudyTime || 0,
    createdAt: data.createdAt || null,
    lastLogin: data.lastLogin || null,
    hasFcmToken: Boolean(data.fcmToken)
  };
}

// ────────────────────────────────────────────────────────────────
// FCM — ENVOI PUSH
// ────────────────────────────────────────────────────────────────
async function sendPushToUsers(tokens, { title, body, type }) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return { successCount: 0, failureCount: 0, invalidTokens: [] };
  }

  const { messaging } = getAdminServices();
  const invalidTokens = [];
  let successCount = 0;
  let failureCount = 0;

  const CHUNK_SIZE = 500;

  for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
    const chunk = tokens.slice(i, i + CHUNK_SIZE);

    let response;
    try {
      response = await messaging.sendEachForMulticast({
        tokens: chunk,
        // ⚡ PAS de bloc "notification" → FCM n'affiche rien automatiquement
        // C'est firebase-messaging-sw.js qui affiche manuellement
        data: {
          title: title,
          body: body,
          click_action: 'notifications.html',
          type: type || 'info'
        },
        webpush: {
          fcmOptions: { link: CLICK_ACTION_URL },
          // ⚡ headers utiles pour iOS
          headers: {
            Urgency: 'high',
            TTL: '86400'
          }
        }
      });
    } catch (error) {
      console.error('FCM send error:', error.message);
      failureCount += chunk.length;
      continue;
    }

    successCount += response.successCount;
    failureCount += response.failureCount;

    response.responses.forEach((res, idx) => {
      if (!res.success) {
        const code = res.error?.code || '';
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument'
        ) {
          invalidTokens.push(chunk[idx]);
        }
      }
    });
  }

  return { successCount, failureCount, invalidTokens };
}

// ────────────────────────────────────────────────────────────────
// ACTIONS
// ────────────────────────────────────────────────────────────────
async function checkAdmin() {
  return { ok: true };
}

async function getDashboard() {
  const { db } = getAdminServices();
  const usersSnap = await db.collection('users').get();
  const users = usersSnap.docs.map(serializeUser);

  const totalUsers = users.length;
  const premiumUsers = users.filter((u) => isPremiumActive(u)).length;
  const pendingRequests = users.filter((u) => u.subscriptionStatus === 'pending');
  const pendingSubscriptions = pendingRequests.length;
  const blockedUsers = users.filter((u) => u.accountStatus === 'blocked').length;

  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const newThisWeek = users.filter((u) => {
    const created =
      u.createdAt?.toDate?.() ||
      (u.createdAt?.seconds ? new Date(u.createdAt.seconds * 1000) : null);
    return created && created.getTime() > oneWeekAgo;
  }).length;

  return {
    stats: {
      totalUsers,
      premiumUsers,
      pendingSubscriptions,
      blockedUsers,
      newThisWeek
    },
    pendingRequests: pendingRequests.slice(0, 10)
  };
}

async function getSubscriptions() {
  const { db } = getAdminServices();
  const snap = await db.collection('users').orderBy('createdAt', 'desc').limit(500).get();
  return { users: snap.docs.map(serializeUser) };
}

async function getUsers({ page = 0, pageSize = 20, sort = 'recent' }) {
  const { db } = getAdminServices();
  let query = db.collection('users');

  if (sort === 'name') {
    const snap = await query.limit(500).get();
    const users = snap.docs.map(serializeUser);
    users.sort((a, b) => {
      const na = `${a.firstName} ${a.lastName}`.toLowerCase();
      const nb = `${b.firstName} ${b.lastName}`.toLowerCase();
      return na.localeCompare(nb);
    });
    const start = page * pageSize;
    return { users: users.slice(start, start + pageSize) };
  }

  if (sort === 'email') {
    const snap = await query.limit(500).get();
    const users = snap.docs.map(serializeUser);
    users.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
    const start = page * pageSize;
    return { users: users.slice(start, start + pageSize) };
  }

  const snap = await query
    .orderBy('createdAt', 'desc')
    .offset(page * pageSize)
    .limit(pageSize)
    .get();

  return { users: snap.docs.map(serializeUser) };
}

async function approveSubscription({ uid }) {
  const { db, FieldValue } = getAdminServices();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw { status: 404, message: 'Utilisateur introuvable.' };

  const data = userSnap.data();
  const plan = data.subscriptionPlan || 'monthly';

  // Calculer la date de fin
  const now = new Date();
  const endDate = new Date(now);
  if (plan === 'annual') endDate.setFullYear(endDate.getFullYear() + 1);
  else endDate.setMonth(endDate.getMonth() + 1);

  // Mettre à jour le profil
  await userRef.update({
    premium: true,
    isUnlocked: true,
    hasDeposited: true,
    subscriptionStatus: 'active',
    subscriptionStartDate: FieldValue.serverTimestamp(),
    subscriptionEndDate: endDate,
    updatedAt: FieldValue.serverTimestamp()
  });

  // Contenu de la notification
  const notifTitle = '🎉 Premium activé !';
  const notifBody = `Ton abonnement ${plan === 'annual' ? 'annuel' : 'mensuel'} a été activé. Tu as maintenant accès à tous les contenus.`;

  // 1) Notif in-app (Firestore)
  await db.collection('users').doc(uid).collection('notifications').add({
    title: notifTitle,
    body: notifBody,
    type: 'success',
    read: false,
    createdAt: FieldValue.serverTimestamp()
  });

  // 2) Notif push FCM (si l'utilisateur a un token)
  let pushSent = 0;
  let pushFailed = 0;

 // ⚡ Récupérer TOUS les tokens
let userTokens = Array.isArray(data.fcmTokens) ? data.fcmTokens : [];
if (userTokens.length === 0 && typeof data.fcmToken === 'string' && data.fcmToken.length > 20) {
  userTokens = [data.fcmToken];
}

if (userTokens.length > 0) {
  const pushResult = await sendPushToUsers(userTokens, {
    title: notifTitle,
    body: notifBody,
    type: 'success'
  });

  pushSent = pushResult.successCount;
  pushFailed = pushResult.failureCount;

  // Nettoyage : retirer les tokens invalides du tableau
  if (pushResult.invalidTokens.length > 0) {
    const invalidSet = new Set(pushResult.invalidTokens);
    const cleanedTokens = userTokens.filter((t) => !invalidSet.has(t));
    try {
      await userRef.update({ fcmTokens: cleanedTokens });
    } catch (e) {
      console.warn('Token cleanup failed:', e.message);
    }
  }
}
  
      pushSent = pushResult.successCount;
      pushFailed = pushResult.failureCount;

      // Nettoyage si le token est invalide
      if (pushResult.invalidTokens.length > 0) {
        try {
          await userRef.update({ fcmToken: FieldValue.delete() });
        } catch (e) {
          console.warn('Token cleanup failed:', e.message);
        }
      }
    } catch (error) {
      console.error('Push FCM failed for approval:', error.message);
      pushFailed = 1;
    }
  }

  return { ok: true, pushSent, pushFailed };
}

async function rejectSubscription({ uid }) {
  const { db, FieldValue } = getAdminServices();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw { status: 404, message: 'Utilisateur introuvable.' };

  await userRef.update({
    subscriptionStatus: 'rejected',
    updatedAt: FieldValue.serverTimestamp()
  });

  await db.collection('users').doc(uid).collection('notifications').add({
    title: '❌ Demande refusée',
    body: "Ta demande d'abonnement n'a pas pu être validée. Contacte le support.",
    type: 'error',
    read: false,
    createdAt: FieldValue.serverTimestamp()
  });

  return { ok: true };
}

async function revokePremium({ uid }) {
  const { db, FieldValue } = getAdminServices();
  const userRef = db.collection('users').doc(uid);

  await userRef.update({
    premium: false,
    isUnlocked: false,
    hasDeposited: false,
    subscriptionStatus: 'expired',
    updatedAt: FieldValue.serverTimestamp()
  });

  await db.collection('users').doc(uid).collection('notifications').add({
    title: '⚠️ Abonnement révoqué',
    body: "Ton accès Premium a été suspendu.",
    type: 'warning',
    read: false,
    createdAt: FieldValue.serverTimestamp()
  });

  return { ok: true };
}

async function toggleBlockUser({ uid }) {
  const { db, FieldValue } = getAdminServices();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw { status: 404, message: 'Utilisateur introuvable.' };

  const data = userSnap.data();
  if (data.role === 'admin') throw { status: 403, message: 'Impossible de bloquer un admin.' };

  const isBlocked = data.accountStatus === 'blocked';
  await userRef.update({
    accountStatus: isBlocked ? 'active' : 'blocked',
    updatedAt: FieldValue.serverTimestamp()
  });

  return { ok: true, blocked: !isBlocked };
}

async function deleteUser({ uid }) {
  const { db, auth } = getAdminServices();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw { status: 404, message: 'Utilisateur introuvable.' };

  const data = userSnap.data();
  if (data.role === 'admin') throw { status: 403, message: 'Impossible de supprimer un admin.' };

  await userRef.delete();

  try {
    await auth.deleteUser(uid);
  } catch (e) {
    console.warn('Auth delete failed:', e.message);
  }

  return { ok: true };
}

async function sendNotification({ target, email, title, message, type }) {
  const { db, FieldValue } = getAdminServices();

  if (!title || !message) throw { status: 400, message: 'Titre et message requis.' };
  if (title.length > 120) throw { status: 400, message: 'Titre trop long.' };
  if (message.length > 1000) throw { status: 400, message: 'Message trop long.' };

  let usersSnap;

  if (target === 'specific') {
    if (!email) throw { status: 400, message: 'Email requis.' };
    usersSnap = await db
      .collection('users')
      .where('email', '==', String(email).toLowerCase().trim())
      .limit(1)
      .get();
    if (usersSnap.empty) throw { status: 404, message: 'Utilisateur introuvable.' };
  } else {
    usersSnap = await db.collection('users').get();
  }

  let docs = usersSnap.docs;
  if (target === 'free') docs = docs.filter((d) => !isPremiumActive(d.data()));
  if (target === 'premium') docs = docs.filter((d) => isPremiumActive(d.data()));

  if (docs.length === 0) {
    return { ok: true, count: 0, pushSent: 0, pushFailed: 0 };
  }

  const now = FieldValue.serverTimestamp();
  const tokens = [];
  let count = 0;

  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    docs.slice(i, i + 400).forEach((doc) => {
      const notifRef = db.collection('users').doc(doc.id).collection('notifications').doc();
      batch.set(notifRef, {
        title,
        body: message,
        type: type || 'info',
        read: false,
        createdAt: now
      });

    const userData = doc.data();

// ⚡ Nouveau système : tableau fcmTokens
let userTokens = Array.isArray(userData.fcmTokens) ? userData.fcmTokens : [];

// Fallback ancien système
if (userTokens.length === 0 && typeof userData.fcmToken === 'string' && userData.fcmToken.length > 20) {
  userTokens = [userData.fcmToken];
}

// Ajouter chaque token de cet utilisateur
userTokens.forEach((t) => {
  if (typeof t === 'string' && t.length > 20) {
    tokens.push({ token: t, uid: doc.id });
  }
});

      count++;
    });
    await batch.commit();
  }

  let pushSent = 0;
  let pushFailed = 0;

  if (tokens.length > 0) {
    const uniqueTokens = [...new Set(tokens.map((t) => t.token))];
    const pushResult = await sendPushToUsers(uniqueTokens, { title, body: message, type });

    pushSent = pushResult.successCount;
    pushFailed = pushResult.failureCount;

  if (pushResult.invalidTokens.length > 0) {
  const invalidSet = new Set(pushResult.invalidTokens);

  // Grouper par utilisateur
  const tokensByUser = new Map();
  tokens.forEach(({ token, uid }) => {
    if (!tokensByUser.has(uid)) tokensByUser.set(uid, new Set());
    tokensByUser.get(uid).add(token);
  });

  const cleanupBatch = db.batch();
  let hasCleanup = false;

  for (const [uid, userTokenSet] of tokensByUser.entries()) {
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) continue;

    const userData = userSnap.data();
    let userTokens = Array.isArray(userData.fcmTokens) ? userData.fcmTokens : [];

    // Filtrer les tokens invalides
    const cleaned = userTokens.filter((t) => !invalidSet.has(t));

    if (cleaned.length !== userTokens.length) {
      cleanupBatch.update(userRef, { fcmTokens: cleaned });
      hasCleanup = true;
    }
  }

  if (hasCleanup) {
    try { await cleanupBatch.commit(); } catch (e) {
      console.warn('Token cleanup failed:', e.message);
    }
  }
}
    }
  }

  await db.collection('admin_notifications').add({
    title,
    message,
    type: type || 'info',
    target,
    targetLabel: target === 'specific' ? email : target,
    count,
    pushSent,
    pushFailed,
    sentBy: 'admin',
    createdAt: now
  });

  return { ok: true, count, pushSent, pushFailed };
}

async function getNotificationHistory() {
  const { db } = getAdminServices();
  const snap = await db
    .collection('admin_notifications')
    .orderBy('createdAt', 'desc')
    .limit(30)
    .get();
  return {
    history: snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  };
}

async function getAvis() {
  const { db } = getAdminServices();
  const snap = await db.collection('avis').orderBy('createdAt', 'desc').limit(100).get();
  return {
    avis: snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  };
}

async function getStats() {
  const { db } = getAdminServices();
  const usersSnap = await db.collection('users').get();
  const users = usersSnap.docs.map(serializeUser);

  const totalUsers = users.length;
  const premiumUsers = users.filter((u) => isPremiumActive(u)).length;
  const blockedUsers = users.filter((u) => u.accountStatus === 'blocked').length;

  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const newThisWeek = users.filter((u) => {
    const created =
      u.createdAt?.toDate?.() ||
      (u.createdAt?.seconds ? new Date(u.createdAt.seconds * 1000) : null);
    return created && created.getTime() > oneWeekAgo;
  }).length;

  return {
    stats: { totalUsers, premiumUsers, newThisWeek, blockedUsers }
  };
}

// ────────────────────────────────────────────────────────────────
// HANDLER
// ────────────────────────────────────────────────────────────────
module.exports = async function handler(request, response) {
  // CORS basique (même domaine normalement, mais tolérant)
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (request.method === 'OPTIONS') {
    return response.status(204).end();
  }

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return jsonError(response, 405, 'Méthode non autorisée.');
  }

  if (rateLimited(clientIp(request))) {
    return jsonError(response, 429, 'Trop de demandes. Réessaie.');
  }

  // Vérification admin
  let adminContext;
  try {
    adminContext = await requireAdmin(request);
  } catch (e) {
    if (e.status) {
      return jsonError(response, e.status, e.message, e.details ? { details: e.details } : {});
    }
    // Erreur de config Firebase → 503 avec détails
    console.error('[ADMIN] Config error:', e.message, '|', e.details || '');
    return jsonError(response, 503, e.message || 'Service temporairement indisponible.', {
      details: e.details || 'unknown'
    });
  }

  const body = request.body && typeof request.body === 'object' ? request.body : {};
  const action = body.action;

  try {
    switch (action) {
      case 'checkAdmin': return response.status(200).json(await checkAdmin());
      case 'getDashboard': return response.status(200).json(await getDashboard());
      case 'getSubscriptions': return response.status(200).json(await getSubscriptions());
      case 'getUsers': return response.status(200).json(await getUsers(body));
      case 'approveSubscription': return response.status(200).json(await approveSubscription(body));
      case 'rejectSubscription': return response.status(200).json(await rejectSubscription(body));
      case 'revokePremium': return response.status(200).json(await revokePremium(body));
      case 'toggleBlockUser': return response.status(200).json(await toggleBlockUser(body));
      case 'deleteUser': return response.status(200).json(await deleteUser(body));
      case 'sendNotification': return response.status(200).json(await sendNotification(body));
      case 'getNotificationHistory': return response.status(200).json(await getNotificationHistory());
      case 'getAvis': return response.status(200).json(await getAvis());
      case 'getStats': return response.status(200).json(await getStats());
      default:
        return jsonError(response, 400, 'Action inconnue.');
    }
  } catch (error) {
    console.error(`Admin action "${action}" failed:`, error.message);
    if (error.status) return jsonError(response, error.status, error.message);
    return jsonError(response, 500, 'Erreur serveur: ' + error.message);
  }
};
