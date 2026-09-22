// ================================================================
// API ADMIN — ARVEXA School
// Hébergé côté admin-89.vercel.app
// Vérification stricte du rôle admin côté serveur
// Actions : notifications (Firestore + FCM), gestion utilisateurs
// ================================================================

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;
const requestLog = new Map();

const CLICK_ACTION_URL = 'https://arvexaschool.vercel.app/notifications.html';
const ICON_URL = 'https://arvexaschool.vercel.app/icon.png';

let adminServices;

function getAdminServices() {
  if (adminServices) return adminServices;

  const credentials = process.env.FIREBASE_ADMIN_CREDENTIALS;

  if (!credentials) {
    console.error('[ADMIN DEBUG] FIREBASE_ADMIN_CREDENTIALS is missing or empty.');
    throw new Error('firebase_admin_not_configured');
  }

  console.error('[ADMIN DEBUG] Credentials length:', credentials.length);
  console.error('[ADMIN DEBUG] Starts with:', credentials.slice(0, 40));
  console.error('[ADMIN DEBUG] Ends with:', credentials.slice(-40));

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(credentials);
  } catch (parseError) {
    console.error('[ADMIN DEBUG] JSON.parse failed:', parseError.message);
    throw new Error('firebase_admin_invalid_json');
  }

  console.error('[ADMIN DEBUG] service_account project_id:', serviceAccount.project_id);
  console.error('[ADMIN DEBUG] service_account client_email:', serviceAccount.client_email);
  console.error('[ADMIN DEBUG] private_key length:', (serviceAccount.private_key || '').length);

  const admin = require('firebase-admin');

  if (!admin.apps.length) {
    try {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } catch (initError) {
      console.error('[ADMIN DEBUG] initializeApp failed:', initError.message);
      throw initError;
    }
  }

  adminServices = {
    auth: admin.auth(),
    db: admin.firestore(),
    FieldValue: admin.firestore.FieldValue,
    messaging: admin.messaging()
  };
  return adminServices;
}

function clientIp(request) {
  return String(
    request.headers['x-forwarded-for'] || request.socket?.remoteAddress || 'unknown'
  )
    .split(',')[0]
    .trim();
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (requestLog.get(ip) || []).filter((time) => now - time < WINDOW_MS);
  recent.push(now);
  requestLog.set(ip, recent);
  return recent.length > MAX_REQUESTS_PER_WINDOW;
}

function jsonError(response, status, error) {
  return response.status(status).json({ success: false, error });
}

async function verifyFirebaseToken(request) {
  const authorization = request.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    console.error('[AUTH DEBUG] No Bearer token in Authorization header.');
    return null;
  }
  try {
    const { auth } = getAdminServices();
    return await auth.verifyIdToken(match[1]);
  } catch (error) {
    console.error('[AUTH DEBUG] verifyIdToken failed:', error.message);
    console.error('[AUTH DEBUG] error.code:', error.code || 'no-code');
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
    throw { status: 403, message: 'Accès refusé. Réservé aux administrateurs.' };
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
    lastLogin: data.lastLogin || null
  };
}

// ────────────────────────────────────────────────────────────────
// FCM — Envoi push
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
        notification: { title, body },
        data: {
          click_action: 'notifications.html',
          type: type || 'info'
        },
        webpush: {
          fcmOptions: { link: CLICK_ACTION_URL },
          notification: {
            icon: ICON_URL,
            badge: ICON_URL
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

  const now = new Date();
  const endDate = new Date(now);
  if (plan === 'annual') endDate.setFullYear(endDate.getFullYear() + 1);
  else endDate.setMonth(endDate.getMonth() + 1);

  await userRef.update({
    premium: true,
    isUnlocked: true,
    hasDeposited: true,
    subscriptionStatus: 'active',
    subscriptionStartDate: FieldValue.serverTimestamp(),
    subscriptionEndDate: endDate,
    updatedAt: FieldValue.serverTimestamp()
  });

  await db.collection('users').doc(uid).collection('notifications').add({
    title: '🎉 Premium activé !',
    body: `Ton abonnement ${plan === 'annual' ? 'annuel' : 'mensuel'} a été activé. Tu as maintenant accès à tous les contenus.`,
    type: 'success',
    read: false,
    createdAt: FieldValue.serverTimestamp()
  });

  return { ok: true };
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
    body: "Ta demande d'abonnement n'a pas pu être validée. Contacte le support pour plus d'informations.",
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
    body: "Ton accès Premium a été suspendu. Contacte le support si tu penses qu'il s'agit d'une erreur.",
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

// ────────────────────────────────────────────────────────────────
// NOTIFICATIONS — Firestore + FCM
// ────────────────────────────────────────────────────────────────
async function sendNotification({ target, email, title, message, type }) {
  const { db, FieldValue } = getAdminServices();

  if (!title || !message) throw { status: 400, message: 'Titre et message requis.' };
  if (title.length > 120) throw { status: 400, message: 'Titre trop long.' };
  if (message.length > 1000) throw { status: 400, message: 'Message trop long.' };

  // 1) Résoudre les cibles
  let usersSnap;
  if (target === 'specific') {
    if (!email) throw { status: 400, message: 'Email requis.' };
    usersSnap = await db
      .collection('users')
      .where('email', '==', String(email).toLowerCase().trim())
      .limit(1)
      .get();
    if (usersSnap.empty) throw { status: 404, message: 'Utilisateur introuvable.' };
  } else if (target === 'premium') {
    usersSnap = await db.collection('users').where('premium', '==', true).get();
  } else {
    usersSnap = await db.collection('users').get();
  }

  // 2) Filtre côté serveur
  let docs = usersSnap.docs;
  if (target === 'free') {
    docs = docs.filter((doc) => !isPremiumActive(doc.data()));
  }
  if (target === 'premium') {
    docs = docs.filter((doc) => isPremiumActive(doc.data()));
  }

  if (docs.length === 0) {
    return { ok: true, count: 0, pushSent: 0, pushFailed: 0 };
  }

  // 3) Écriture in-app (Firestore) + collecte des tokens
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

      const token = doc.data().fcmToken;
      if (typeof token === 'string' && token.length > 20) {
        tokens.push({ token, uid: doc.id });
      }

      count++;
    });
    await batch.commit();
  }

  // 4) Envoi push FCM
  let pushSent = 0;
  let pushFailed = 0;

  if (tokens.length > 0) {
    const uniqueTokens = [...new Set(tokens.map((t) => t.token))];
    const pushResult = await sendPushToUsers(uniqueTokens, { title, body: message, type });

    pushSent = pushResult.successCount;
    pushFailed = pushResult.failureCount;

    // 5) Nettoyage des tokens invalides
    if (pushResult.invalidTokens.length > 0) {
      const invalidSet = new Set(pushResult.invalidTokens);
      const cleanupBatch = db.batch();
      let hasCleanup = false;

      tokens.forEach(({ token, uid }) => {
        if (invalidSet.has(token)) {
          cleanupBatch.update(db.collection('users').doc(uid), {
            fcmToken: FieldValue.delete()
          });
          hasCleanup = true;
        }
      });

      if (hasCleanup) {
        try {
          await cleanupBatch.commit();
        } catch (e) {
          console.warn('Token cleanup failed:', e.message);
        }
      }
    }
  }

  // 6) Historique admin
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
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return jsonError(response, 405, 'Méthode non autorisée.');
  }
  if (rateLimited(clientIp(request))) {
    return jsonError(response, 429, 'Trop de demandes. Réessaie.');
  }

  let adminContext;
  try {
    adminContext = await requireAdmin(request);
  } catch (e) {
    if (e.status) return jsonError(response, e.status, e.message);
    console.error('Admin auth error:', e.message);
    return jsonError(response, 503, 'Service temporairement indisponible.');
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
    return jsonError(response, 500, 'Erreur serveur.');
  }
};
