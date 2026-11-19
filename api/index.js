// index.js - USA Nums by Moon API (Secured v6.0.0)
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
// ✅ SECURITY: CORS - Sirf apni site
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

// ============================================
// ✅ SECURITY: Body parser with size limit
// ============================================
app.use(express.json({ limit: '1mb' }));

// ============================================
// ✅ SECURITY: Security headers
// ============================================
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ============================================
// ✅ SECURITY: Rate limiters
// ============================================
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true, legacyHeaders: false,
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many admin login attempts. Please try again later.' },
  standardHeaders: true, legacyHeaders: false,
});

const transferLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: 'Too many transfer attempts. Please wait a moment.' },
  standardHeaders: true, legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true, legacyHeaders: false,
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
// Cache system (unchanged)
// ============================================
let cache = { priceCounts: null, idPriceCounts: null, adminCounters: null, timestamp: 0 };
const CACHE_TTL = 60000;

async function getCachedPriceCounts() {
  const now = Date.now();
  if (cache.priceCounts && cache.idPriceCounts && (now - cache.timestamp) < CACHE_TTL) {
    return { normal: cache.priceCounts, id: cache.idPriceCounts };
  }
  const [normalSnapshot, idSnapshot] = await Promise.all([
    db.collection('priceCounts').get(),
    db.collection('idPriceCounts').get()
  ]);
  const normal = {};
  normalSnapshot.forEach(doc => { normal[doc.id] = doc.data().availableCount || 0; });
  const id = {};
  idSnapshot.forEach(doc => { id[doc.id] = doc.data().availableCount || 0; });
  cache.priceCounts = normal;
  cache.idPriceCounts = id;
  cache.timestamp = now;
  return { normal, id };
}

async function getCachedAdminCounters() {
  const now = Date.now();
  if (cache.adminCounters && (now - cache.timestamp) < CACHE_TTL) return cache.adminCounters;
  const countersDoc = await db.collection('meta').doc('counters').get();
  if (countersDoc.exists) {
    const data = countersDoc.data();
    cache.adminCounters = data;
    cache.timestamp = now;
    return data;
  }
  const [usersCount, availableCount, soldCount, idAvailableCount, idSoldCount] = await Promise.all([
    db.collection('users').count().get(),
    db.collection('numbers').where('status', '==', 'available').count().get(),
    db.collection('numbers').where('status', '==', 'sold').count().get(),
    db.collection('idNumbers').where('status', '==', 'available').count().get(),
    db.collection('idNumbers').where('status', '==', 'sold').count().get()
  ]);
  const counters = {
    totalUsers: usersCount.data().count || 0,
    availableNumbers: availableCount.data().count || 0,
    soldNumbers: soldCount.data().count || 0,
    idAvailableNumbers: idAvailableCount.data().count || 0,
    idSoldNumbers: idSoldCount.data().count || 0,
    updatedAt: Date.now()
  };
  await db.collection('meta').doc('counters').set(counters);
  cache.adminCounters = counters;
  cache.timestamp = now;
  return counters;
}

async function updateAdminCounters() {
  const [usersCount, availableCount, soldCount, idAvailableCount, idSoldCount] = await Promise.all([
    db.collection('users').count().get(),
    db.collection('numbers').where('status', '==', 'available').count().get(),
    db.collection('numbers').where('status', '==', 'sold').count().get(),
    db.collection('idNumbers').where('status', '==', 'available').count().get(),
    db.collection('idNumbers').where('status', '==', 'sold').count().get()
  ]);
  const counters = {
    totalUsers: usersCount.data().count || 0,
    availableNumbers: availableCount.data().count || 0,
    soldNumbers: soldCount.data().count || 0,
    idAvailableNumbers: idAvailableCount.data().count || 0,
    idSoldNumbers: idSoldCount.data().count || 0,
    updatedAt: Date.now()
  };
  await db.collection('meta').doc('counters').set(counters);
  cache.adminCounters = counters;
  cache.timestamp = Date.now();
  return counters;
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

// ============================================
// ==================== AUTH ENDPOINTS ====================
// ============================================

// User Signup
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const normalizedEmail = email.toLowerCase().trim();

    let userRecord;
    try {
      userRecord = await auth.createUser({ email: normalizedEmail, password });
    } catch (e) {
      // ✅ SECURITY: Generic error (prevent email enumeration)
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
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await updateAdminCounters();

    // ✅ Get ID token for immediate login
    let idToken = null, refreshToken = null;
    try {
      const fetch = (await import('node-fetch')).default;
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

    const fetch = (await import('node-fetch')).default;
    const apiKey = process.env.FIREBASE_API_KEY;
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.toLowerCase().trim(), password, returnSecureToken: true })
    });
    const data = await response.json();

    if (!response.ok) {
      // ✅ SECURITY: Generic error (prevent enumeration)
      if (data.error?.message === 'QUOTA_EXCEEDED') {
        return res.status(429).json({ error: 'Too many login attempts. Please wait 1 hour.' });
      }
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    // Ensure user doc exists
    const userDoc = await db.collection('users').doc(data.localId).get();
    if (!userDoc.exists) {
      await db.collection('users').doc(data.localId).set({
        email: email.toLowerCase().trim(),
        balance: 0,
        role: 'user',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await updateAdminCounters();
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

// ✅ NEW: Token Refresh
app.post('/api/auth/refresh', authLimiter, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    const fetch = (await import('node-fetch')).default;
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

// Admin Login (uses admin-token header)
app.post('/api/admin/login', adminLoginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const adminToken = req.headers['admin-token'];

    if (!email || !password || !adminToken) {
      return res.status(400).json({ error: 'Email, password and admin token required' });
    }
    if (adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Invalid credentials' }); // ✅ generic
    }

    const fetch = (await import('node-fetch')).default;
    const apiKey = process.env.FIREBASE_API_KEY;
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.toLowerCase().trim(), password, returnSecureToken: true })
    });
    const data = await response.json();

    if (!response.ok) {
      // ✅ SECURITY: generic error
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
// ==================== USER ENDPOINTS (AUTH REQUIRED) ====================
// ============================================

// User Dashboard
app.post('/api/user/dashboard', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid; // ✅ TOKEN se, body se NAHI
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const userData = userDoc.data();

    const priceCounts = await getCachedPriceCounts();
    const priceList = Object.entries(priceCounts.normal)
      .filter(([_, count]) => count > 0)
      .map(([price, availableCount]) => ({ price, availableCount }))
      .sort((a, b) => parseInt(a.price) - parseInt(b.price));

    const bulkPricesDoc = await db.collection('settings').doc('bulkPrices').get();
    let bulkPrices = { normal_10: null, normal_20: null, id_10: null, id_20: null, id_50: null, id_100: null };
    if (bulkPricesDoc.exists) bulkPrices = bulkPricesDoc.data();

    res.json({ balance: userData.balance || 0, email: userData.email, priceList, bulkPrices });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Combined Dashboard
app.post('/api/user/combined-dashboard', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const userData = userDoc.data();

    const priceCounts = await getCachedPriceCounts();
    const normalPriceList = Object.entries(priceCounts.normal).filter(([_, c]) => c > 0)
      .map(([price, availableCount]) => ({ price, availableCount }))
      .sort((a, b) => parseInt(a.price) - parseInt(b.price));
    const idPriceList = Object.entries(priceCounts.id).filter(([_, c]) => c > 0)
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

    const bulkPricesDoc = await db.collection('settings').doc('bulkPrices').get();
    let bulkPrices = { normal_10: null, normal_20: null, id_10: null, id_20: null, id_50: null, id_100: null };
    if (bulkPricesDoc.exists) bulkPrices = bulkPricesDoc.data();

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
      success: true, balance: userData.balance || 0, email: userData.email || '',
      normalPriceList, idPriceList, myNumbers, myIdNumbers, bulkPrices, transfers
    });
  } catch (error) {
    console.error('Combined dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ✅ SECURITY: Transfer Balance — Sender from token, both directions block admin
app.post('/api/user/transfer-balance', transferLimiter, verifyToken, async (req, res) => {
  try {
    const senderUid = req.uid; // ✅ token se
    const { recipientEmail, amount } = req.body;

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

    // ✅ Block admin as sender
    if (senderData.role === 'admin') return res.status(403).json({ error: 'Admin accounts cannot use this endpoint' });

    // Self-transfer
    if (senderData.email.toLowerCase() === recipientEmail.toLowerCase().trim()) {
      return res.status(400).json({ error: 'Cannot transfer to yourself' });
    }

    if ((senderData.balance || 0) < amount) return res.status(400).json({ error: 'Insufficient balance' });

    // Find recipient
    const recipientSnapshot = await db.collection('users')
      .where('email', '==', recipientEmail.toLowerCase().trim()).limit(1).get();
    if (recipientSnapshot.empty) return res.status(404).json({ error: 'Recipient user not found' });

    const recipientDoc = recipientSnapshot.docs[0];
    const recipientId = recipientDoc.id;
    const recipientData = recipientDoc.data();

    // ✅ Block admin as recipient
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

// Transfer History
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

// Buy Number
app.post('/api/user/buy-number', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid; // ✅
    const { price } = req.body;
    if (!price) return res.status(400).json({ error: 'Price required' });
    const priceStr = price.toString();

    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      const userData = userDoc.data();
      if ((userData.balance || 0) < parseInt(priceStr)) throw new Error('Insufficient balance');

      const priceCountRef = db.collection('priceCounts').doc(priceStr);
      const priceCountDoc = await transaction.get(priceCountRef);
      if (!priceCountDoc.exists || priceCountDoc.data().availableCount === 0) {
        throw new Error('No numbers available at this price');
      }

      const numbersQuery = await db.collection('numbers')
        .where('price', '==', priceStr).where('status', '==', 'available').limit(1).get();
      if (numbersQuery.empty) throw new Error('No numbers available');

      const numberDoc = numbersQuery.docs[0];
      const numberData = numberDoc.data();

      transaction.update(numberDoc.ref, {
        status: 'sold', soldTo: userId, soldAt: admin.firestore.FieldValue.serverTimestamp()
      });
      transaction.update(priceCountRef, {
        availableCount: admin.firestore.FieldValue.increment(-1),
        soldCount: admin.firestore.FieldValue.increment(1)
      });
      transaction.update(userRef, { balance: admin.firestore.FieldValue.increment(-parseInt(priceStr)) });

      const userNumberRef = db.collection('users').doc(userId).collection('purchased').doc(numberDoc.id);
      transaction.set(userNumberRef, {
        number: numberData.number, apiUrl: numberData.apiUrl, price: priceStr,
        purchasedAt: admin.firestore.FieldValue.serverTimestamp(), status: 'active', type: 'normal'
      });

      return { numberId: numberDoc.id, number: numberData.number, apiUrl: numberData.apiUrl };
    });

    await updateAdminCounters();
    cache.timestamp = 0;
    res.json({ success: true, number: result.number, numberId: result.numberId, apiUrl: result.apiUrl });
  } catch (error) {
    console.error('Buy number error:', error);
    const msg = error?.message || '';
    if (msg.includes('Insufficient balance')) return res.status(400).json({ error: 'Insufficient balance' });
    if (msg.includes('No numbers available')) return res.status(400).json({ error: 'No numbers available at this price' });
    if (msg.includes('User not found')) return res.status(404).json({ error: 'User not found' });
    res.status(400).json({ error: 'Purchase failed' });
  }
});

// Bulk Buy Number
app.post('/api/user/bulk-buy-number', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const { quantity } = req.body;
    if (!quantity) return res.status(400).json({ error: 'Quantity required' });
    if (![10, 20].includes(quantity)) return res.status(400).json({ error: 'Quantity must be 10 or 20' });

    const bulkPricesDoc = await db.collection('settings').doc('bulkPrices').get();
    if (!bulkPricesDoc.exists) return res.status(400).json({ error: 'Bulk prices not set by admin' });
    const totalPrice = bulkPricesDoc.data()[`normal_${quantity}`];
    if (!totalPrice || totalPrice <= 0) return res.status(400).json({ error: `Bulk price for ${quantity} not set` });

    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      const currentBalance = userDoc.data().balance || 0;
      if (currentBalance < totalPrice) throw new Error(`Insufficient balance. Need ${totalPrice} PKR`);

      const numbersQuery = await db.collection('numbers').where('status', '==', 'available').limit(quantity).get();
      if (numbersQuery.size < quantity) throw new Error(`Only ${numbersQuery.size} numbers available`);

      const purchasedNumbers = [];
      const priceUpdates = {};
      for (const doc of numbersQuery.docs) {
        const numberData = doc.data();
        const price = numberData.price;
        transaction.update(doc.ref, { status: 'sold', soldTo: userId, soldAt: admin.firestore.FieldValue.serverTimestamp() });
        priceUpdates[price] = (priceUpdates[price] || 0) + 1;
        const userNumberRef = db.collection('users').doc(userId).collection('purchased').doc(doc.id);
        transaction.set(userNumberRef, {
          number: numberData.number, apiUrl: numberData.apiUrl, price,
          purchasedAt: admin.firestore.FieldValue.serverTimestamp(), status: 'active', type: 'normal',
          bulkPurchase: true, bulkQuantity: quantity
        });
        purchasedNumbers.push({ id: doc.id, number: numberData.number, apiUrl: numberData.apiUrl, price });
      }
      for (const [price, count] of Object.entries(priceUpdates)) {
        const priceCountRef = db.collection('priceCounts').doc(price);
        transaction.update(priceCountRef, {
          availableCount: admin.firestore.FieldValue.increment(-count),
          soldCount: admin.firestore.FieldValue.increment(count)
        });
      }
      transaction.update(userRef, { balance: admin.firestore.FieldValue.increment(-totalPrice) });
      return { purchasedNumbers, totalPrice, quantity: purchasedNumbers.length, newBalance: currentBalance - totalPrice };
    });

    await updateAdminCounters();
    cache.timestamp = 0;
    res.json({
      success: true, message: `${result.quantity} numbers purchased for ${result.totalPrice} PKR`,
      numbers: result.purchasedNumbers, quantity: result.quantity, totalPrice: result.totalPrice,
      newBalance: result.newBalance
    });
  } catch (error) {
    console.error('Bulk buy error:', error);
    const msg = error?.message || '';
    if (msg.includes('Insufficient balance')) return res.status(400).json({ error: msg });
    if (msg.includes('numbers available')) return res.status(400).json({ error: msg });
    if (msg.includes('User not found')) return res.status(404).json({ error: 'User not found' });
    res.status(400).json({ error: 'Purchase failed' });
  }
});

// My Numbers
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

// Delete Number (ownership automatic via path)
app.post('/api/user/delete-number', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const { numberId } = req.body;
    if (!numberId) return res.status(400).json({ error: 'numberId required' });

    const numberRef = db.collection('users').doc(userId).collection('purchased').doc(numberId);
    const numberDoc = await numberRef.get();
    if (!numberDoc.exists) return res.status(404).json({ error: 'Number not found' }); // ✅ ownership check via path

    await numberRef.update({ status: 'deleted', deletedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete number error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete Numbers
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

// ID Dashboard
app.post('/api/user/id-dashboard', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const userData = userDoc.data();

    const priceCounts = await getCachedPriceCounts();
    const priceList = Object.entries(priceCounts.id).filter(([_, c]) => c > 0)
      .map(([price, availableCount]) => ({ price, availableCount }))
      .sort((a, b) => parseInt(a.price) - parseInt(b.price));

    const bulkPricesDoc = await db.collection('settings').doc('bulkPrices').get();
    let bulkPrices = { normal_10: null, normal_20: null, id_10: null, id_20: null, id_50: null, id_100: null };
    if (bulkPricesDoc.exists) bulkPrices = bulkPricesDoc.data();

    res.json({ balance: userData.balance || 0, email: userData.email, priceList, bulkPrices });
  } catch (error) {
    console.error('ID Dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Buy ID Number
app.post('/api/user/buy-id-number', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const { price } = req.body;
    if (!price) return res.status(400).json({ error: 'Price required' });
    const priceStr = price.toString();

    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      if ((userDoc.data().balance || 0) < parseInt(priceStr)) throw new Error('Insufficient balance');

      const priceCountRef = db.collection('idPriceCounts').doc(priceStr);
      const priceCountDoc = await transaction.get(priceCountRef);
      if (!priceCountDoc.exists || priceCountDoc.data().availableCount === 0) {
        throw new Error('No ID numbers available at this price');
      }

      const numbersQuery = await db.collection('idNumbers')
        .where('price', '==', priceStr).where('status', '==', 'available').limit(1).get();
      if (numbersQuery.empty) throw new Error('No ID numbers available');

      const numberDoc = numbersQuery.docs[0];
      const numberData = numberDoc.data();

      transaction.update(numberDoc.ref, { status: 'sold', soldTo: userId, soldAt: admin.firestore.FieldValue.serverTimestamp() });
      transaction.update(priceCountRef, {
        availableCount: admin.firestore.FieldValue.increment(-1),
        soldCount: admin.firestore.FieldValue.increment(1)
      });
      transaction.update(userRef, { balance: admin.firestore.FieldValue.increment(-parseInt(priceStr)) });

      const userNumberRef = db.collection('users').doc(userId).collection('purchased').doc(numberDoc.id);
      transaction.set(userNumberRef, {
        number: numberData.number, apiUrl: numberData.apiUrl, price: priceStr,
        purchasedAt: admin.firestore.FieldValue.serverTimestamp(), status: 'active', type: 'id'
      });

      return { numberId: numberDoc.id, number: numberData.number, apiUrl: numberData.apiUrl };
    });

    await updateAdminCounters();
    cache.timestamp = 0;
    res.json({ success: true, number: result.number, numberId: result.numberId, apiUrl: result.apiUrl });
  } catch (error) {
    console.error('Buy ID error:', error);
    const msg = error?.message || '';
    if (msg.includes('Insufficient balance')) return res.status(400).json({ error: 'Insufficient balance' });
    if (msg.includes('No ID numbers available')) return res.status(400).json({ error: 'No ID numbers available at this price' });
    if (msg.includes('User not found')) return res.status(404).json({ error: 'User not found' });
    res.status(400).json({ error: 'Purchase failed' });
  }
});

// Bulk Buy ID Number
app.post('/api/user/bulk-buy-id-number', generalLimiter, verifyToken, async (req, res) => {
  try {
    const userId = req.uid;
    const { quantity } = req.body;
    if (!quantity) return res.status(400).json({ error: 'Quantity required' });
    if (![10, 20, 50, 100].includes(quantity)) return res.status(400).json({ error: 'Quantity must be 10, 20, 50, or 100' });

    const bulkPricesDoc = await db.collection('settings').doc('bulkPrices').get();
    if (!bulkPricesDoc.exists) return res.status(400).json({ error: 'Bulk prices not set by admin' });
    const totalPrice = bulkPricesDoc.data()[`id_${quantity}`];
    if (!totalPrice || totalPrice <= 0) return res.status(400).json({ error: `Bulk price for ${quantity} not set` });

    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      const currentBalance = userDoc.data().balance || 0;
      if (currentBalance < totalPrice) throw new Error(`Insufficient balance. Need ${totalPrice} PKR`);

      const numbersQuery = await db.collection('idNumbers').where('status', '==', 'available').limit(quantity).get();
      if (numbersQuery.size < quantity) throw new Error(`Only ${numbersQuery.size} ID numbers available`);

      const purchasedNumbers = [];
      const priceUpdates = {};
      for (const doc of numbersQuery.docs) {
        const numberData = doc.data();
        const price = numberData.price;
        transaction.update(doc.ref, { status: 'sold', soldTo: userId, soldAt: admin.firestore.FieldValue.serverTimestamp() });
        priceUpdates[price] = (priceUpdates[price] || 0) + 1;
        const userNumberRef = db.collection('users').doc(userId).collection('purchased').doc(doc.id);
        transaction.set(userNumberRef, {
          number: numberData.number, apiUrl: numberData.apiUrl, price,
          purchasedAt: admin.firestore.FieldValue.serverTimestamp(), status: 'active', type: 'id',
          bulkPurchase: true, bulkQuantity: quantity
        });
        purchasedNumbers.push({ id: doc.id, number: numberData.number, apiUrl: numberData.apiUrl, price });
      }
      for (const [price, count] of Object.entries(priceUpdates)) {
        const priceCountRef = db.collection('idPriceCounts').doc(price);
        transaction.update(priceCountRef, {
          availableCount: admin.firestore.FieldValue.increment(-count),
          soldCount: admin.firestore.FieldValue.increment(count)
        });
      }
      transaction.update(userRef, { balance: admin.firestore.FieldValue.increment(-totalPrice) });
      return { purchasedNumbers, totalPrice, quantity: purchasedNumbers.length, newBalance: currentBalance - totalPrice };
    });

    await updateAdminCounters();
    cache.timestamp = 0;
    res.json({
      success: true, message: `${result.quantity} ID numbers purchased for ${result.totalPrice} PKR`,
      numbers: result.purchasedNumbers, quantity: result.quantity, totalPrice: result.totalPrice,
      newBalance: result.newBalance
    });
  } catch (error) {
    console.error('Bulk buy ID error:', error);
    const msg = error?.message || '';
    if (msg.includes('Insufficient balance')) return res.status(400).json({ error: msg });
    if (msg.includes('numbers available')) return res.status(400).json({ error: msg });
    if (msg.includes('User not found')) return res.status(404).json({ error: 'User not found' });
    res.status(400).json({ error: 'Purchase failed' });
  }
});

// My ID Numbers
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

// Delete ID Number
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

// Delete ID Numbers
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
// ✅ SECURITY: Proxy — auth + whitelist
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

    const fetch = (await import('node-fetch')).default;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProxyBot/1.0)' },
      timeout: 10000
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
// ==================== ADMIN ENDPOINTS (admin-token required) ====================
// ============================================

function requireAdminToken(req, res, next) {
  const adminToken = req.headers['admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Admin Combined Dashboard
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

    const bulkPricesDoc = await db.collection('settings').doc('bulkPrices').get();
    let bulkPrices = { normal_10: null, normal_20: null, id_10: null, id_20: null, id_50: null, id_100: null };
    if (bulkPricesDoc.exists) bulkPrices = bulkPricesDoc.data();

    res.json({
      success: true,
      totalUsers: counters.totalUsers || 0, availableNumbers: counters.availableNumbers || 0,
      soldNumbers: counters.soldNumbers || 0, idAvailableNumbers: counters.idAvailableNumbers || 0,
      idSoldNumbers: counters.idSoldNumbers || 0, numbers, users, bulkPrices
    });
  } catch (error) {
    console.error('Admin combined error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin Dashboard Stats
app.post('/api/admin/dashboard', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const counters = await getCachedAdminCounters();
    res.json({
      totalUsers: counters.totalUsers || 0, availableNumbers: counters.availableNumbers || 0,
      soldNumbers: counters.soldNumbers || 0, idAvailableNumbers: counters.idAvailableNumbers || 0,
      idSoldNumbers: counters.idSoldNumbers || 0
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add Numbers
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
    await updateAdminCounters();
    cache.timestamp = 0;
    res.json({ success: true, addedCount, message: `${addedCount} numbers added successfully at PKR ${price}` });
  } catch (error) {
    console.error('Add numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Numbers (paginated)
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

// Delete Numbers
app.post('/api/admin/delete-numbers', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { numberIds, deleteAllSold } = req.body;
    if (deleteAllSold) {
      const soldSnapshot = await db.collection('numbers').where('status', '==', 'sold').get();
      const batch = db.batch();
      let deletedCount = 0;
      soldSnapshot.forEach(doc => { batch.delete(doc.ref); deletedCount++; });
      if (deletedCount > 0) await batch.commit();
      await updateAdminCounters();
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
      await updateAdminCounters();
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

// Add ID Numbers
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
    await updateAdminCounters();
    cache.timestamp = 0;
    res.json({ success: true, addedCount, message: `${addedCount} ID numbers added successfully at PKR ${price}` });
  } catch (error) {
    console.error('Add ID numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get ID Numbers
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

// Delete ID Numbers
app.post('/api/admin/delete-id-numbers', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { numberIds, deleteAllSold } = req.body;
    if (deleteAllSold) {
      const soldSnapshot = await db.collection('idNumbers').where('status', '==', 'sold').get();
      const batch = db.batch();
      let deletedCount = 0;
      soldSnapshot.forEach(doc => { batch.delete(doc.ref); deletedCount++; });
      if (deletedCount > 0) await batch.commit();
      await updateAdminCounters();
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
      await updateAdminCounters();
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

// Set Bulk Prices
app.post('/api/admin/set-bulk-prices', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { normal_10, normal_20, id_10, id_20, id_50, id_100 } = req.body;
    const prices = [
      { key: 'normal_10', value: normal_10 }, { key: 'normal_20', value: normal_20 },
      { key: 'id_10', value: id_10 }, { key: 'id_20', value: id_20 },
      { key: 'id_50', value: id_50 }, { key: 'id_100', value: id_100 }
    ];
    for (const p of prices) {
      if (p.value !== null && p.value !== undefined) {
        if (isNaN(p.value) || parseInt(p.value) < 0) return res.status(400).json({ error: `Invalid price for ${p.key}` });
      }
    }
    const bulkPrices = {
      normal_10: normal_10 !== null && normal_10 !== undefined && normal_10 !== '' ? parseInt(normal_10) : null,
      normal_20: normal_20 !== null && normal_20 !== undefined && normal_20 !== '' ? parseInt(normal_20) : null,
      id_10: id_10 !== null && id_10 !== undefined && id_10 !== '' ? parseInt(id_10) : null,
      id_20: id_20 !== null && id_20 !== undefined && id_20 !== '' ? parseInt(id_20) : null,
      id_50: id_50 !== null && id_50 !== undefined && id_50 !== '' ? parseInt(id_50) : null,
      id_100: id_100 !== null && id_100 !== undefined && id_100 !== '' ? parseInt(id_100) : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: 'admin'
    };
    await db.collection('settings').doc('bulkPrices').set(bulkPrices, { merge: true });
    res.json({ success: true, message: 'Bulk prices updated successfully', bulkPrices });
  } catch (error) {
    console.error('Set bulk prices error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Bulk Prices
app.post('/api/admin/get-bulk-prices', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const bulkPricesDoc = await db.collection('settings').doc('bulkPrices').get();
    if (!bulkPricesDoc.exists) {
      return res.json({
        success: true,
        bulkPrices: { normal_10: null, normal_20: null, id_10: null, id_20: null, id_50: null, id_100: null }
      });
    }
    res.json({ success: true, bulkPrices: bulkPricesDoc.data() });
  } catch (error) {
    console.error('Get bulk prices error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Users
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

// Update User Balance (admin only)
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

// Delete User
app.post('/api/admin/delete-user', generalLimiter, requireAdminToken, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'UserId required' });

    const purchasedSnapshot = await db.collection('users').doc(userId).collection('purchased').get();
    const batch = db.batch();
    purchasedSnapshot.forEach(doc => batch.delete(doc.ref));
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
    firebase: admin.apps.length > 0 ? 'connected' : 'disconnected'
  });
});

app.get('/api/version', (req, res) => {
  res.json({ version: '6.0.0', timestamp: Date.now() });
});

// ✅ SECURITY: Root endpoint — minimal info (no endpoint list)
app.get('/', (req, res) => {
  res.json({ message: 'USA Nums by Moon API', version: '6.0.0' });
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
