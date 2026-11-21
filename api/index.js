// ============================================
// USA Nums by Moon — Backend API v7.0.0
// ============================================
// Updates in this build (v7.0.0):
// - Added: UK TikTok accounts (buy, admin add/manage/delete, counters, cache)
// - Fixed: buy-fb-id now creates order doc + orderCount + purchased subcollection
// - Updated: buy-gmail now saves to purchased subcollection (for dashboard display)
// - Updated: combined-dashboard now returns myGmails, myFbIds, myTiktokAccounts,
//            tiktokPriceList — all in ONE call (no extra endpoint)
// - Added: delete-purchased endpoint (gmail/fbid/tiktok soft-delete)
// - Updated: admin dashboards show tiktokAvailable + tiktokSold
// - Preserved: 60s cache, incremental counters, transactions, single-write pattern
// - No change to: rate limiters, auth flow, existing endpoints, order numbering
// ============================================

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');

const app = express();

// ============================================
// ✅ SECURITY: Disable headers, trust proxy
// ============================================
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ============================================
// ✅ SECURITY: CORS
// ============================================
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://moon-us-nums.free.nf')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('CORS not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'admin-token'],
  maxAge: 600
}));

app.options('*', cors());

// Body parser
app.use(express.json({ limit: '2mb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ============================================
// ✅ RATE LIMITERS
// ============================================
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => {
    const email = (req.body?.email || '').toLowerCase().trim();
    return email ? `login_${email}_${req.ip}` : `login_${req.ip}`;
  },
  skipSuccessfulRequests: true,
  message: { error: 'Too many failed login attempts for this account. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => {
    const email = (req.body?.email || '').toLowerCase().trim();
    return email ? `signup_${email}_${req.ip}` : `signup_${req.ip}`;
  },
  message: { error: 'Too many signup attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => {
    const email = (req.body?.email || '').toLowerCase().trim();
    return email ? `admin_${email}_${req.ip}` : `admin_${req.ip}`;
  },
  skipSuccessfulRequests: true,
  message: { error: 'Too many admin login attempts. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const transferLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many transfer requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const buyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many purchase requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const passwordChangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `pwd_${req.uid || req.ip}`,
  message: { error: 'Too many password change attempts. Please wait 1 hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  skipSuccessfulRequests: true,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================
// Firebase init
// ============================================
try {
  const serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  };
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_PRIVATE_KEY || !process.env.FIREBASE_CLIENT_EMAIL) {
    console.error('Missing Firebase environment variables');
  } else {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('Firebase initialized successfully');
  }
} catch (error) {
  console.error('Firebase initialization error:', error);
}

const db = admin.firestore();
const auth = admin.auth();

// ============================================
// Per-user transfer rate limit (in-memory)
// ============================================
const transferCounts = new Map();

function checkUserTransferLimit(uid) {
  const now = Date.now();
  const key = `transfer_${uid}`;
  let arr = transferCounts.get(key) || [];
  arr = arr.filter(t => now - t < 60000);
  if (arr.length >= 10) return false;
  arr.push(now);
  transferCounts.set(key, arr);
  return true;
}

// ============================================
// Cache system (extended with tiktok)
// ============================================
let cache = {
  priceCounts: null,
  idPriceCounts: null,
  gmailPriceCounts: null,
  fbIdPriceCounts: null,
  tiktokPriceCounts: null,
  adminCounters: null,
  timestamp: 0
};
const CACHE_TTL = 60000;

function cacheValid() {
  return cache.priceCounts && cache.idPriceCounts && cache.gmailPriceCounts &&
    cache.fbIdPriceCounts && cache.tiktokPriceCounts &&
    (Date.now() - cache.timestamp) < CACHE_TTL;
}

async function getCachedAllPrices() {
  if (cacheValid()) {
    return {
      normal: cache.priceCounts,
      id: cache.idPriceCounts,
      gmail: cache.gmailPriceCounts,
      fbId: cache.fbIdPriceCounts,
      tiktok: cache.tiktokPriceCounts
    };
  }

  const [normalSnapshot, idSnapshot, gmailSnapshot, fbIdSnapshot, tiktokSnapshot] = await Promise.all([
    db.collection('priceCounts').get(),
    db.collection('idPriceCounts').get(),
    db.collection('gmailPriceCounts').get(),
    db.collection('fbIdPriceCounts').get(),
    db.collection('tiktokPriceCounts').get()
  ]);

  const normal = {};
  normalSnapshot.forEach(doc => { normal[doc.id] = doc.data().availableCount || 0; });

  const id = {};
  idSnapshot.forEach(doc => { id[doc.id] = doc.data().availableCount || 0; });

  const gmail = {};
  gmailSnapshot.forEach(doc => { gmail[doc.id] = doc.data().availableCount || 0; });

  const fbId = { simple: {}, marketplace: {} };
  fbIdSnapshot.forEach(doc => {
    const data = doc.data();
    const type = data.type;
    const price = data.price;
    if (fbId[type]) {
      fbId[type][price] = data.availableCount || 0;
    }
  });

  const tiktok = {};
  tiktokSnapshot.forEach(doc => { tiktok[doc.id] = doc.data().availableCount || 0; });

  cache.priceCounts = normal;
  cache.idPriceCounts = id;
  cache.gmailPriceCounts = gmail;
  cache.fbIdPriceCounts = fbId;
  cache.tiktokPriceCounts = tiktok;
  cache.timestamp = Date.now();

  return { normal, id, gmail, fbId, tiktok };
}

async function getCachedAdminCounters() {
  const now = Date.now();
  if (cache.adminCounters && (now - cache.timestamp) < CACHE_TTL) {
    return cache.adminCounters;
  }

  const countersDoc = await db.collection('meta').doc('counters').get();
  if (countersDoc.exists) {
    const data = countersDoc.data();
    cache.adminCounters = data;
    cache.timestamp = now;
    return data;
  }

  // Rebuild
  return await updateAdminCounters();
}

async function updateAdminCounters() {
  const [
    usersCount, availableCount, soldCount,
    idAvailableCount, idSoldCount,
    gmailAvailableCount, gmailSoldCount,
    fbIdsAvailableCount, fbIdsSoldCount,
    tiktokAvailableCount, tiktokSoldCount
  ] = await Promise.all([
    db.collection('users').count().get(),
    db.collection('numbers').where('status', '==', 'available').count().get(),
    db.collection('numbers').where('status', '==', 'sold').count().get(),
    db.collection('idNumbers').where('status', '==', 'available').count().get(),
    db.collection('idNumbers').where('status', '==', 'sold').count().get(),
    db.collection('gmails').where('status', '==', 'available').count().get(),
    db.collection('gmails').where('status', '==', 'sold').count().get(),
    db.collection('fbIds').where('status', '==', 'available').count().get(),
    db.collection('fbIds').where('status', '==', 'sold').count().get(),
    db.collection('tiktokAccounts').where('status', '==', 'available').count().get(),
    db.collection('tiktokAccounts').where('status', '==', 'sold').count().get()
  ]);

  const counters = {
    totalUsers: usersCount.data().count || 0,
    availableNumbers: availableCount.data().count || 0,
    soldNumbers: soldCount.data().count || 0,
    idAvailableNumbers: idAvailableCount.data().count || 0,
    idSoldNumbers: idSoldCount.data().count || 0,
    gmailAvailable: gmailAvailableCount.data().count || 0,
    gmailSold: gmailSoldCount.data().count || 0,
    fbIdsAvailable: fbIdsAvailableCount.data().count || 0,
    fbIdsSold: fbIdsSoldCount.data().count || 0,
    tiktokAvailable: tiktokAvailableCount.data().count || 0,
    tiktokSold: tiktokSoldCount.data().count || 0,
    updatedAt: Date.now()
  };
  await db.collection('meta').doc('counters').set(counters);
  cache.adminCounters = counters;
  cache.timestamp = Date.now();
  return counters;
}

// ✅ Incremental counter update (1 write instead of 11 reads)
async function incrementCounters(deltas) {
  try {
    await db.collection('meta').doc('counters').set(deltas, { merge: true });
    cache.adminCounters = null; // Invalidate cache
  } catch (e) {
    console.error('Counter increment error:', e);
  }
}

// ============================================
// ✅ SECURITY: Auth middleware
// ============================================
async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const idToken = authHeader.split(' ')[1];
    const decoded = await auth.verifyIdToken(idToken);
    req.uid = decoded.uid;
    req.email = decoded.email;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdminToken(req, res, next) {
  const adminToken = req.headers['admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ============================================
// Utility helpers
// ============================================
function generateCouponCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'MOON-';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function verifyFirebasePassword(email, password) {
  const apiKey = process.env.FIREBASE_API_KEY;
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: false })
  });
  return response.ok;
}

// ============================================
// ==================== AUTH ENDPOINTS ====================
// ============================================

// User Signup
app.post('/api/auth/signup', signupLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const normalizedEmail = email.toLowerCase().trim();

    let userRecord;
    try {
      userRecord = await auth.createUser({ email: normalizedEmail, password });
    } catch (e) {
      if (e.code === 'auth/email-already-exists') {
        return res.status(400).json({ error: 'Could not create account. Try logging in if you already have one.' });
      }
      if (e.code === 'auth/invalid-email') return res.status(400).json({ error: 'Invalid email format' });
      if (e.code === 'auth/weak-password') return res.status(400).json({ error: 'Password is too weak' });
      return res.status(400).json({ error: 'Could not create account' });
    }

    const userId = userRecord.uid;
    await db.collection('users').doc(userId).set({
      email: normalizedEmail,
      balance: 0,
      role: 'user',
      orderCount: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Auto-login
    let idToken = null, refreshToken = null;
    try {
      const apiKey = process.env.FIREBASE_API_KEY;
      const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail, password, returnSecureToken: true })
      });
      const d = await r.json();
      if (r.ok) { idToken = d.idToken; refreshToken = d.refreshToken; }
    } catch (e) { console.error('Auto-login after signup failed:', e.message); }

    res.json({ success: true, userId, email: normalizedEmail, idToken, refreshToken });

  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// User Login
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const apiKey = process.env.FIREBASE_API_KEY;
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.toLowerCase().trim(), password, returnSecureToken: true })
    });
    const data = await response.json();

    if (!response.ok) {
      if (data.error?.message === 'QUOTA_EXCEEDED') {
        return res.status(429).json({ error: 'Too many login attempts. Please wait 1 hour.' });
      }
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const userDoc = await db.collection('users').doc(data.localId).get();
    if (!userDoc.exists) {
      await db.collection('users').doc(data.localId).set({
        email: email.toLowerCase().trim(),
        balance: 0,
        role: 'user',
        orderCount: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({
      success: true,
      userId: data.localId,
      email: email.toLowerCase().trim(),
      idToken: data.idToken,
      refreshToken: data.refreshToken
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Token Refresh
app.post('/api/auth/refresh', authLimiter, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    const apiKey = process.env.FIREBASE_API_KEY;
    const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
    });
    const data = await response.json();
    if (!response.ok) return res.status(401).json({ error: 'Invalid refresh token' });

    res.json({
      success: true,
      idToken: data.id_token,
      refreshToken: data.refresh_token,
      userId: data.user_id
    });
  } catch (e) {
    res.status(401).json({ error: 'Refresh failed' });
  }
});

// Admin Login
app.post('/api/admin/login', adminLoginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const adminToken = req.headers['admin-token'];

    if (!email || !password || !adminToken) {
      return res.status(400).json({ error: 'Email, password and admin token required' });
    }
    if (adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const apiKey = process.env.FIREBASE_API_KEY;
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.toLowerCase().trim(), password, returnSecureToken: true })
    });
    const data = await response.json();

    if (!response.ok) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const userDoc = await db.collection('users').doc(data.localId).get();
    if (!userDoc.exists) return res.status(403).json({ error: 'Not authorized' });
    const userData = userDoc.data();
    if (!userData.role || userData.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });

    await auth.setCustomUserClaims(data.localId, { admin: true });

    res.json({ success: true, adminEmail: email.toLowerCase().trim(), userId: data.localId });

  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Admin login failed' });
  }
});

// ============================================
// ==================== USER ENDPOINTS ====================
// ============================================

// Combined Dashboard
app.post('/api/user/combined-dashboard', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const userData = userDoc.data();

    const prices = await getCachedAllPrices();

    const normalPriceList = Object.entries(prices.normal)
      .filter(([_, c]) => c > 0)
      .map(([price, availableCount]) => ({ price, availableCount }))
      .sort((a, b) => parseInt(a.price) - parseInt(b.price));

    const idPriceList = Object.entries(prices.id)
      .filter(([_, c]) => c > 0)
      .map(([price, availableCount]) => ({ price, availableCount }))
      .sort((a, b) => parseInt(a.price) - parseInt(b.price));

    const gmailPriceList = Object.entries(prices.gmail)
      .filter(([_, c]) => c > 0)
      .map(([price, availableCount]) => ({ price, availableCount }))
      .sort((a, b) => parseInt(a.price) - parseInt(b.price));

    const fbIdSimple = Object.entries(prices.fbId.simple || {})
      .filter(([_, c]) => c > 0)
      .map(([price, availableCount]) => ({ price, availableCount }))
      .sort((a, b) => parseInt(a.price) - parseInt(b.price));

    const fbIdMarketplace = Object.entries(prices.fbId.marketplace || {})
      .filter(([_, c]) => c > 0)
      .map(([price, availableCount]) => ({ price, availableCount }))
      .sort((a, b) => parseInt(a.price) - parseInt(b.price));

    const tiktokPriceList = Object.entries(prices.tiktok || {})
      .filter(([_, c]) => c > 0)
      .map(([price, availableCount]) => ({ price, availableCount }))
      .sort((a, b) => parseInt(a.price) - parseInt(b.price));

    const normalPurchased = await db.collection('users').doc(userId).collection('purchased')
      .where('status', '==', 'active').where('type', '==', 'normal').orderBy('purchasedAt', 'desc').get();
    const myNumbers = [];
    normalPurchased.forEach(doc => myNumbers.push({ id: doc.id, ...doc.data() }));

    const idPurchased = await db.collection('users').doc(userId).collection('purchased')
      .where('status', '==', 'active').where('type', '==', 'id').orderBy('purchasedAt', 'desc').get();
    const myIdNumbers = [];
    idPurchased.forEach(doc => myIdNumbers.push({ id: doc.id, ...doc.data() }));

    // NEW: purchased gmails
    const gmailsPurchased = await db.collection('users').doc(userId).collection('purchased')
      .where('status', '==', 'active').where('type', '==', 'gmail').orderBy('purchasedAt', 'desc').get();
    const myGmails = [];
    gmailsPurchased.forEach(doc => myGmails.push({ id: doc.id, ...doc.data() }));

    // NEW: purchased FB IDs (simple + marketplace combined)
    const [fbSimplePurchased, fbMarketPurchased] = await Promise.all([
      db.collection('users').doc(userId).collection('purchased')
        .where('status', '==', 'active').where('type', '==', 'fb_simple').orderBy('purchasedAt', 'desc').get(),
      db.collection('users').doc(userId).collection('purchased')
        .where('status', '==', 'active').where('type', '==', 'fb_marketplace').orderBy('purchasedAt', 'desc').get()
    ]);
    const myFbIds = [];
    fbSimplePurchased.forEach(doc => myFbIds.push({ id: doc.id, ...doc.data() }));
    fbMarketPurchased.forEach(doc => myFbIds.push({ id: doc.id, ...doc.data() }));

    // NEW: purchased TikTok accounts
    const tiktokPurchased = await db.collection('users').doc(userId).collection('purchased')
      .where('status', '==', 'active').where('type', '==', 'tiktok').orderBy('purchasedAt', 'desc').get();
    const myTiktokAccounts = [];
    tiktokPurchased.forEach(doc => myTiktokAccounts.push({ id: doc.id, ...doc.data() }));

    const transfersSnapshot = await db.collection('users').doc(userId).collection('transfers')
      .orderBy('timestamp', 'desc').limit(20).get();
    const transfers = [];
    transfersSnapshot.forEach(doc => {
      const data = doc.data();
      let timestamp = data.timestamp;
      if (timestamp && timestamp.toDate) timestamp = timestamp.toDate().toISOString();
      transfers.push({
        id: doc.id, type: data.type || 'unknown',
        recipientEmail: data.recipientEmail || '', senderEmail: data.senderEmail || '',
        amount: data.amount || 0, balanceAfter: data.balanceAfter || 0,
        timestamp, date: timestamp ? new Date(timestamp).toLocaleDateString() : '',
        time: timestamp ? new Date(timestamp).toLocaleTimeString() : ''
      });
    });

    res.json({
      success: true,
      balance: userData.balance || 0,
      email: userData.email || '',
      normalPriceList,
      idPriceList,
      gmailPriceList,
      fbIdPriceList: { simple: fbIdSimple, marketplace: fbIdMarketplace },
      tiktokPriceList,
      myNumbers,
      myIdNumbers,
      myGmails,
      myFbIds,
      myTiktokAccounts,
      transfers
    });
  } catch (error) {
    console.error('Combined dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// Multi-quantity buy numbers (unchanged)
// ============================================
app.post('/api/user/buy-numbers', buyLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const { type, price, quantity, couponCode } = req.body;

    if (!type || !['verification', 'id'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type. Must be verification or id' });
    }
    if (!price) return res.status(400).json({ error: 'Price required' });
    if (!quantity || !Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
      return res.status(400).json({ error: 'Quantity must be between 1 and 500' });
    }

    const priceStr = price.toString();
    const numbersCollection = type === 'id' ? 'idNumbers' : 'numbers';
    const priceCountCollection = type === 'id' ? 'idPriceCounts' : 'priceCounts';
    const purchasedType = type === 'id' ? 'id' : 'normal';

    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      const userData = userDoc.data();

      const unitPrice = parseInt(priceStr);
      let discount = 0;
      let couponRef = null;
      let couponData = null;

      if (couponCode && typeof couponCode === 'string') {
        const cleanCode = couponCode.toUpperCase().trim();
        couponRef = db.collection('coupons').doc(cleanCode);
        const couponDoc = await transaction.get(couponRef);
        if (!couponDoc.exists) throw new Error('Invalid coupon code');
        couponData = couponDoc.data();
        if (couponData.usedBy) throw new Error('Coupon already used');
        if (couponData.type !== type) throw new Error('Coupon not valid for this product type');
        discount = couponData.discountPerNumber * quantity;
      }

      const originalTotal = unitPrice * quantity;
      const totalPrice = Math.max(0, originalTotal - discount);

      if (totalPrice < 0) throw new Error('Invalid discount');
      if ((userData.balance || 0) < totalPrice) {
        throw new Error(`Insufficient balance. Need ${totalPrice} PKR`);
      }

      const numbersQuery = await transaction.get(
        db.collection(numbersCollection)
          .where('price', '==', priceStr)
          .where('status', '==', 'available')
          .limit(quantity)
      );

      if (numbersQuery.size < quantity) {
        throw new Error(`Only ${numbersQuery.size} available at this price. Please reduce quantity.`);
      }

      const purchasedItems = [];

      for (const doc of numbersQuery.docs) {
        const numberData = doc.data();

        transaction.update(doc.ref, {
          status: 'sold',
          soldTo: userId,
          soldAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const purchasedRef = db.collection('users').doc(userId).collection('purchased').doc(doc.id);
        transaction.set(purchasedRef, {
          number: numberData.number,
          apiUrl: numberData.apiUrl,
          price: priceStr,
          purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'active',
          type: purchasedType
        });

        purchasedItems.push({
          id: doc.id,
          number: numberData.number,
          apiUrl: numberData.apiUrl,
          price: priceStr
        });
      }

      const priceCountRef = db.collection(priceCountCollection).doc(priceStr);
      transaction.set(priceCountRef, {
        availableCount: admin.firestore.FieldValue.increment(-quantity),
        soldCount: admin.firestore.FieldValue.increment(quantity)
      }, { merge: true });

      const currentOrderCount = userData.orderCount || 0;
      const newOrderNumber = currentOrderCount + 1;

      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(-totalPrice),
        orderCount: newOrderNumber
      });

      if (couponRef && couponData) {
        transaction.update(couponRef, {
          usedBy: userId,
          usedAt: admin.firestore.FieldValue.serverTimestamp(),
          totalUses: 1
        });
      }

      const orderRef = db.collection('users').doc(userId).collection('orders').doc();
      transaction.set(orderRef, {
        orderNumber: newOrderNumber,
        service: type === 'id' ? 'id_creation' : 'verification',
        quantity,
        perUnitPrice: unitPrice,
        originalTotal,
        discount,
        total: totalPrice,
        couponCode: couponCode ? couponCode.toUpperCase().trim() : null,
        items: purchasedItems,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const historyRef = db.collection('users').doc(userId).collection('history').doc();
      transaction.set(historyRef, {
        type: 'purchase',
        details: `Bought ${quantity} ${type === 'id' ? 'ID Creation' : 'Verification'} number(s) at ${unitPrice} PKR each`,
        amount: -totalPrice,
        balanceAfter: (userData.balance || 0) - totalPrice,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        quantity,
        totalPrice,
        originalTotal,
        discount,
        newBalance: (userData.balance || 0) - totalPrice,
        orderNumber: newOrderNumber,
        numbers: purchasedItems
      };
    });

    const counterDeltas = {};
    if (type === 'id') {
      counterDeltas.idAvailableNumbers = admin.firestore.FieldValue.increment(-quantity);
      counterDeltas.idSoldNumbers = admin.firestore.FieldValue.increment(quantity);
    } else {
      counterDeltas.availableNumbers = admin.firestore.FieldValue.increment(-quantity);
      counterDeltas.soldNumbers = admin.firestore.FieldValue.increment(quantity);
    }
    await incrementCounters(counterDeltas);

    cache.timestamp = 0;
    res.json({ success: true, ...result });

  } catch (error) {
    console.error('Buy numbers error:', error);
    const msg = error?.message || '';
    if (msg.includes('Insufficient balance')) return res.status(400).json({ error: msg });
    if (msg.includes('available at this price')) return res.status(400).json({ error: msg });
    if (msg.includes('User not found')) return res.status(404).json({ error: 'User not found' });
    if (msg.includes('Coupon')) return res.status(400).json({ error: msg });
    res.status(400).json({ error: 'Purchase failed' });
  }
});

// ============================================
// Buy Gmails — NOW saves to purchased subcollection
// ============================================
app.post('/api/user/buy-gmail', buyLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const { price, quantity } = req.body;

    if (!price) return res.status(400).json({ error: 'Price required' });
    if (!quantity || !Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
      return res.status(400).json({ error: 'Quantity must be between 1 and 500' });
    }

    const priceStr = price.toString();

    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      const userData = userDoc.data();

      const unitPrice = parseInt(priceStr);
      const totalPrice = unitPrice * quantity;

      if ((userData.balance || 0) < totalPrice) {
        throw new Error(`Insufficient balance. Need ${totalPrice} PKR`);
      }

      const gmailQuery = await transaction.get(
        db.collection('gmails')
          .where('price', '==', priceStr)
          .where('status', '==', 'available')
          .limit(quantity)
      );

      if (gmailQuery.size < quantity) {
        throw new Error(`Only ${gmailQuery.size} available at this price. Please reduce quantity.`);
      }

      const purchasedItems = [];

      for (const doc of gmailQuery.docs) {
        const gmailData = doc.data();

        transaction.update(doc.ref, {
          status: 'sold',
          soldTo: userId,
          soldAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // NEW: save to purchased subcollection
        const purchasedRef = db.collection('users').doc(userId).collection('purchased').doc(doc.id);
        transaction.set(purchasedRef, {
          gmail: gmailData.gmail,
          password: gmailData.password,
          price: priceStr,
          type: 'gmail',
          status: 'active',
          purchasedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        purchasedItems.push({
          id: doc.id,
          gmail: gmailData.gmail,
          password: gmailData.password,
          price: priceStr
        });
      }

      const priceCountRef = db.collection('gmailPriceCounts').doc(priceStr);
      transaction.set(priceCountRef, {
        availableCount: admin.firestore.FieldValue.increment(-quantity),
        soldCount: admin.firestore.FieldValue.increment(quantity)
      }, { merge: true });

      const currentOrderCount = userData.orderCount || 0;
      const newOrderNumber = currentOrderCount + 1;

      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(-totalPrice),
        orderCount: newOrderNumber
      });

      const orderRef = db.collection('users').doc(userId).collection('orders').doc();
      transaction.set(orderRef, {
        orderNumber: newOrderNumber,
        service: 'gmail',
        quantity,
        perUnitPrice: unitPrice,
        originalTotal: totalPrice,
        discount: 0,
        total: totalPrice,
        couponCode: null,
        items: purchasedItems,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const historyRef = db.collection('users').doc(userId).collection('history').doc();
      transaction.set(historyRef, {
        type: 'purchase',
        details: `Bought ${quantity} Gmail account(s) at ${unitPrice} PKR each`,
        amount: -totalPrice,
        balanceAfter: (userData.balance || 0) - totalPrice,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        quantity,
        totalPrice,
        newBalance: (userData.balance || 0) - totalPrice,
        orderNumber: newOrderNumber,
        gmails: purchasedItems
      };
    });

    await incrementCounters({
      gmailAvailable: admin.firestore.FieldValue.increment(-quantity),
      gmailSold: admin.firestore.FieldValue.increment(quantity)
    });

    cache.timestamp = 0;
    res.json({ success: true, ...result });

  } catch (error) {
    console.error('Buy gmail error:', error);
    const msg = error?.message || '';
    if (msg.includes('Insufficient balance')) return res.status(400).json({ error: msg });
    if (msg.includes('available at this price')) return res.status(400).json({ error: msg });
    if (msg.includes('User not found')) return res.status(404).json({ error: 'User not found' });
    res.status(400).json({ error: 'Purchase failed' });
  }
});

// ============================================
// Buy FB IDs — FIXED: order + orderCount + purchased subcollection
// ============================================
app.post('/api/user/buy-fb-id', buyLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const { type, price, quantity } = req.body;

    if (!type || !['simple', 'marketplace'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type. Must be simple or marketplace' });
    }
    if (!price) return res.status(400).json({ error: 'Price required' });
    if (!quantity || !Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
      return res.status(400).json({ error: 'Quantity must be between 1 and 500' });
    }

    const priceStr = price.toString();
    const purchasedType = type === 'marketplace' ? 'fb_marketplace' : 'fb_simple';
    const serviceName = type === 'marketplace' ? 'fbid_marketplace' : 'fbid_simple';

    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      const userData = userDoc.data();

      const unitPrice = parseInt(priceStr);
      const totalPrice = unitPrice * quantity;

      if ((userData.balance || 0) < totalPrice) {
        throw new Error(`Insufficient balance. Need ${totalPrice} PKR`);
      }

      const fbIdsQuery = await transaction.get(
        db.collection('fbIds')
          .where('type', '==', type)
          .where('price', '==', priceStr)
          .where('status', '==', 'available')
          .limit(quantity)
      );

      if (fbIdsQuery.size < quantity) {
        throw new Error(`Only ${fbIdsQuery.size} available at this price. Please reduce quantity.`);
      }

      const purchasedItems = [];

      for (const doc of fbIdsQuery.docs) {
        const fbData = doc.data();

        transaction.update(doc.ref, {
          status: 'sold',
          soldTo: userId,
          soldAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // NEW: save to purchased subcollection
        const purchasedRef = db.collection('users').doc(userId).collection('purchased').doc(doc.id);
        transaction.set(purchasedRef, {
          uid: fbData.uid,
          password: fbData.password,
          twoFA: fbData.twoFA || null,
          price: priceStr,
          type: purchasedType,
          status: 'active',
          purchasedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        purchasedItems.push({
          id: doc.id,
          uid: fbData.uid,
          password: fbData.password,
          twoFA: fbData.twoFA || null,
          price: priceStr
        });
      }

      const priceCountRef = db.collection('fbIdPriceCounts').doc(`${type}_${priceStr}`);
      transaction.set(priceCountRef, {
        type: type,
        price: priceStr,
        availableCount: admin.firestore.FieldValue.increment(-quantity),
        soldCount: admin.firestore.FieldValue.increment(quantity)
      }, { merge: true });

      // FIX: orderCount + order doc (previously missing)
      const currentOrderCount = userData.orderCount || 0;
      const newOrderNumber = currentOrderCount + 1;

      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(-totalPrice),
        orderCount: newOrderNumber
      });

      const orderRef = db.collection('users').doc(userId).collection('orders').doc();
      transaction.set(orderRef, {
        orderNumber: newOrderNumber,
        service: serviceName,
        quantity,
        perUnitPrice: unitPrice,
        originalTotal: totalPrice,
        discount: 0,
        total: totalPrice,
        couponCode: null,
        items: purchasedItems,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const historyRef = db.collection('users').doc(userId).collection('history').doc();
      transaction.set(historyRef, {
        type: 'purchase',
        details: `Bought ${quantity} ${type === 'marketplace' ? 'Marketplace Verified' : 'Simple'} FB ID(s) at ${unitPrice} PKR each`,
        amount: -totalPrice,
        balanceAfter: (userData.balance || 0) - totalPrice,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        quantity,
        totalPrice,
        newBalance: (userData.balance || 0) - totalPrice,
        orderNumber: newOrderNumber,
        fbIds: purchasedItems
      };
    });

    await incrementCounters({
      fbIdsAvailable: admin.firestore.FieldValue.increment(-quantity),
      fbIdsSold: admin.firestore.FieldValue.increment(quantity)
    });

    cache.timestamp = 0;
    res.json({ success: true, ...result });

  } catch (error) {
    console.error('Buy fb id error:', error);
    const msg = error?.message || '';
    if (msg.includes('Insufficient balance')) return res.status(400).json({ error: msg });
    if (msg.includes('available at this price')) return res.status(400).json({ error: msg });
    if (msg.includes('User not found')) return res.status(404).json({ error: 'User not found' });
    res.status(400).json({ error: 'Purchase failed' });
  }
});

// ============================================
// ✅ NEW: Buy UK TikTok Accounts
// ============================================
app.post('/api/user/buy-tiktok', buyLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const { price, quantity } = req.body;

    if (!price) return res.status(400).json({ error: 'Price required' });
    if (!quantity || !Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
      return res.status(400).json({ error: 'Quantity must be between 1 and 500' });
    }

    const priceStr = price.toString();

    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      const userData = userDoc.data();

      const unitPrice = parseInt(priceStr);
      const totalPrice = unitPrice * quantity;

      if ((userData.balance || 0) < totalPrice) {
        throw new Error(`Insufficient balance. Need ${totalPrice} PKR`);
      }

      const tiktokQuery = await transaction.get(
        db.collection('tiktokAccounts')
          .where('price', '==', priceStr)
          .where('status', '==', 'available')
          .limit(quantity)
      );

      if (tiktokQuery.size < quantity) {
        throw new Error(`Only ${tiktokQuery.size} available at this price. Please reduce quantity.`);
      }

      const purchasedItems = [];

      for (const doc of tiktokQuery.docs) {
        const tData = doc.data();

        transaction.update(doc.ref, {
          status: 'sold',
          soldTo: userId,
          soldAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const purchasedRef = db.collection('users').doc(userId).collection('purchased').doc(doc.id);
        transaction.set(purchasedRef, {
          gmail: tData.gmail,
          gmailPassword: tData.gmailPassword,
          tiktokGmail: tData.tiktokGmail,
          tiktokPassword: tData.tiktokPassword,
          price: priceStr,
          type: 'tiktok',
          status: 'active',
          purchasedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        purchasedItems.push({
          id: doc.id,
          gmail: tData.gmail,
          gmailPassword: tData.gmailPassword,
          tiktokGmail: tData.tiktokGmail,
          tiktokPassword: tData.tiktokPassword,
          price: priceStr
        });
      }

      const priceCountRef = db.collection('tiktokPriceCounts').doc(priceStr);
      transaction.set(priceCountRef, {
        availableCount: admin.firestore.FieldValue.increment(-quantity),
        soldCount: admin.firestore.FieldValue.increment(quantity)
      }, { merge: true });

      const currentOrderCount = userData.orderCount || 0;
      const newOrderNumber = currentOrderCount + 1;

      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(-totalPrice),
        orderCount: newOrderNumber
      });

      const orderRef = db.collection('users').doc(userId).collection('orders').doc();
      transaction.set(orderRef, {
        orderNumber: newOrderNumber,
        service: 'tiktok',
        quantity,
        perUnitPrice: unitPrice,
        originalTotal: totalPrice,
        discount: 0,
        total: totalPrice,
        couponCode: null,
        items: purchasedItems,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const historyRef = db.collection('users').doc(userId).collection('history').doc();
      transaction.set(historyRef, {
        type: 'purchase',
        details: `Bought ${quantity} UK TikTok account(s) at ${unitPrice} PKR each`,
        amount: -totalPrice,
        balanceAfter: (userData.balance || 0) - totalPrice,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        quantity,
        totalPrice,
        newBalance: (userData.balance || 0) - totalPrice,
        orderNumber: newOrderNumber,
        tiktokAccounts: purchasedItems
      };
    });

    await incrementCounters({
      tiktokAvailable: admin.firestore.FieldValue.increment(-quantity),
      tiktokSold: admin.firestore.FieldValue.increment(quantity)
    });

    cache.timestamp = 0;
    res.json({ success: true, ...result });

  } catch (error) {
    console.error('Buy tiktok error:', error);
    const msg = error?.message || '';
    if (msg.includes('Insufficient balance')) return res.status(400).json({ error: msg });
    if (msg.includes('available at this price')) return res.status(400).json({ error: msg });
    if (msg.includes('User not found')) return res.status(404).json({ error: 'User not found' });
    res.status(400).json({ error: 'Purchase failed' });
  }
});

// ============================================
// ✅ NEW: Delete purchased items (gmail/fbid/tiktok)
// ============================================
app.post('/api/user/delete-purchased', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }
    if (ids.length > 200) {
      return res.status(400).json({ error: 'Too many ids at once (max 200)' });
    }

    const BATCH_SIZE = 10;
    let deletedCount = 0;

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = ids.slice(i, i + BATCH_SIZE);

      for (const id of chunk) {
        const ref = db.collection('users').doc(userId).collection('purchased').doc(id);
        batch.update(ref, {
          status: 'deleted',
          deletedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        deletedCount++;
      }

      await batch.commit();
    }

    res.json({ success: true, message: `${deletedCount} items deleted` });
  } catch (error) {
    console.error('Delete purchased error:', error);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ============================================
// Apply coupon (validate only) — unchanged
// ============================================
app.post('/api/user/apply-coupon', generalLimiter, verifyToken, async (req, res) => {
  try {
    const { couponCode, type } = req.body;

    if (!couponCode || typeof couponCode !== 'string') {
      return res.status(400).json({ error: 'Coupon code required' });
    }
    if (!type || !['verification', 'id'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }

    const cleanCode = couponCode.toUpperCase().trim();
    const couponDoc = await db.collection('coupons').doc(cleanCode).get();

    if (!couponDoc.exists) {
      return res.status(404).json({ error: 'Invalid coupon code' });
    }

    const couponData = couponDoc.data();

    if (couponData.usedBy) {
      return res.status(400).json({ error: 'Coupon already used' });
    }
    if (couponData.type !== type) {
      return res.status(400).json({ error: 'Coupon not valid for this product type' });
    }

    res.json({
      success: true,
      code: couponData.code,
      discountPerNumber: couponData.discountPerNumber,
      type: couponData.type
    });

  } catch (error) {
    console.error('Apply coupon error:', error);
    res.status(500).json({ error: 'Failed to validate coupon' });
  }
});

// ============================================
// History (paginated) — unchanged
// ============================================
app.post('/api/user/history', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const { lastDocId } = req.body;
    const PAGE_LIMIT = 20;

    let query = db.collection('users').doc(userId).collection('history')
      .orderBy('timestamp', 'desc')
      .limit(PAGE_LIMIT);

    if (lastDocId) {
      const lastDoc = await db.collection('users').doc(userId).collection('history').doc(lastDocId).get();
      if (lastDoc.exists) query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    const history = [];
    let lastId = null;

    snapshot.forEach(doc => {
      const data = doc.data();
      let timestamp = data.timestamp;
      if (timestamp && timestamp.toDate) timestamp = timestamp.toDate().toISOString();
      history.push({
        id: doc.id,
        type: data.type || 'unknown',
        details: data.details || '',
        amount: data.amount || 0,
        balanceAfter: data.balanceAfter || 0,
        timestamp,
        date: timestamp ? new Date(timestamp).toLocaleDateString() : '',
        time: timestamp ? new Date(timestamp).toLocaleTimeString() : ''
      });
      lastId = doc.id;
    });

    res.json({
      success: true,
      history,
      lastDocId: lastId,
      hasMore: history.length === PAGE_LIMIT
    });

  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

// ============================================
// My Orders (paginated) — unchanged
// ============================================
app.post('/api/user/my-orders', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const { lastDocId } = req.body;
    const PAGE_LIMIT = 20;

    let query = db.collection('users').doc(userId).collection('orders')
      .orderBy('createdAt', 'desc')
      .limit(PAGE_LIMIT);

    if (lastDocId) {
      const lastDoc = await db.collection('users').doc(userId).collection('orders').doc(lastDocId).get();
      if (lastDoc.exists) query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    const orders = [];
    let lastId = null;

    snapshot.forEach(doc => {
      const data = doc.data();
      let createdAt = data.createdAt;
      if (createdAt && createdAt.toDate) createdAt = createdAt.toDate().toISOString();

      orders.push({
        id: doc.id,
        orderNumber: data.orderNumber || 0,
        service: data.service || 'unknown',
        quantity: data.quantity || 0,
        perUnitPrice: data.perUnitPrice || 0,
        originalTotal: data.originalTotal || 0,
        discount: data.discount || 0,
        total: data.total || 0,
        couponCode: data.couponCode || null,
        items: data.items || [],
        createdAt,
        date: createdAt ? new Date(createdAt).toLocaleDateString() : '',
        time: createdAt ? new Date(createdAt).toLocaleTimeString() : ''
      });
      lastId = doc.id;
    });

    res.json({
      success: true,
      orders,
      lastDocId: lastId,
      hasMore: orders.length === PAGE_LIMIT
    });

  } catch (error) {
    console.error('My orders error:', error);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// ============================================
// Change Password — unchanged
// ============================================
app.post('/api/user/change-password', passwordChangeLimiter, verifyToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from current password' });
    }

    const isValid = await verifyFirebasePassword(req.email, currentPassword);
    if (!isValid) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    await auth.updateUser(req.uid, { password: newPassword });

    await db.collection('users').doc(req.uid).collection('history').add({
      type: 'password_change',
      details: 'Changed account password',
      amount: 0,
      balanceAfter: 0,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, message: 'Password changed successfully' });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ============================================
// Transfer Balance — unchanged
// ============================================
app.post('/api/user/transfer-balance', transferLimiter, verifyToken, async (req, res) => {
  try {
    const senderUid = req.uid;
    const { recipientEmail, amount } = req.body;

    if (!checkUserTransferLimit(senderUid)) {
      return res.status(429).json({ error: 'Too many transfers. Please wait 1 minute.' });
    }

    if (!recipientEmail || typeof recipientEmail !== 'string') {
      return res.status(400).json({ error: 'Recipient email required' });
    }
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive integer' });
    }
    if (amount > 1000000) return res.status(400).json({ error: 'Amount too large' });

    const senderDoc = await db.collection('users').doc(senderUid).get();
    if (!senderDoc.exists) return res.status(404).json({ error: 'Sender not found' });
    const senderData = senderDoc.data();

    if (senderData.role === 'admin') return res.status(403).json({ error: 'Admin accounts cannot use this endpoint' });

    if (senderData.email.toLowerCase() === recipientEmail.toLowerCase().trim()) {
      return res.status(400).json({ error: 'Cannot transfer to yourself' });
    }

    if ((senderData.balance || 0) < amount) return res.status(400).json({ error: 'Insufficient balance' });

    const recipientSnapshot = await db.collection('users')
      .where('email', '==', recipientEmail.toLowerCase().trim()).limit(1).get();
    if (recipientSnapshot.empty) return res.status(404).json({ error: 'Recipient user not found' });

    const recipientDoc = recipientSnapshot.docs[0];
    const recipientId = recipientDoc.id;
    const recipientData = recipientDoc.data();

    if (recipientData.role === 'admin') return res.status(400).json({ error: 'Cannot transfer to admin account' });

    await db.runTransaction(async (transaction) => {
      const senderRef = db.collection('users').doc(senderUid);
      const recipientRef = db.collection('users').doc(recipientId);
      const senderSnapshot = await transaction.get(senderRef);
      const recipientSnapshot2 = await transaction.get(recipientRef);
      if (!senderSnapshot.exists || !recipientSnapshot2.exists) throw new Error('User not found');
      const senderData2 = senderSnapshot.data();
      if ((senderData2.balance || 0) < amount) throw new Error('Insufficient balance');

      transaction.update(senderRef, { balance: admin.firestore.FieldValue.increment(-amount) });
      transaction.update(recipientRef, { balance: admin.firestore.FieldValue.increment(amount) });

      const transferRef = db.collection('users').doc(senderUid).collection('transfers').doc();
      transaction.set(transferRef, {
        type: 'sent', recipientEmail: recipientEmail.toLowerCase().trim(), recipientId,
        amount, timestamp: admin.firestore.FieldValue.serverTimestamp(),
        balanceAfter: (senderData2.balance || 0) - amount
      });
      const recipientTransferRef = db.collection('users').doc(recipientId).collection('transfers').doc();
      transaction.set(recipientTransferRef, {
        type: 'received', senderEmail: senderData.email, senderId: senderUid,
        amount, timestamp: admin.firestore.FieldValue.serverTimestamp(),
        balanceAfter: (recipientData.balance || 0) + amount
      });

      const senderHistoryRef = db.collection('users').doc(senderUid).collection('history').doc();
      transaction.set(senderHistoryRef, {
        type: 'transfer_sent',
        details: `Transferred to ${recipientEmail.toLowerCase().trim()}`,
        amount: -amount,
        balanceAfter: (senderData2.balance || 0) - amount,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      const recipientHistoryRef = db.collection('users').doc(recipientId).collection('history').doc();
      transaction.set(recipientHistoryRef, {
        type: 'transfer_received',
        details: `Received from ${senderData.email}`,
        amount: amount,
        balanceAfter: (recipientData.balance || 0) + amount,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    const updatedSender = await db.collection('users').doc(senderUid).get();
    res.json({
      success: true,
      message: `Successfully transferred ${amount} PKR to ${recipientEmail}`,
      newBalance: updatedSender.data().balance || 0,
      transferredAmount: amount, recipientEmail
    });

  } catch (error) {
    console.error('Transfer error:', error);
    const msg = error?.message || '';
    if (msg.includes('Insufficient balance')) return res.status(400).json({ error: 'Insufficient balance' });
    if (msg.includes('User not found')) return res.status(404).json({ error: 'User not found' });
    res.status(500).json({ error: 'Transfer failed' });
  }
});

// Transfer History — unchanged
app.post('/api/user/transfer-history', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const transfersSnapshot = await db.collection('users').doc(userId).collection('transfers')
      .orderBy('timestamp', 'desc').limit(50).get();
    const transfers = [];
    transfersSnapshot.forEach(doc => {
      const data = doc.data();
      let timestamp = data.timestamp;
      if (timestamp && timestamp.toDate) timestamp = timestamp.toDate().toISOString();
      transfers.push({
        id: doc.id, type: data.type || 'unknown',
        recipientEmail: data.recipientEmail || '', senderEmail: data.senderEmail || '',
        amount: data.amount || 0, balanceAfter: data.balanceAfter || 0,
        timestamp, date: timestamp ? new Date(timestamp).toLocaleDateString() : '',
        time: timestamp ? new Date(timestamp).toLocaleTimeString() : ''
      });
    });
    res.json({ success: true, transfers });
  } catch (error) {
    console.error('Transfer history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// My Numbers — unchanged
app.post('/api/user/my-numbers', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const purchasedSnapshot = await db.collection('users').doc(userId).collection('purchased')
      .where('status', '==', 'active').where('type', '==', 'normal').orderBy('purchasedAt', 'desc').get();
    const numbers = [];
    purchasedSnapshot.forEach(doc => numbers.push({ id: doc.id, ...doc.data() }));
    res.json({ numbers });
  } catch (error) {
    console.error('Get my numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete Number — unchanged
app.post('/api/user/delete-number', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const { numberId } = req.body;
    if (!numberId) return res.status(400).json({ error: 'numberId required' });

    const numberRef = db.collection('users').doc(userId).collection('purchased').doc(numberId);
    const numberDoc = await numberRef.get();
    if (!numberDoc.exists) return res.status(404).json({ error: 'Number not found' });

    await numberRef.update({ status: 'deleted', deletedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete number error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete Numbers — unchanged
app.post('/api/user/delete-numbers', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const { numberIds } = req.body;
    if (!numberIds || !Array.isArray(numberIds) || numberIds.length === 0) {
      return res.status(400).json({ error: 'numberIds array required' });
    }

    const batch = db.batch();
    for (const numberId of numberIds) {
      batch.update(db.collection('users').doc(userId).collection('purchased').doc(numberId), {
        status: 'deleted', deletedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    await batch.commit();
    res.json({ success: true, message: `${numberIds.length} numbers deleted successfully` });
  } catch (error) {
    console.error('Delete numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// My ID Numbers — unchanged
app.post('/api/user/my-id-numbers', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const purchasedSnapshot = await db.collection('users').doc(userId).collection('purchased')
      .where('status', '==', 'active').where('type', '==', 'id').orderBy('purchasedAt', 'desc').get();
    const numbers = [];
    purchasedSnapshot.forEach(doc => numbers.push({ id: doc.id, ...doc.data() }));
    res.json({ numbers });
  } catch (error) {
    console.error('Get my ID numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete ID Number — unchanged
app.post('/api/user/delete-id-number', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const { numberId } = req.body;
    if (!numberId) return res.status(400).json({ error: 'numberId required' });

    const numberRef = db.collection('users').doc(userId).collection('purchased').doc(numberId);
    const numberDoc = await numberRef.get();
    if (!numberDoc.exists) return res.status(404).json({ error: 'ID number not found' });

    await numberRef.update({ status: 'deleted', deletedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete ID number error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete ID Numbers — unchanged
app.post('/api/user/delete-id-numbers', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const { numberIds } = req.body;
    if (!numberIds || !Array.isArray(numberIds) || numberIds.length === 0) {
      return res.status(400).json({ error: 'numberIds array required' });
    }

    const batch = db.batch();
    for (const numberId of numberIds) {
      batch.update(db.collection('users').doc(userId).collection('purchased').doc(numberId), {
        status: 'deleted', deletedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    await batch.commit();
    res.json({ success: true, message: `${numberIds.length} ID numbers deleted successfully` });
  } catch (error) {
    console.error('Delete ID numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// Proxy — unchanged
// ============================================
const PROXY_ALLOWED_HOSTS = [
  'moon-usa-physical-number.vercel.app',
  'moonusaphysical.vercel.app',
  'moonusnumsphysical2.usanumbersdaily.workers.dev'
];

app.post('/api/proxy', generalLimiter, verifyToken, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    let parsed;
    try { parsed = new URL(url); } catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }

    if (parsed.protocol !== 'https:') return res.status(400).json({ error: 'Only HTTPS allowed' });
    if (!PROXY_ALLOWED_HOSTS.includes(parsed.hostname)) {
      return res.status(403).json({ error: 'URL not allowed' });
    }

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProxyBot/1.0)' },
      signal: AbortSignal.timeout(10000)
    });
    const contentType = response.headers.get('content-type');
    const data = await response.text();
    res.set('Content-Type', contentType || 'text/html');
    res.send(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

// ============================================
// ==================== ADMIN ENDPOINTS ====================
// ============================================

// Admin Combined Dashboard (now with tiktok stats)
app.post('/api/admin/combined-dashboard', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const counters = await getCachedAdminCounters();
    const numbersQuery = await db.collection('numbers').orderBy('createdAt', 'desc').limit(30).get();
    const numbers = [];
    numbersQuery.forEach(doc => numbers.push({ id: doc.id, ...doc.data() }));

    const usersQuery = await db.collection('users').orderBy('createdAt', 'desc').limit(30).get();
    const users = [];
    usersQuery.forEach(doc => users.push({
      id: doc.id, email: doc.data().email, balance: doc.data().balance || 0,
      role: doc.data().role || 'user', createdAt: doc.data().createdAt
    }));

    res.json({
      success: true,
      totalUsers: counters.totalUsers || 0,
      availableNumbers: counters.availableNumbers || 0,
      soldNumbers: counters.soldNumbers || 0,
      idAvailableNumbers: counters.idAvailableNumbers || 0,
      idSoldNumbers: counters.idSoldNumbers || 0,
      gmailAvailable: counters.gmailAvailable || 0,
      gmailSold: counters.gmailSold || 0,
      fbIdsAvailable: counters.fbIdsAvailable || 0,
      fbIdsSold: counters.fbIdsSold || 0,
      tiktokAvailable: counters.tiktokAvailable || 0,
      tiktokSold: counters.tiktokSold || 0,
      numbers, users
    });
  } catch (error) {
    console.error('Admin combined error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin Dashboard Stats (now with tiktok)
app.post('/api/admin/dashboard', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const counters = await getCachedAdminCounters();
    res.json({
      totalUsers: counters.totalUsers || 0,
      availableNumbers: counters.availableNumbers || 0,
      soldNumbers: counters.soldNumbers || 0,
      idAvailableNumbers: counters.idAvailableNumbers || 0,
      idSoldNumbers: counters.idSoldNumbers || 0,
      gmailAvailable: counters.gmailAvailable || 0,
      gmailSold: counters.gmailSold || 0,
      fbIdsAvailable: counters.fbIdsAvailable || 0,
      fbIdsSold: counters.fbIdsSold || 0,
      tiktokAvailable: counters.tiktokAvailable || 0,
      tiktokSold: counters.tiktokSold || 0
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Recompute counters — unchanged
app.post('/api/admin/recompute-counters', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const counters = await updateAdminCounters();
    res.json({ success: true, counters });
  } catch (error) {
    console.error('Recompute counters error:', error);
    res.status(500).json({ error: 'Failed to recompute counters' });
  }
});

// ============================================
// Admin: Add Numbers (Verification) — unchanged
// ============================================
app.post('/api/admin/add-numbers', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { numbersText, price } = req.body;
    if (!numbersText || !price) return res.status(400).json({ error: 'Numbers text and price required' });

    const lines = numbersText.trim().split('\n');
    const batch = db.batch();
    let addedCount = 0;
    const priceStr = price.toString();
    const priceCountRef = db.collection('priceCounts').doc(priceStr);

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || !trimmedLine.includes('|')) continue;
      const parts = trimmedLine.split('|');
      const number = parts[0]?.trim();
      const apiUrl = parts[1]?.trim();
      if (!number || !apiUrl) continue;
      batch.set(db.collection('numbers').doc(), {
        number, apiUrl, price: priceStr, status: 'available',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      addedCount++;
    }
    if (addedCount === 0) return res.status(400).json({ error: 'No valid numbers found. Use format: number|apiUrl' });

    batch.set(priceCountRef, {
      availableCount: admin.firestore.FieldValue.increment(addedCount),
      soldCount: admin.firestore.FieldValue.increment(0)
    }, { merge: true });

    await batch.commit();
    await incrementCounters({
      availableNumbers: admin.firestore.FieldValue.increment(addedCount)
    });
    cache.timestamp = 0;
    res.json({ success: true, addedCount, message: `${addedCount} numbers added successfully at PKR ${price}` });
  } catch (error) {
    console.error('Add numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Numbers (paginated) — unchanged
app.post('/api/admin/numbers', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { status, lastDocId } = req.body;
    let query = db.collection('numbers').orderBy('createdAt', 'desc').limit(30);
    if (status && status !== 'all') query = query.where('status', '==', status);
    if (lastDocId) {
      const lastDoc = await db.collection('numbers').doc(lastDocId).get();
      query = query.startAfter(lastDoc);
    }
    const snapshot = await query.get();
    const numbers = [];
    let lastId = null;
    snapshot.forEach(doc => { numbers.push({ id: doc.id, ...doc.data() }); lastId = doc.id; });
    res.json({ numbers, lastDocId: lastId, hasMore: numbers.length === 30 });
  } catch (error) {
    console.error('Get numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete Numbers — unchanged
app.post('/api/admin/delete-numbers', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { numberIds, deleteAllSold } = req.body;
    if (deleteAllSold) {
      const soldSnapshot = await db.collection('numbers').where('status', '==', 'sold').get();
      const batch = db.batch();
      let deletedCount = 0;
      soldSnapshot.forEach(doc => { batch.delete(doc.ref); deletedCount++; });
      if (deletedCount > 0) await batch.commit();
      await incrementCounters({ soldNumbers: admin.firestore.FieldValue.increment(-deletedCount) });
      cache.timestamp = 0;
      return res.json({ success: true, message: `${deletedCount} sold numbers deleted` });
    } else if (numberIds && numberIds.length > 0) {
      const BATCH_SIZE = 10;
      const results = { totalDeleted: 0, priceUpdates: {} };
      for (let i = 0; i < numberIds.length; i += BATCH_SIZE) {
        const batch = db.batch();
        const chunk = numberIds.slice(i, i + BATCH_SIZE);
        const priceUpdatesInChunk = {};
        for (const id of chunk) {
          const numberDoc = await db.collection('numbers').doc(id).get();
          if (numberDoc.exists) {
            const numberData = numberDoc.data();
            if (numberData.status === 'available') {
              const price = numberData.price.toString();
              priceUpdatesInChunk[price] = (priceUpdatesInChunk[price] || 0) + 1;
            }
            batch.delete(numberDoc.ref);
            results.totalDeleted++;
          }
        }
        for (const [price, count] of Object.entries(priceUpdatesInChunk)) {
          const priceCountRef = db.collection('priceCounts').doc(price);
          const priceCountDoc = await priceCountRef.get();
          if (priceCountDoc.exists) {
            const currentCount = priceCountDoc.data().availableCount || 0;
            if (currentCount >= count) {
              batch.set(priceCountRef, { availableCount: admin.firestore.FieldValue.increment(-count) }, { merge: true });
              results.priceUpdates[price] = (results.priceUpdates[price] || 0) + count;
            } else {
              batch.set(priceCountRef, { availableCount: 0 }, { merge: true });
            }
          } else {
            batch.set(priceCountRef, { availableCount: 0, soldCount: 0 });
          }
        }
        await batch.commit();
      }
      cache.timestamp = 0;
      return res.json({
        success: true,
        message: `${results.totalDeleted} numbers deleted successfully`,
        priceUpdates: results.priceUpdates
      });
    } else {
      return res.status(400).json({ error: 'No numbers specified' });
    }
  } catch (error) {
    console.error('Delete numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// Admin: Add ID Numbers — unchanged
// ============================================
app.post('/api/admin/add-id-numbers', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { numbersText, price } = req.body;
    if (!numbersText || !price) return res.status(400).json({ error: 'Numbers text and price required' });

    const lines = numbersText.trim().split('\n');
    const batch = db.batch();
    let addedCount = 0;
    const priceStr = price.toString();
    const priceCountRef = db.collection('idPriceCounts').doc(priceStr);

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || !trimmedLine.includes('|')) continue;
      const parts = trimmedLine.split('|');
      const number = parts[0]?.trim();
      const apiUrl = parts[1]?.trim();
      if (!number || !apiUrl) continue;
      batch.set(db.collection('idNumbers').doc(), {
        number, apiUrl, price: priceStr, status: 'available',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      addedCount++;
    }
    if (addedCount === 0) return res.status(400).json({ error: 'No valid ID numbers found. Use format: number|apiUrl' });

    batch.set(priceCountRef, {
      availableCount: admin.firestore.FieldValue.increment(addedCount),
      soldCount: admin.firestore.FieldValue.increment(0)
    }, { merge: true });

    await batch.commit();
    await incrementCounters({
      idAvailableNumbers: admin.firestore.FieldValue.increment(addedCount)
    });
    cache.timestamp = 0;
    res.json({ success: true, addedCount, message: `${addedCount} ID numbers added successfully at PKR ${price}` });
  } catch (error) {
    console.error('Add ID numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get ID Numbers — unchanged
app.post('/api/admin/id-numbers', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { status, lastDocId, limit } = req.body;
    const pageLimit = limit || 100;
    let query = db.collection('idNumbers').orderBy('createdAt', 'desc').limit(pageLimit);
    if (status && status !== 'all') query = query.where('status', '==', status);
    if (lastDocId) {
      const lastDoc = await db.collection('idNumbers').doc(lastDocId).get();
      query = query.startAfter(lastDoc);
    }
    const snapshot = await query.get();
    const numbers = [];
    let lastId = null;
    snapshot.forEach(doc => { numbers.push({ id: doc.id, ...doc.data() }); lastId = doc.id; });
    res.json({ numbers, lastDocId: lastId, hasMore: numbers.length === pageLimit });
  } catch (error) {
    console.error('Get ID numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete ID Numbers — unchanged
app.post('/api/admin/delete-id-numbers', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { numberIds, deleteAllSold } = req.body;
    if (deleteAllSold) {
      const soldSnapshot = await db.collection('idNumbers').where('status', '==', 'sold').get();
      const batch = db.batch();
      let deletedCount = 0;
      soldSnapshot.forEach(doc => { batch.delete(doc.ref); deletedCount++; });
      if (deletedCount > 0) await batch.commit();
      await incrementCounters({ idSoldNumbers: admin.firestore.FieldValue.increment(-deletedCount) });
      cache.timestamp = 0;
      return res.json({ success: true, message: `${deletedCount} sold ID numbers deleted` });
    } else if (numberIds && numberIds.length > 0) {
      const BATCH_SIZE = 10;
      const results = { totalDeleted: 0, priceUpdates: {} };
      for (let i = 0; i < numberIds.length; i += BATCH_SIZE) {
        const batch = db.batch();
        const chunk = numberIds.slice(i, i + BATCH_SIZE);
        const priceUpdatesInChunk = {};
        for (const id of chunk) {
          const numberDoc = await db.collection('idNumbers').doc(id).get();
          if (numberDoc.exists) {
            const numberData = numberDoc.data();
            if (numberData.status === 'available') {
              const price = numberData.price.toString();
              priceUpdatesInChunk[price] = (priceUpdatesInChunk[price] || 0) + 1;
            }
            batch.delete(numberDoc.ref);
            results.totalDeleted++;
          }
        }
        for (const [price, count] of Object.entries(priceUpdatesInChunk)) {
          const priceCountRef = db.collection('idPriceCounts').doc(price);
          const priceCountDoc = await priceCountRef.get();
          if (priceCountDoc.exists) {
            const currentCount = priceCountDoc.data().availableCount || 0;
            if (currentCount >= count) {
              batch.set(priceCountRef, { availableCount: admin.firestore.FieldValue.increment(-count) }, { merge: true });
              results.priceUpdates[price] = (results.priceUpdates[price] || 0) + count;
            } else {
              batch.set(priceCountRef, { availableCount: 0 }, { merge: true });
            }
          } else {
            batch.set(priceCountRef, { availableCount: 0, soldCount: 0 });
          }
        }
        await batch.commit();
      }
      cache.timestamp = 0;
      return res.json({
        success: true,
        message: `${results.totalDeleted} ID numbers deleted successfully`,
        priceUpdates: results.priceUpdates
      });
    } else {
      return res.status(400).json({ error: 'No ID numbers specified' });
    }
  } catch (error) {
    console.error('Delete ID numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// Admin: Add Gmails — unchanged
// ============================================
app.post('/api/admin/add-gmails', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { gmailsText, price } = req.body;
    if (!gmailsText || !price) return res.status(400).json({ error: 'Gmails text and price required' });

    const lines = gmailsText.trim().split('\n');
    const batch = db.batch();
    let addedCount = 0;
    const priceStr = price.toString();
    const priceCountRef = db.collection('gmailPriceCounts').doc(priceStr);

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || !trimmedLine.includes('|')) continue;
      const parts = trimmedLine.split('|');
      const gmail = parts[0]?.trim();
      const password = parts[1]?.trim();
      if (!gmail || !password) continue;
      batch.set(db.collection('gmails').doc(), {
        gmail, password, price: priceStr, status: 'available',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      addedCount++;
    }
    if (addedCount === 0) return res.status(400).json({ error: 'No valid gmails found. Use format: gmail|password' });

    batch.set(priceCountRef, {
      availableCount: admin.firestore.FieldValue.increment(addedCount),
      soldCount: admin.firestore.FieldValue.increment(0)
    }, { merge: true });

    await batch.commit();
    await incrementCounters({
      gmailAvailable: admin.firestore.FieldValue.increment(addedCount)
    });
    cache.timestamp = 0;
    res.json({ success: true, addedCount, message: `${addedCount} gmails added successfully at PKR ${price}` });
  } catch (error) {
    console.error('Add gmails error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manage Gmails — unchanged
app.post('/api/admin/manage-gmails', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { status, lastDocId, limit } = req.body;
    const pageLimit = limit || 50;
    let query = db.collection('gmails').orderBy('createdAt', 'desc').limit(pageLimit);
    if (status && status !== 'all') query = query.where('status', '==', status);
    if (lastDocId) {
      const lastDoc = await db.collection('gmails').doc(lastDocId).get();
      if (lastDoc.exists) query = query.startAfter(lastDoc);
    }
    const snapshot = await query.get();
    const gmails = [];
    let lastId = null;
    snapshot.forEach(doc => {
      const d = doc.data();
      gmails.push({
        id: doc.id,
        gmail: d.gmail,
        password: d.status === 'sold' ? '••••••••' : d.password,
        price: d.price,
        status: d.status,
        soldTo: d.soldTo || null,
        createdAt: d.createdAt
      });
      lastId = doc.id;
    });
    res.json({ gmails, lastDocId: lastId, hasMore: gmails.length === pageLimit });
  } catch (error) {
    console.error('Manage gmails error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete Gmails — unchanged
app.post('/api/admin/delete-gmails', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { gmailIds, deleteAllSold } = req.body;

    if (deleteAllSold) {
      const soldSnapshot = await db.collection('gmails').where('status', '==', 'sold').get();
      const batch = db.batch();
      let deletedCount = 0;
      soldSnapshot.forEach(doc => { batch.delete(doc.ref); deletedCount++; });
      if (deletedCount > 0) await batch.commit();
      await incrementCounters({ gmailSold: admin.firestore.FieldValue.increment(-deletedCount) });
      cache.timestamp = 0;
      return res.json({ success: true, message: `${deletedCount} sold gmails deleted` });
    }

    if (!gmailIds || !Array.isArray(gmailIds) || gmailIds.length === 0) {
      return res.status(400).json({ error: 'No gmails specified' });
    }

    const BATCH_SIZE = 10;
    let totalDeleted = 0;
    const priceUpdates = {};

    for (let i = 0; i < gmailIds.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = gmailIds.slice(i, i + BATCH_SIZE);
      const priceUpdatesInChunk = {};

      for (const id of chunk) {
        const gmailDoc = await db.collection('gmails').doc(id).get();
        if (gmailDoc.exists) {
          const d = gmailDoc.data();
          if (d.status === 'available') {
            const price = d.price.toString();
            priceUpdatesInChunk[price] = (priceUpdatesInChunk[price] || 0) + 1;
          }
          batch.delete(gmailDoc.ref);
          totalDeleted++;
        }
      }

      for (const [price, count] of Object.entries(priceUpdatesInChunk)) {
        const priceCountRef = db.collection('gmailPriceCounts').doc(price);
        batch.set(priceCountRef, { availableCount: admin.firestore.FieldValue.increment(-count) }, { merge: true });
        priceUpdates[price] = (priceUpdates[price] || 0) + count;
      }

      await batch.commit();
    }

    cache.timestamp = 0;
    res.json({ success: true, message: `${totalDeleted} gmails deleted successfully`, priceUpdates });
  } catch (error) {
    console.error('Delete gmails error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// Admin: Add FB IDs — unchanged
// ============================================
app.post('/api/admin/add-fb-ids', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { fbIdsText, price, type } = req.body;
    if (!fbIdsText || !price || !type) return res.status(400).json({ error: 'FB IDs text, price, and type required' });
    if (!['simple', 'marketplace'].includes(type)) {
      return res.status(400).json({ error: 'Type must be simple or marketplace' });
    }

    const lines = fbIdsText.trim().split('\n');
    const batch = db.batch();
    let addedCount = 0;
    const priceStr = price.toString();
    const priceCountRef = db.collection('fbIdPriceCounts').doc(`${type}_${priceStr}`);

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || !trimmedLine.includes('|')) continue;
      const parts = trimmedLine.split('|');
      const uid = parts[0]?.trim();
      const password = parts[1]?.trim();
      const twoFA = parts[2]?.trim() || null;
      if (!uid || !password) continue;

      batch.set(db.collection('fbIds').doc(), {
        uid, password, twoFA, type, price: priceStr, status: 'available',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      addedCount++;
    }
    if (addedCount === 0) return res.status(400).json({ error: 'No valid FB IDs found. Use format: uid|password or uid|password|2fa' });

    batch.set(priceCountRef, {
      type,
      price: priceStr,
      availableCount: admin.firestore.FieldValue.increment(addedCount),
      soldCount: admin.firestore.FieldValue.increment(0)
    }, { merge: true });

    await batch.commit();
    await incrementCounters({
      fbIdsAvailable: admin.firestore.FieldValue.increment(addedCount)
    });
    cache.timestamp = 0;
    res.json({ success: true, addedCount, message: `${addedCount} ${type} FB IDs added successfully at PKR ${price}` });
  } catch (error) {
    console.error('Add fb ids error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manage FB IDs — unchanged
app.post('/api/admin/manage-fb-ids', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { status, type, lastDocId, limit } = req.body;
    const pageLimit = limit || 50;
    let query = db.collection('fbIds').orderBy('createdAt', 'desc').limit(pageLimit);
    if (status && status !== 'all') query = query.where('status', '==', status);
    if (type && type !== 'all') query = query.where('type', '==', type);
    if (lastDocId) {
      const lastDoc = await db.collection('fbIds').doc(lastDocId).get();
      if (lastDoc.exists) query = query.startAfter(lastDoc);
    }
    const snapshot = await query.get();
    const fbIds = [];
    let lastId = null;
    snapshot.forEach(doc => {
      const d = doc.data();
      fbIds.push({
        id: doc.id,
        uid: d.uid,
        password: d.status === 'sold' ? '••••••••' : d.password,
        twoFA: d.status === 'sold' ? (d.twoFA ? '••••' : '') : (d.twoFA || ''),
        type: d.type,
        price: d.price,
        status: d.status,
        soldTo: d.soldTo || null,
        createdAt: d.createdAt
      });
      lastId = doc.id;
    });
    res.json({ fbIds, lastDocId: lastId, hasMore: fbIds.length === pageLimit });
  } catch (error) {
    console.error('Manage fb ids error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete FB IDs — unchanged
app.post('/api/admin/delete-fb-ids', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { fbIdIds, deleteAllSold } = req.body;

    if (deleteAllSold) {
      const soldSnapshot = await db.collection('fbIds').where('status', '==', 'sold').get();
      const batch = db.batch();
      let deletedCount = 0;
      soldSnapshot.forEach(doc => { batch.delete(doc.ref); deletedCount++; });
      if (deletedCount > 0) await batch.commit();
      await incrementCounters({ fbIdsSold: admin.firestore.FieldValue.increment(-deletedCount) });
      cache.timestamp = 0;
      return res.json({ success: true, message: `${deletedCount} sold FB IDs deleted` });
    }

    if (!fbIdIds || !Array.isArray(fbIdIds) || fbIdIds.length === 0) {
      return res.status(400).json({ error: 'No FB IDs specified' });
    }

    const BATCH_SIZE = 10;
    let totalDeleted = 0;
    const priceUpdates = {};

    for (let i = 0; i < fbIdIds.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = fbIdIds.slice(i, i + BATCH_SIZE);
      const priceUpdatesInChunk = {};

      for (const id of chunk) {
        const fbDoc = await db.collection('fbIds').doc(id).get();
        if (fbDoc.exists) {
          const d = fbDoc.data();
          if (d.status === 'available') {
            const key = `${d.type}_${d.price}`;
            priceUpdatesInChunk[key] = (priceUpdatesInChunk[key] || 0) + 1;
          }
          batch.delete(fbDoc.ref);
          totalDeleted++;
        }
      }

      for (const [key, count] of Object.entries(priceUpdatesInChunk)) {
        const priceCountRef = db.collection('fbIdPriceCounts').doc(key);
        batch.set(priceCountRef, { availableCount: admin.firestore.FieldValue.increment(-count) }, { merge: true });
        priceUpdates[key] = (priceUpdates[key] || 0) + count;
      }

      await batch.commit();
    }

    cache.timestamp = 0;
    res.json({ success: true, message: `${totalDeleted} FB IDs deleted successfully`, priceUpdates });
  } catch (error) {
    console.error('Delete fb ids error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// ✅ NEW Admin: Add UK TikTok Accounts
// Format: gmail|gmailPassword|tiktokGmail|tiktokPassword
// ============================================
app.post('/api/admin/add-tiktok', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { tiktokText, price } = req.body;
    if (!tiktokText || !price) return res.status(400).json({ error: 'TikTok text and price required' });

    const lines = tiktokText.trim().split('\n');
    const batch = db.batch();
    let addedCount = 0;
    const priceStr = price.toString();
    const priceCountRef = db.collection('tiktokPriceCounts').doc(priceStr);

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || !trimmedLine.includes('|')) continue;
      const parts = trimmedLine.split('|');
      const gmail = parts[0]?.trim();
      const gmailPassword = parts[1]?.trim();
      const tiktokGmail = parts[2]?.trim();
      const tiktokPassword = parts[3]?.trim();
      if (!gmail || !gmailPassword || !tiktokGmail || !tiktokPassword) continue;

      batch.set(db.collection('tiktokAccounts').doc(), {
        gmail, gmailPassword, tiktokGmail, tiktokPassword,
        price: priceStr, status: 'available',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      addedCount++;
    }
    if (addedCount === 0) return res.status(400).json({ error: 'No valid TikTok accounts found. Use format: gmail|gmailPassword|tiktokGmail|tiktokPassword' });

    batch.set(priceCountRef, {
      availableCount: admin.firestore.FieldValue.increment(addedCount),
      soldCount: admin.firestore.FieldValue.increment(0)
    }, { merge: true });

    await batch.commit();
    await incrementCounters({
      tiktokAvailable: admin.firestore.FieldValue.increment(addedCount)
    });
    cache.timestamp = 0;
    res.json({ success: true, addedCount, message: `${addedCount} TikTok accounts added successfully at PKR ${price}` });
  } catch (error) {
    console.error('Add tiktok error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manage TikTok — list
app.post('/api/admin/manage-tiktok', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { status, lastDocId, limit } = req.body;
    const pageLimit = limit || 50;
    let query = db.collection('tiktokAccounts').orderBy('createdAt', 'desc').limit(pageLimit);
    if (status && status !== 'all') query = query.where('status', '==', status);
    if (lastDocId) {
      const lastDoc = await db.collection('tiktokAccounts').doc(lastDocId).get();
      if (lastDoc.exists) query = query.startAfter(lastDoc);
    }
    const snapshot = await query.get();
    const accounts = [];
    let lastId = null;
    snapshot.forEach(doc => {
      const d = doc.data();
      const sold = d.status === 'sold';
      accounts.push({
        id: doc.id,
        gmail: d.gmail,
        gmailPassword: sold ? '••••••••' : d.gmailPassword,
        tiktokGmail: d.tiktokGmail,
        tiktokPassword: sold ? '••••••••' : d.tiktokPassword,
        price: d.price,
        status: d.status,
        soldTo: d.soldTo || null,
        createdAt: d.createdAt
      });
      lastId = doc.id;
    });
    res.json({ accounts, lastDocId: lastId, hasMore: accounts.length === pageLimit });
  } catch (error) {
    console.error('Manage tiktok error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete TikTok — bulk or specific
app.post('/api/admin/delete-tiktok', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { tiktokIds, deleteAllSold } = req.body;

    if (deleteAllSold) {
      const soldSnapshot = await db.collection('tiktokAccounts').where('status', '==', 'sold').get();
      const batch = db.batch();
      let deletedCount = 0;
      soldSnapshot.forEach(doc => { batch.delete(doc.ref); deletedCount++; });
      if (deletedCount > 0) await batch.commit();
      await incrementCounters({ tiktokSold: admin.firestore.FieldValue.increment(-deletedCount) });
      cache.timestamp = 0;
      return res.json({ success: true, message: `${deletedCount} sold TikTok accounts deleted` });
    }

    if (!tiktokIds || !Array.isArray(tiktokIds) || tiktokIds.length === 0) {
      return res.status(400).json({ error: 'No TikTok accounts specified' });
    }

    const BATCH_SIZE = 10;
    let totalDeleted = 0;
    const priceUpdates = {};

    for (let i = 0; i < tiktokIds.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = tiktokIds.slice(i, i + BATCH_SIZE);
      const priceUpdatesInChunk = {};

      for (const id of chunk) {
        const doc = await db.collection('tiktokAccounts').doc(id).get();
        if (doc.exists) {
          const d = doc.data();
          if (d.status === 'available') {
            const price = d.price.toString();
            priceUpdatesInChunk[price] = (priceUpdatesInChunk[price] || 0) + 1;
          }
          batch.delete(doc.ref);
          totalDeleted++;
        }
      }

      for (const [price, count] of Object.entries(priceUpdatesInChunk)) {
        const priceCountRef = db.collection('tiktokPriceCounts').doc(price);
        batch.set(priceCountRef, { availableCount: admin.firestore.FieldValue.increment(-count) }, { merge: true });
        priceUpdates[price] = (priceUpdates[price] || 0) + count;
      }

      await batch.commit();
    }

    cache.timestamp = 0;
    res.json({ success: true, message: `${totalDeleted} TikTok accounts deleted successfully`, priceUpdates });
  } catch (error) {
    console.error('Delete tiktok error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// Admin: Generate Coupons — unchanged
// ============================================
app.post('/api/admin/generate-coupons', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { count, discountPerNumber, type } = req.body;

    if (!count || !Number.isInteger(count) || count < 1 || count > 100) {
      return res.status(400).json({ error: 'Count must be between 1 and 100' });
    }
    if (!discountPerNumber || isNaN(discountPerNumber) || discountPerNumber <= 0) {
      return res.status(400).json({ error: 'Discount per number must be a positive number' });
    }
    if (!type || !['verification', 'id'].includes(type)) {
      return res.status(400).json({ error: 'Type must be verification or id' });
    }

    const batch = db.batch();
    const generatedCoupons = [];
    const usedCodes = new Set();
    let attempts = 0;

    while (generatedCoupons.length < count && attempts < count * 5) {
      attempts++;
      const code = generateCouponCode();
      if (usedCodes.has(code)) continue;

      const couponRef = db.collection('coupons').doc(code);
      const existing = await couponRef.get();
      if (existing.exists) continue;

      batch.set(couponRef, {
        code,
        discountPerNumber: parseInt(discountPerNumber),
        type,
        usedBy: null,
        usedAt: null,
        totalUses: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      generatedCoupons.push({
        code,
        discountPerNumber: parseInt(discountPerNumber),
        type
      });
      usedCodes.add(code);
    }

    if (generatedCoupons.length === 0) {
      return res.status(500).json({ error: 'Failed to generate coupons. Please retry.' });
    }

    await batch.commit();

    res.json({
      success: true,
      count: generatedCoupons.length,
      coupons: generatedCoupons,
      message: `${generatedCoupons.length} coupons generated successfully`
    });
  } catch (error) {
    console.error('Generate coupons error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List Coupons — unchanged
app.post('/api/admin/list-coupons', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { status, type, lastDocId, limit } = req.body;
    const pageLimit = limit || 100;

    let query = db.collection('coupons').orderBy('createdAt', 'desc').limit(pageLimit);
    if (type && type !== 'all') query = query.where('type', '==', type);

    if (status === 'used') {
      query = query.where('totalUses', '>', 0);
    } else if (status === 'unused') {
      query = query.where('totalUses', '==', 0);
    }

    if (lastDocId) {
      const lastDoc = await db.collection('coupons').doc(lastDocId).get();
      if (lastDoc.exists) query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    const coupons = [];
    let lastId = null;

    snapshot.forEach(doc => {
      const d = doc.data();
      coupons.push({
        id: doc.id,
        code: d.code,
        discountPerNumber: d.discountPerNumber,
        type: d.type,
        usedBy: d.usedBy || null,
        usedAt: d.usedAt || null,
        totalUses: d.totalUses || 0,
        createdAt: d.createdAt
      });
      lastId = doc.id;
    });

    res.json({ coupons, lastDocId: lastId, hasMore: coupons.length === pageLimit });
  } catch (error) {
    console.error('List coupons error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete Coupons — unchanged
app.post('/api/admin/delete-coupons', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { couponCodes, deleteAllUsed } = req.body;

    if (deleteAllUsed) {
      const usedSnapshot = await db.collection('coupons').where('totalUses', '>', 0).get();
      const batch = db.batch();
      let deletedCount = 0;
      usedSnapshot.forEach(doc => { batch.delete(doc.ref); deletedCount++; });
      if (deletedCount > 0) await batch.commit();
      return res.json({ success: true, message: `${deletedCount} used coupons deleted` });
    }

    if (!couponCodes || !Array.isArray(couponCodes) || couponCodes.length === 0) {
      return res.status(400).json({ error: 'No coupons specified' });
    }

    const batch = db.batch();
    let deletedCount = 0;
    for (const code of couponCodes) {
      const ref = db.collection('coupons').doc(code);
      const doc = await ref.get();
      if (doc.exists) {
        batch.delete(ref);
        deletedCount++;
      }
    }
    if (deletedCount > 0) await batch.commit();

    res.json({ success: true, message: `${deletedCount} coupons deleted` });
  } catch (error) {
    console.error('Delete coupons error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// Admin: Add Balance — unchanged
// ============================================
app.post('/api/admin/add-balance', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { email, amount } = req.body;

    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email required' });
    if (!amount || !Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive integer' });
    }
    if (amount > 1000000) return res.status(400).json({ error: 'Amount too large' });

    const emailLower = email.toLowerCase().trim();
    const snapshot = await db.collection('users').where('email', '==', emailLower).limit(1).get();
    if (snapshot.empty) return res.status(404).json({ error: 'User not found' });

    const userDoc = snapshot.docs[0];
    const userId = userDoc.id;
    const userData = userDoc.data();

    const newBalance = (userData.balance || 0) + amount;

    await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(amount)
      });

      const historyRef = db.collection('users').doc(userId).collection('history').doc();
      transaction.set(historyRef, {
        type: 'deposit',
        details: `Balance added by admin (${emailLower})`,
        amount: amount,
        balanceAfter: newBalance,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    res.json({
      success: true,
      message: `${amount} PKR added to ${emailLower}`,
      newBalance: newBalance
    });
  } catch (error) {
    console.error('Add balance error:', error);
    res.status(500).json({ error: 'Failed to add balance' });
  }
});

// ============================================
// Admin: Users — unchanged
// ============================================
app.post('/api/admin/users', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { lastDocId, searchEmail } = req.body;
    if (searchEmail) {
      const snapshot = await db.collection('users').where('email', '==', searchEmail.toLowerCase().trim()).limit(1).get();
      const users = [];
      snapshot.forEach(doc => users.push({
        id: doc.id, email: doc.data().email, balance: doc.data().balance || 0,
        role: doc.data().role || 'user', createdAt: doc.data().createdAt
      }));
      return res.json({ users, lastDocId: null, hasMore: false });
    }
    let query = db.collection('users').orderBy('createdAt', 'desc').limit(30);
    if (lastDocId) {
      const lastDoc = await db.collection('users').doc(lastDocId).get();
      query = query.startAfter(lastDoc);
    }
    const snapshot = await query.get();
    const users = [];
    let lastId = null;
    snapshot.forEach(doc => {
      users.push({
        id: doc.id, email: doc.data().email, balance: doc.data().balance || 0,
        role: doc.data().role || 'user', createdAt: doc.data().createdAt
      });
      lastId = doc.id;
    });
    res.json({ users, lastDocId: lastId, hasMore: users.length === 30 });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update User Balance — unchanged
app.post('/api/admin/update-user-balance', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { userId, newBalance } = req.body;
    if (!userId || newBalance === undefined) return res.status(400).json({ error: 'UserId and newBalance required' });
    if (isNaN(parseInt(newBalance)) || parseInt(newBalance) < 0) return res.status(400).json({ error: 'Invalid balance value' });
    await db.collection('users').doc(userId).update({ balance: parseInt(newBalance) });
    res.json({ success: true });
  } catch (error) {
    console.error('Update balance error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete User — unchanged (purchased subcollection already handled)
app.post('/api/admin/delete-user', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'UserId required' });

    for (const sub of ['purchased', 'transfers', 'history', 'orders']) {
      const subSnap = await db.collection('users').doc(userId).collection(sub).limit(500).get();
      if (!subSnap.empty) {
        const batch = db.batch();
        subSnap.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      }
    }

    const batch = db.batch();
    batch.delete(db.collection('users').doc(userId));
    await batch.commit();

    try { await auth.deleteUser(userId); } catch (authError) { console.error('Auth deletion error:', authError); }

    await updateAdminCounters();
    cache.timestamp = 0;
    res.json({ success: true });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// Health, Version, Root
// ============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    firebase: admin.apps.length > 0 ? 'connected' : 'disconnected',
    version: '7.0.0'
  });
});

app.get('/api/version', (req, res) => {
  res.json({ version: '7.0.0', timestamp: Date.now() });
});

app.get('/', (req, res) => {
  res.json({ message: 'USA Nums by Moon API', version: '7.0.0' });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
