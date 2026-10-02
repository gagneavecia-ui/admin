// ================================================================
// API ADMIN — ARVEXA School v3
// Hébergé sur admin-89.vercel.app
// Auth Firebase + Firestore + FCM + CORS multi-origines
// ================================================================

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;
const requestLog = new Map();

const CLICK_ACTION_URL = 'https://admin-89.vercel.app/admin.html';
const ICON_URL = 'https://arvexaschool.vercel.app/icon.png';

// ⚡ Origines autorisées (public + admin)
const ALLOWED_ORIGINS = [
  'https://arvexaschool.vercel.app',
  'https://admin-89.vercel.app',
  'http://localhost:3000',
  'http://localhost:5000'
];

// ⚡ Admins en dur (fallback si role Firestore manquant)
const ADMIN_EMAILS = ['gagneavecia@gmail.com'];

let adminServices = null;

// ────────────────────────────────────────────────────────────────
// INIT FIREBASE ADMIN
// ────────────────────────────────────────────────────────────────
function getAdminServices() {
  if (adminServices) return adminServices;

  const credentials = process.env.FIREBASE_ADMIN_CREDENTIALS;
  if (!credentials || !credentials.trim()) {
    const err = new Error('firebase_admin_not_configured');
    err.details = 'FIREBASE_ADMIN_CREDENTIALS is missing or empty.';
    throw err;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(credentials);
  } catch (parseError) {
    const err = new Error('firebase_admin_invalid_json');
    err.details = 'Invalid JSON: ' + parseError.message;
    throw err;
  }

  if (!serviceAccount.project_id) {
    const err = new Error('firebase_admin_missing_project');
    err.details = 'No project_id in credentials.';
    throw err;
  }

  if (!serviceAccount.private_key || serviceAccount.private_key.length < 100) {
    const err = new Error('firebase_admin_invalid_key');
    err.details = 'Invalid private_key.';
    throw err;
  }

  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    try {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } catch (initError) {
      const err = new Error('firebase_admin_init_failed');
      err.details = initError.message;
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

  console.log('[ADMIN] Firebase init OK:', serviceAccount.project_id);
  return adminServices;
}

// ────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────
function clientIp(request) {
  return String(request.headers['x-forwarded-for'] || request.socket?.remoteAddress || 'unknown').split(',')[0].trim();
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

function applyCors(request, response) {
  const origin = request.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
  }
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Max-Age', '86400');
}

async function verifyFirebaseToken(request) {
  const authorization = request.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  try {
    const { auth } = getAdminServices();
    return await auth.verifyIdToken(match[1]);
  } catch (error) {
    console.error('[AUTH] verifyIdToken failed:', error.message);
    return null;
  }
}

async function requireAdmin(request) {
  const user = await verifyFirebaseToken(request);
  if (!user) throw { status: 401, message: 'Connexion requise.' };

  const { db } = getAdminServices();
  const userDoc = await db.collection('users').doc(user.uid).get();
  const data = userDoc.data();

  const isAdminByRole = data && data.role === 'admin';
  const isAdminByEmail = ADMIN_EMAILS.includes(user.email);

  if (!isAdminByRole && !isAdminByEmail) {
    throw {
      status: 403,
      message: 'Accès refusé. Réservé aux administrateurs.',
      details: `role check failed for ${user.email}`
    };
  }

  return { uid: user.uid, email: user.email, data: data || {} };
}

function isPremiumActive(u) {
  if (!u) return false;
  const active = u.premium === true || u.isUnlocked === true || u.hasDeposited === true;
  if (!active) return false;
  const end = u.subscriptionEndDate?.toDate?.() ||
    (u.subscriptionEndDate?.seconds ? new Date(u.subscriptionEndDate.seconds * 1000) : null);
  return !end || end.getTime() > Date.now();
}

// ⚡ Convertit un Timestamp Firestore en ISO string
function toISO(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (v._seconds !== undefined) return new Date(v._seconds * 1000).toISOString();
  if (v.seconds !== undefined) return new Date(v.seconds * 1000).toISOString();
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return null;
}

// ────────────────────────────────────────────────────────────────
// ⚡ ANALYTICS — Agrégation des données utilisateurs
// ────────────────────────────────────────────────────────────────
async function getAnalytics({ startTs, endTs, filter = 'all' }) {
  const { db } = getAdminServices();

  const startDate = new Date(startTs || 0).toISOString().slice(0, 10);
  const endDate = new Date(endTs || Date.now()).toISOString().slice(0, 10);

  // ⚡ Liste des emails admin à exclure
  const ADMIN_EMAILS = ['gagneavecia@gmail.com'];

  // 1) Récupérer les utilisateurs (filtrés)
  const usersSnap = await db.collection('users').get();
  let userDocs = usersSnap.docs;

  // ⚡ EXCLURE LES ADMINS
  userDocs = userDocs.filter((d) => {
    const u = d.data();
    if (u.role === 'admin') return false;
    if (u.email && ADMIN_EMAILS.includes(u.email)) return false;
    return true;
  });

  if (filter === 'premium') {
    userDocs = userDocs.filter((d) => isPremiumActive(d.data()));
  } else if (filter === 'free') {
    userDocs = userDocs.filter((d) => !isPremiumActive(d.data()));
  }

  // 2) Structure d'agrégation
  const summary = {
    totalViews: 0,
    totalTime: 0,
    totalSessions: 0,
    uniqueUsers: 0,
    avgTimePerUser: 0,
    mostActiveDay: null,
    mostActiveDayCount: null
  };

  const topPagesMap = {};
  const topFeaturesMap = {};
  const byTimeOfDay = { matin: 0, apresmidi: 0, soir: 0, nuit: 0 };
  const byDayOfWeek = { lundi: 0, mardi: 0, mercredi: 0, jeudi: 0, vendredi: 0, samedi: 0, dimanche: 0 };
  const byDate = {};
  const topUsers = [];

  // 3) Parcourir les utilisateurs en chunks de 10 (parallélisation)
  const chunkSize = 10;
  for (let i = 0; i < userDocs.length; i += chunkSize) {
    const chunk = userDocs.slice(i, i + chunkSize);

    const results = await Promise.all(
      chunk.map(async (userDoc) => {
        try {
          const dailySnap = await db
            .collection('users').doc(userDoc.id)
            .collection('analytics_daily')
            .where('date', '>=', startDate)
            .where('date', '<=', endDate)
            .get();
          return { userDoc, dailyDocs: dailySnap.docs.map((d) => d.data()) };
        } catch (e) {
          return { userDoc, dailyDocs: [] };
        }
      })
    );

    results.forEach(({ userDoc, dailyDocs }) => {
      const userData = userDoc.data();
      let userTime = 0;
      let userViews = 0;
      let userSessions = 0;

      dailyDocs.forEach((daily) => {
        // Pages
        if (daily.pages) {
          Object.entries(daily.pages).forEach(([path, count]) => {
            const p = path.replace(/_/g, '/');
            topPagesMap[p] = (topPagesMap[p] || 0) + count;
            userViews += count;
          });
        }

        // Features
        if (daily.features) {
          Object.entries(daily.features).forEach(([feature, count]) => {
            topFeaturesMap[feature] = (topFeaturesMap[feature] || 0) + count;
          });
        }

        // Time of day
        if (daily.byTimeOfDay) {
          Object.entries(daily.byTimeOfDay).forEach(([k, v]) => {
            byTimeOfDay[k] = (byTimeOfDay[k] || 0) + v;
          });
        }

        // Day of week
        if (daily.byDayOfWeek) {
          Object.entries(daily.byDayOfWeek).forEach(([k, v]) => {
            byDayOfWeek[k] = (byDayOfWeek[k] || 0) + v;
          });
        }

        // Date pour la courbe
        if (daily.date) {
          byDate[daily.date] = (byDate[daily.date] || 0) + (daily.totalTime || 0);
        }

        userTime += daily.totalTime || 0;
        userSessions += daily.sessions || 0;
      });

      if (userTime > 0 || userViews > 0) {
        topUsers.push({
          uid: userDoc.id,
          name: `${userData.firstName || ''} ${userData.lastName || ''}`.trim() || 'Utilisateur',
          email: userData.email || '',
          totalTime: userTime,
          views: userViews,
          sessions: userSessions
        });
        summary.totalTime += userTime;
        summary.totalViews += userViews;
        summary.totalSessions += userSessions;
        summary.uniqueUsers++;
      }
    });
  }

  // 4) Calculs finaux
  if (summary.uniqueUsers > 0) {
    summary.avgTimePerUser = Math.round(summary.totalTime / summary.uniqueUsers);
  }

  // Top pages triées
  const topPages = Object.entries(topPagesMap)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Top features triées
  const topFeatures = Object.entries(topFeaturesMap)
    .map(([feature, count]) => ({ feature, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Top users triés par temps
  topUsers.sort((a, b) => b.totalTime - a.totalTime);

  // Jour le plus actif
  const daysSorted = Object.entries(byDate).sort((a, b) => b[1] - a[1]);
  if (daysSorted.length > 0) {
    summary.mostActiveDay = daysSorted[0][0];
    summary.mostActiveDayCount = Math.round(daysSorted[0][1] / 60) + ' min';
  }

  return {
    success: true,
    summary,
    topPages,
    topFeatures,
    byTimeOfDay,
    byDayOfWeek,
    byDate,
    topUsers: topUsers.slice(0, 20)
  };
}

function serializeUser(doc) {
  const data = doc.data() || {};
  return {
    uid: doc.id,
    id: doc.id,
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
    subscriptionOriginalPrice: data.subscriptionOriginalPrice || null,
    subscriptionPromoCode: data.subscriptionPromoCode || null,
    subscriptionRequestId: data.subscriptionRequestId || null,
    subscriptionFullName: data.subscriptionFullName || null,
    subscriptionWhatsapp: data.subscriptionWhatsapp || null,
    subscriptionPaymentMethod: data.subscriptionPaymentMethod || null,
    subscriptionRequestDate: toISO(data.subscriptionRequestDate),
    subscriptionStartDate: toISO(data.subscriptionStartDate),
    subscriptionEndDate: toISO(data.subscriptionEndDate),
    subscriptionActivatedAt: toISO(data.subscriptionActivatedAt),
    subscriptionRejectedAt: toISO(data.subscriptionRejectedAt),
    createdAt: toISO(data.createdAt),
    updatedAt: toISO(data.updatedAt),
    lastLogin: toISO(data.lastLogin),
    accountStatus: data.accountStatus || 'active',
    role: data.role || 'student',
    totalStudyTime: data.totalStudyTime || 0,
    hasFcmToken: Boolean(data.fcmToken || (Array.isArray(data.fcmTokens) && data.fcmTokens.length > 0))
  };
}

// ⚡ Récupère tous les tokens d'un user
function getUserTokens(data) {
  const tokens = new Set();
  if (Array.isArray(data?.fcmTokens)) {
    data.fcmTokens.forEach((t) => { if (typeof t === 'string' && t.length > 20) tokens.add(t); });
  }
  if (typeof data?.fcmToken === 'string' && data.fcmToken.length > 20) {
    tokens.add(data.fcmToken);
  }
  return Array.from(tokens);
}

// ────────────────────────────────────────────────────────────────
// FCM — ENVOI PUSH
// ────────────────────────────────────────────────────────────────
async function sendPushToUsers(tokens, { title, body, type, data = {} }) {
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
        data: {
          title: title,
          body: body,
          click_action: 'notifications.html',
          type: type || 'info',
          ...data
        },
        webpush: {
          fcmOptions: { link: CLICK_ACTION_URL },
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

// ⚡ NOTIFIE TOUS LES ADMINS (push)
async function notifyAdmins({ title, body, type = 'info', data = {} }) {
  const { db } = getAdminServices();
  const usersSnap = await db.collection('users').get();

  const adminDocs = usersSnap.docs.filter((d) => {
    const u = d.data();
    return u.role === 'admin' || ADMIN_EMAILS.includes(u.email);
  });

  const tokens = [];
  adminDocs.forEach((docSnap) => {
    const u = docSnap.data();
    getUserTokens(u).forEach((t) => tokens.push(t));
  });

  const uniqueTokens = [...new Set(tokens)];
  if (uniqueTokens.length === 0) {
    console.log('[PUSH] Aucun token admin trouvé');
    return { sent: 0, failed: 0 };
  }

  const result = await sendPushToUsers(uniqueTokens, {
    title,
    body,
    type,
    data
  });

  console.log(`[PUSH] Admins notifiés : ${result.successCount}/${uniqueTokens.length}`);
  return { sent: result.successCount, failed: result.failureCount, invalidTokens: result.invalidTokens };
}

// ────────────────────────────────────────────────────────────────
// LOG ACTION
// ────────────────────────────────────────────────────────────────
async function logAction({ action, target = '', details = {}, adminEmail, adminUid }) {
  const { db, FieldValue } = getAdminServices();
  await db.collection('adminLogs').add({
    action,
    target,
    details,
    adminUid,
    adminEmail,
    timestamp: FieldValue.serverTimestamp()
  });
  return { ok: true };
}

// ────────────────────────────────────────────────────────────────
// ACTIONS — DASHBOARD / STATS
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
    const created = u.createdAt ? new Date(u.createdAt).getTime() : null;
    return created && created > oneWeekAgo;
  }).length;

  return {
    stats: { totalUsers, premiumUsers, pendingSubscriptions, blockedUsers, newThisWeek },
    pendingRequests: pendingRequests.slice(0, 10)
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
    const created = u.createdAt ? new Date(u.createdAt).getTime() : null;
    return created && created > oneWeekAgo;
  }).length;

  return { stats: { totalUsers, premiumUsers, newThisWeek, blockedUsers } };
}

// ────────────────────────────────────────────────────────────────
// ⚡ ACTION PUBLIQUE — Notifier les admins d'une demande
// ────────────────────────────────────────────────────────────────
async function notifyNewSubscriptionRequest({ userUid, userName, plan, planLabel, price, requestId }) {
  const title = '💳 Nouvelle demande Premium';
  const body = `${userName || 'Un élève'} — ${planLabel || (plan === 'annual' ? 'Annuel' : 'Mensuel')} · ${Number(price || 0).toLocaleString('fr-FR')} FCFA`;

  const result = await notifyAdmins({
    title,
    body,
    type: 'warning',
    data: {
      kind: 'subscription_request',
      userUid: userUid || '',
      requestId: requestId || ''
    }
  });

  return { ok: true, ...result };
}

// ────────────────────────────────────────────────────────────────
// ⚡ PUSH AUX ADMINS — Nouvelle inscription
// ────────────────────────────────────────────────────────────────
async function notifyNewSignup({ uid, userName, userEmail, establishment }) {
  const title = '🎉 Nouvelle inscription';
  let body = userName || 'Nouvel élève';
  if (establishment) body += ' · ' + establishment;
  if (userEmail && !body.includes(userEmail)) body += ' · ' + userEmail;

  const result = await notifyAdmins({
    title,
    body,
    type: 'success',
    data: {
      kind: 'new_signup',
      userUid: uid || '',
      userEmail: userEmail || ''
    }
  });

  return { ok: true, ...result };
}
 
// ────────────────────────────────────────────────────────────────
// ACTIONS — UTILISATEURS
// ────────────────────────────────────────────────────────────────
async function getSubscriptions() {
  const { db } = getAdminServices();
  const snap = await db.collection('users').orderBy('createdAt', 'desc').limit(500).get();
  return { users: snap.docs.map(serializeUser) };
}

async function getUsers({ page = 0, pageSize = 100, sort = 'recent' }) {
  const { db } = getAdminServices();
  const snap = await db.collection('users').limit(500).get();
  let users = snap.docs.map(serializeUser);

  if (sort === 'name') {
    users.sort((a, b) => {
      const na = `${a.firstName} ${a.lastName}`.toLowerCase();
      const nb = `${b.firstName} ${b.lastName}`.toLowerCase();
      return na.localeCompare(nb);
    });
  } else if (sort === 'email') {
    users.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
  } else {
    users.sort((a, b) => {
      const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const db_ = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return db_ - da;
    });
  }

  const start = page * pageSize;
  return { users: users.slice(start, start + pageSize), total: users.length };
}

async function approveSubscription({ uid }, adminCtx) {
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
    subscriptionActivatedAt: FieldValue.serverTimestamp(),
    subscriptionEndDate: endDate,
    subscriptionActivatedBy: adminCtx?.email || 'admin',
    updatedAt: FieldValue.serverTimestamp()
  });

  const notifTitle = '🎉 Premium activé !';
  const notifBody = `Ton abonnement ${plan === 'annual' ? 'annuel' : 'mensuel'} a été activé. Tu as maintenant accès à tous les contenus.`;

  await db.collection('users').doc(uid).collection('notifications').add({
    title: notifTitle,
    body: notifBody,
    type: 'success',
    read: false,
    createdAt: FieldValue.serverTimestamp()
  });

  let pushSent = 0;
  let pushFailed = 0;
  const tokens = getUserTokens(data);
  if (tokens.length > 0) {
    try {
      const pushResult = await sendPushToUsers(tokens, {
        title: notifTitle,
        body: notifBody,
        type: 'success'
      });
      pushSent = pushResult.successCount;
      pushFailed = pushResult.failureCount;

      if (pushResult.invalidTokens.length > 0) {
        const invalidSet = new Set(pushResult.invalidTokens);
        const remaining = tokens.filter((t) => !invalidSet.has(t));
        await userRef.update({
          fcmTokens: remaining.length > 0 ? remaining : FieldValue.delete(),
          fcmToken: remaining[0] || FieldValue.delete()
        }).catch(() => {});
      }
    } catch (error) {
      console.error('Push FCM failed:', error.message);
      pushFailed = tokens.length;
    }
  }

  await logAction({
    action: 'Activation Premium',
    target: data.email || uid,
    details: { plan, price: data.subscriptionPrice || null },
    adminEmail: adminCtx?.email,
    adminUid: adminCtx?.uid
  });

  return { ok: true, pushSent, pushFailed };
}

async function rejectSubscription({ uid }, adminCtx) {
  const { db, FieldValue } = getAdminServices();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw { status: 404, message: 'Utilisateur introuvable.' };

  const data = userSnap.data();

  await userRef.update({
    subscriptionStatus: 'rejected',
    subscriptionRejectedAt: FieldValue.serverTimestamp(),
    subscriptionRejectedBy: adminCtx?.email || 'admin',
    updatedAt: FieldValue.serverTimestamp()
  });

  await db.collection('users').doc(uid).collection('notifications').add({
    title: '❌ Demande refusée',
    body: "Ta demande d'abonnement n'a pas pu être validée. Contacte le support.",
    type: 'error',
    read: false,
    createdAt: FieldValue.serverTimestamp()
  });

  await logAction({
    action: 'Refus abonnement',
    target: data.email || uid,
    adminEmail: adminCtx?.email,
    adminUid: adminCtx?.uid
  });

  return { ok: true };
}

async function giftPremium({ uid, months = 1 }, adminCtx) {
  const { db, FieldValue } = getAdminServices();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw { status: 404, message: 'Utilisateur introuvable.' };

  const data = userSnap.data();
  const start = new Date();
  const end = new Date(start.getTime() + months * 30 * 24 * 60 * 60 * 1000);

  await userRef.update({
    premium: true,
    isUnlocked: true,
    hasDeposited: true,
    subscriptionStatus: 'active',
    subscriptionStartDate: start,
    subscriptionEndDate: end,
    subscriptionActivatedAt: FieldValue.serverTimestamp(),
    subscriptionActivatedBy: (adminCtx?.email || 'admin') + ' (cadeau)',
    updatedAt: FieldValue.serverTimestamp()
  });

  await db.collection('users').doc(uid).collection('notifications').add({
    title: '🎁 Premium offert !',
    body: `Un administrateur t'a offert ${months} mois de Premium. Profite bien !`,
    type: 'success',
    read: false,
    createdAt: FieldValue.serverTimestamp()
  });

  const tokens = getUserTokens(data);
  let pushSent = 0;
  if (tokens.length > 0) {
    try {
      const r = await sendPushToUsers(tokens, {
        title: '🎁 Premium offert !',
        body: `Un administrateur t'a offert ${months} mois de Premium.`,
        type: 'success'
      });
      pushSent = r.successCount;
    } catch (e) {}
  }

  await logAction({
    action: 'Premium offert',
    target: data.email || uid,
    details: { months },
    adminEmail: adminCtx?.email,
    adminUid: adminCtx?.uid
  });

  return { ok: true, pushSent };
}

async function revokePremium({ uid }, adminCtx) {
  const { db, FieldValue } = getAdminServices();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw { status: 404, message: 'Utilisateur introuvable.' };

  const data = userSnap.data();

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

  await logAction({
    action: 'Révocation Premium',
    target: data.email || uid,
    adminEmail: adminCtx?.email,
    adminUid: adminCtx?.uid
  });

  return { ok: true };
}

async function toggleBlockUser({ uid }, adminCtx) {
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

  await logAction({
    action: isBlocked ? 'Déblocage compte' : 'Blocage compte',
    target: data.email || uid,
    adminEmail: adminCtx?.email,
    adminUid: adminCtx?.uid
  });

  return { ok: true, blocked: !isBlocked };
}

async function promoteUser({ uid }, adminCtx) {
  const { db, FieldValue } = getAdminServices();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw { status: 404, message: 'Utilisateur introuvable.' };

  await userRef.update({
    role: 'admin',
    updatedAt: FieldValue.serverTimestamp()
  });

  await logAction({
    action: 'Promotion admin',
    target: userSnap.data().email || uid,
    adminEmail: adminCtx?.email,
    adminUid: adminCtx?.uid
  });

  return { ok: true };
}

async function demoteUser({ uid }, adminCtx) {
  const { db, FieldValue } = getAdminServices();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw { status: 404, message: 'Utilisateur introuvable.' };

  await userRef.update({
    role: 'student',
    updatedAt: FieldValue.serverTimestamp()
  });

  await logAction({
    action: 'Retrait admin',
    target: userSnap.data().email || uid,
    adminEmail: adminCtx?.email,
    adminUid: adminCtx?.uid
  });

  return { ok: true };
}

async function deleteUser({ uid }, adminCtx) {
  const { db, auth } = getAdminServices();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw { status: 404, message: 'Utilisateur introuvable.' };

  const data = userSnap.data();
  if (data.role === 'admin') throw { status: 403, message: 'Impossible de supprimer un admin.' };

  const email = data.email || uid;

  await userRef.delete();
  try {
    await auth.deleteUser(uid);
  } catch (e) {
    console.warn('Auth delete failed:', e.message);
  }

  await logAction({
    action: 'Suppression profil',
    target: email,
    adminEmail: adminCtx?.email,
    adminUid: adminCtx?.uid
  });

  return { ok: true };
}

// ────────────────────────────────────────────────────────────────
// ACTIONS — NOTIFICATIONS
// ────────────────────────────────────────────────────────────────
async function sendNotification({ target, email, title, message, type }, adminCtx) {
  const { db, FieldValue } = getAdminServices();

  if (!title || !message) throw { status: 400, message: 'Titre et message requis.' };
  if (title.length > 120) throw { status: 400, message: 'Titre trop long.' };
  if (message.length > 1000) throw { status: 400, message: 'Message trop long.' };

  let usersSnap;
  if (target === 'specific') {
    if (!email) throw { status: 400, message: 'Email requis.' };
    usersSnap = await db.collection('users')
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

      getUserTokens(doc.data()).forEach((t) => tokens.push({ token: t, uid: doc.id }));
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
        try { await cleanupBatch.commit(); } catch (e) {}
      }
    }
  }

  await db.collection('admin_notifications').add({
    kind: 'admin_broadcast',
    title,
    message,
    type: type || 'info',
    target,
    targetLabel: target === 'specific' ? email : target,
    count,
    pushSent,
    pushFailed,
    sentBy: adminCtx?.email || 'admin',
    createdAt: now
  });

  await logAction({
    action: 'Notification envoyée',
    target: target === 'specific' ? email : target,
    details: { title, count, pushSent, pushFailed },
    adminEmail: adminCtx?.email,
    adminUid: adminCtx?.uid
  });

  return { ok: true, count, pushSent, pushFailed };
}

async function getNotificationHistory() {
  const { db } = getAdminServices();
  const snap = await db.collection('admin_notifications')
    .orderBy('createdAt', 'desc')
    .limit(30)
    .get();
  return {
    history: snap.docs.map((d) => {
      const data = d.data();
      return { id: d.id, ...data, createdAt: toISO(data.createdAt) };
    })
  };
}

// ────────────────────────────────────────────────────────────────
// ACTIONS — AVIS / LOGS / PROMOS / BANNED / MAINTENANCE
// ────────────────────────────────────────────────────────────────
async function getAvis() {
  const { db } = getAdminServices();
  const snap = await db.collection('avis')
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();
  return {
    avis: snap.docs.map((d) => {
      const data = d.data();
      return { id: d.id, ...data, createdAt: toISO(data.createdAt) };
    })
  };
}

async function getLogs({ limit: lim = 60 } = {}) {
  const { db } = getAdminServices();
  const snap = await db.collection('adminLogs')
    .orderBy('timestamp', 'desc')
    .limit(Math.min(lim, 100))
    .get();
  return {
    logs: snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        timestamp: toISO(data.timestamp),
        createdAt: toISO(data.createdAt)
      };
    })
  };
}

async function getPromos() {
  const { db } = getAdminServices();
  const snap = await db.collection('promoCodes').get();
  return { promos: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
}

async function createPromo({ code, discount }, adminCtx) {
  const { db, FieldValue } = getAdminServices();
  if (!code || typeof code !== 'string' || code.length < 3) {
    throw { status: 400, message: 'Code invalide (3 caractères min).' };
  }
  if (!discount || discount < 1 || discount > 100) {
    throw { status: 400, message: 'Réduction invalide (1-100).' };
  }

  const codeUpper = code.toUpperCase().trim();
  const ref = db.collection('promoCodes').doc(codeUpper);
  const existing = await ref.get();
  if (existing.exists) {
    throw { status: 409, message: 'Ce code existe déjà.' };
  }

  await ref.set({
    code: codeUpper,
    discount: Number(discount),
    uses: 0,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: adminCtx?.email || 'admin'
  });

  await logAction({
    action: 'Création code promo',
    target: codeUpper,
    details: { discount },
    adminEmail: adminCtx?.email,
    adminUid: adminCtx?.uid
  });

  return { ok: true };
}

async function deletePromo({ id }, adminCtx) {
  const { db } = getAdminServices();
  await db.collection('promoCodes').doc(id).delete();

  await logAction({
    action: 'Suppression code promo',
    target: id,
    adminEmail: adminCtx?.email,
    adminUid: adminCtx?.uid
  });

  return { ok: true };
}

async function getBanned() {
  const { db } = getAdminServices();
  const snap = await db.collection('groups').doc('general').collection('banned').get();
  return {
    banned: snap.docs.map((d) => {
      const data = d.data();
      return { id: d.id, ...data, bannedAt: toISO(data.bannedAt) };
    })
  };
}

async function unbanUser({ uid }, adminCtx) {
  const { db } = getAdminServices();
  await db.collection('groups').doc('general').collection('banned').doc(uid).delete();

  await logAction({
    action: 'Débannissement',
    target: uid,
    adminEmail: adminCtx?.email,
    adminUid: adminCtx?.uid
  });

  return { ok: true };
}

async function toggleMaintenance({ enabled }, adminCtx) {
  const { db, FieldValue } = getAdminServices();
  await db.collection('config').doc('maintenance').set({
    enabled: Boolean(enabled),
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: adminCtx?.email || 'admin'
  }, { merge: true });

  await logAction({
    action: enabled ? 'Activation maintenance' : 'Désactivation maintenance',
    adminEmail: adminCtx?.email,
    adminUid: adminCtx?.uid
  });

  return { ok: true, enabled: Boolean(enabled) };
}

// ────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ────────────────────────────────────────────────────────────────
module.exports = async function handler(request, response) {
  // ⚡ CORS
  applyCors(request, response);

  if (request.method === 'OPTIONS') return response.status(204).end();

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return jsonError(response, 405, 'Méthode non autorisée.');
  }

  if (rateLimited(clientIp(request))) {
    return jsonError(response, 429, 'Trop de demandes. Réessaie.');
  }

  const body = request.body && typeof request.body === 'object' ? request.body : {};
  const action = body.action;

 // ⚡ ACTIONS PUBLIQUES — notifier les admins (n'importe quel user connecté)

// → Nouvelle demande Premium
if (action === 'notifyNewSubscriptionRequest') {
  const user = await verifyFirebaseToken(request);
  if (!user) return jsonError(response, 401, 'Connexion requise.');
  try {
    return response.status(200).json(await notifyNewSubscriptionRequest(body));
  } catch (e) {
    console.error('notifyNewSubscriptionRequest error:', e.message);
    return jsonError(response, 500, e.message || 'Erreur serveur.');
  }
}

// → Nouvelle inscription
if (action === 'notifyNewSignup') {
  const user = await verifyFirebaseToken(request);
  if (!user) return jsonError(response, 401, 'Connexion requise.');
  try {
    return response.status(200).json(await notifyNewSignup(body));
  } catch (e) {
    console.error('notifyNewSignup error:', e.message);
    return jsonError(response, 500, e.message || 'Erreur serveur.');
  }
}

  // 🔒 Toutes les autres actions → admin requis
  let adminContext;
  try {
    adminContext = await requireAdmin(request);
  } catch (e) {
    if (e.status) {
      return jsonError(response, e.status, e.message, e.details ? { details: e.details } : {});
    }
    console.error('[ADMIN] Config error:', e.message, '|', e.details || '');
    return jsonError(response, 503, e.message || 'Service temporairement indisponible.', {
      details: e.details || 'unknown'
    });
  }

  try {
    switch (action) {
      case 'checkAdmin': return response.status(200).json(await checkAdmin());
      case 'getDashboard': return response.status(200).json(await getDashboard());
      case 'getStats': return response.status(200).json(await getStats());
      case 'getAnalytics': return response.status(200).json(await getAnalytics(body));
      case 'getSubscriptions': return response.status(200).json(await getSubscriptions());
      case 'getUsers': return response.status(200).json(await getUsers(body));
      case 'approveSubscription': return response.status(200).json(await approveSubscription(body, adminContext));
      case 'rejectSubscription': return response.status(200).json(await rejectSubscription(body, adminContext));
      case 'giftPremium': return response.status(200).json(await giftPremium(body, adminContext));
      case 'revokePremium': return response.status(200).json(await revokePremium(body, adminContext));
      case 'toggleBlockUser': return response.status(200).json(await toggleBlockUser(body, adminContext));
      case 'promoteUser': return response.status(200).json(await promoteUser(body, adminContext));
      case 'demoteUser': return response.status(200).json(await demoteUser(body, adminContext));
      case 'deleteUser': return response.status(200).json(await deleteUser(body, adminContext));

      case 'sendNotification': return response.status(200).json(await sendNotification(body, adminContext));
      case 'getNotificationHistory': return response.status(200).json(await getNotificationHistory());

      case 'getAvis': return response.status(200).json(await getAvis());
      case 'getLogs': return response.status(200).json(await getLogs(body));
      case 'logAction': return response.status(200).json(await logAction({
        ...body,
        adminEmail: adminContext.email,
        adminUid: adminContext.uid
      }));

      case 'getPromos': return response.status(200).json(await getPromos());
      case 'createPromo': return response.status(200).json(await createPromo(body, adminContext));
      case 'deletePromo': return response.status(200).json(await deletePromo(body, adminContext));

      case 'getBanned': return response.status(200).json(await getBanned());
      case 'unbanUser': return response.status(200).json(await unbanUser(body, adminContext));

      case 'toggleMaintenance': return response.status(200).json(await toggleMaintenance(body, adminContext));
     
   
      default:
        return jsonError(response, 400, `Action inconnue : "${action}"`);
    }
  } catch (error) {
    console.error(`Admin action "${action}" failed:`, error.message);
    if (error.stack) console.error('Stack:', error.stack);
    if (error.status) return jsonError(response, error.status, error.message);
    return jsonError(response, 500, 'Erreur serveur : ' + error.message);
  }
};
