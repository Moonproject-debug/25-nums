// index.js - USA Nums by Moon API (Fully Optimized)
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Initialize Express
const app = express();

// ✅ CORS - COMPLETE FIX
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'admin-token']
}));

// ✅ Handle preflight requests
app.options('*', cors());

app.use(express.json());

// Initialize Firebase Admin with error handling
try {
  const serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  };

  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_PRIVATE_KEY || !process.env.FIREBASE_CLIENT_EMAIL) {
    console.error('Missing Firebase environment variables');
  } else {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('Firebase initialized successfully');
  }
} catch (error) {
  console.error('Firebase initialization error:', error);
}

const db = admin.firestore();
const auth = admin.auth();

// ============================================
// 🚀 CACHE SYSTEM
// ============================================
const cache = {};
const cacheTimestamps = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  if (cache[key] && (Date.now() - cacheTimestamps[key] < CACHE_TTL)) {
    return cache[key];
  }
  return null;
}

function setCached(key, data) {
  cache[key] = data;
  cacheTimestamps[key] = Date.now();
}

function clearCache(key) {
  delete cache[key];
  delete cacheTimestamps[key];
}

function clearUserCache(userId) {
  clearCache(`dashboard_${userId}`);
  clearCache(`id_dashboard_${userId}`);
  clearCache(`numbers_${userId}`);
  clearCache(`id_numbers_${userId}`);
  clearCache(`transfers_${userId}`);
}

// ============================================
// 🚀 COUNTER HELPERS
// ============================================
async function updateUserCounter() {
  try {
    const snapshot = await db.collection('users').get();
    await db.collection('counters').doc('users').set({
      count: snapshot.size,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (error) {
    console.error('Error updating user counter:', error);
  }
}

async function updateNormalPriceCounter(price, availableChange, soldChange = 0) {
  try {
    const ref = db.collection('priceCounts').doc(price.toString());
    await ref.set({
      availableCount: admin.firestore.FieldValue.increment(availableChange || 0),
      soldCount: admin.firestore.FieldValue.increment(soldChange || 0),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (error) {
    console.error('Error updating normal price counter:', error);
  }
}

async function updateIdPriceCounter(price, availableChange, soldChange = 0) {
  try {
    const ref = db.collection('idPriceCounts').doc(price.toString());
    await ref.set({
      availableCount: admin.firestore.FieldValue.increment(availableChange || 0),
      soldCount: admin.firestore.FieldValue.increment(soldChange || 0),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (error) {
    console.error('Error updating ID price counter:', error);
  }
}

// ============================================
// 🚀 RECALCULATE COUNTERS (Admin Only - Run Once)
// ============================================
async function recalculateAllCounters() {
  try {
    // Recalculate normal numbers
    const normalNumbers = await db.collection('numbers').get();
    const normalPriceMap = {};
    normalNumbers.forEach(doc => {
      const data = doc.data();
      const price = data.price;
      if (!normalPriceMap[price]) {
        normalPriceMap[price] = { available: 0, sold: 0 };
      }
      if (data.status === 'available') {
        normalPriceMap[price].available++;
      } else if (data.status === 'sold') {
        normalPriceMap[price].sold++;
      }
    });
    
    const batch = db.batch();
    for (const [price, counts] of Object.entries(normalPriceMap)) {
      const ref = db.collection('priceCounts').doc(price);
      batch.set(ref, {
        availableCount: counts.available,
        soldCount: counts.sold,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    await batch.commit();

    // Recalculate ID numbers
    const idNumbers = await db.collection('idNumbers').get();
    const idPriceMap = {};
    idNumbers.forEach(doc => {
      const data = doc.data();
      const price = data.price;
      if (!idPriceMap[price]) {
        idPriceMap[price] = { available: 0, sold: 0 };
      }
      if (data.status === 'available') {
        idPriceMap[price].available++;
      } else if (data.status === 'sold') {
        idPriceMap[price].sold++;
      }
    });
    
    const idBatch = db.batch();
    for (const [price, counts] of Object.entries(idPriceMap)) {
      const ref = db.collection('idPriceCounts').doc(price);
      idBatch.set(ref, {
        availableCount: counts.available,
        soldCount: counts.sold,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    await idBatch.commit();

    // Update user counter
    await updateUserCounter();

    console.log('✅ All counters recalculated successfully');
  } catch (error) {
    console.error('Error recalculating counters:', error);
  }
}

// ============================================
// AUTH ENDPOINTS (Unchanged)
// ============================================

// User Signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    
    const userRecord = await auth.createUser({
      email: email.toLowerCase().trim(),
      password: password,
    });
    
    const userId = userRecord.uid;
    
    await db.collection('users').doc(userId).set({
      email: email.toLowerCase().trim(),
      balance: 0,
      role: 'user',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    await updateUserCounter();
    
    console.log('User created successfully:', userId);
    
    res.json({
      success: true,
      userId: userId,
      email: email.toLowerCase().trim()
    });
    
  } catch (error) {
    console.error('Signup error details:', error);
    
    if (error.code === 'auth/email-already-exists') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    
    if (error.code === 'auth/invalid-email') {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    if (error.code === 'auth/weak-password') {
      return res.status(400).json({ error: 'Password is too weak' });
    }
    
    res.status(500).json({ 
      error: 'Signup failed: ' + error.message,
      code: error.code 
    });
  }
});

// User Login (Unchanged)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const fetch = (await import('node-fetch')).default;
    
    const apiKey = process.env.FIREBASE_API_KEY;
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.toLowerCase().trim(),
        password: password,
        returnSecureToken: true
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      console.error('Firebase auth error:', data.error);
      
      if (data.error.message === 'EMAIL_NOT_FOUND') {
        return res.status(400).json({ error: 'User not found' });
      }
      
      if (data.error.message === 'INVALID_PASSWORD') {
        return res.status(400).json({ error: 'Invalid password' });
      }
      
      if (data.error.message === 'USER_DISABLED') {
        return res.status(400).json({ error: 'User account disabled' });
      }
      
      if (data.error.message === 'QUOTA_EXCEEDED') {
        return res.status(429).json({ 
          error: 'Too many login attempts. Please wait 1 hour and try again.',
          retryAfter: 3600
        });
      }
      
      return res.status(400).json({ error: 'Login failed: ' + data.error.message });
    }
    
    const userDoc = await db.collection('users').doc(data.localId).get();
    
    if (!userDoc.exists) {
      await db.collection('users').doc(data.localId).set({
        email: email.toLowerCase().trim(),
        balance: 0,
        role: 'user',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await updateUserCounter();
    }
    
    res.json({
      success: true,
      userId: data.localId,
      email: email.toLowerCase().trim()
    });
    
  } catch (error) {
    console.error('Login error details:', error);
    res.status(500).json({ 
      error: 'Login failed: ' + error.message
    });
  }
});

// Admin Login (Unchanged)
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const adminToken = req.headers['admin-token'];
    
    if (!email || !password || !adminToken) {
      return res.status(400).json({ error: 'Email, password and admin token required' });
    }
    
    if (adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Invalid admin token' });
    }
    
    const fetch = (await import('node-fetch')).default;
    
    const apiKey = process.env.FIREBASE_API_KEY;
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.toLowerCase().trim(),
        password: password,
        returnSecureToken: true
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      console.error('Firebase auth error:', data.error);
      
      if (data.error.message === 'EMAIL_NOT_FOUND') {
        return res.status(400).json({ error: 'Admin not found' });
      }
      
      if (data.error.message === 'INVALID_PASSWORD') {
        return res.status(400).json({ error: 'Invalid password' });
      }
      
      return res.status(400).json({ error: 'Login failed: ' + data.error.message });
    }
    
    const userDoc = await db.collection('users').doc(data.localId).get();
    
    if (!userDoc.exists) {
      return res.status(403).json({ error: 'User not found in database' });
    }
    
    const userData = userDoc.data();
    
    if (!userData.role || userData.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized as admin' });
    }
    
    await auth.setCustomUserClaims(data.localId, { admin: true });
    
    res.json({
      success: true,
      adminEmail: email.toLowerCase().trim(),
      userId: data.localId
    });
    
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Admin login failed: ' + error.message });
  }
});

// ============================================
// 🚀 OPTIMIZED USER ENDPOINTS
// ============================================

// OPTIMIZED: Combined Dashboard - ONE API CALL
app.post('/api/user/combined-dashboard', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }

    // Check cache first
    const cacheKey = `dashboard_${userId}`;
    const cachedData = getCached(cacheKey);
    if (cachedData) {
      return res.json({
        ...cachedData,
        cached: true,
        cachedAt: new Date(cacheTimestamps[cacheKey]).toISOString()
      });
    }

    // Get user data
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userData = userDoc.data();

    // ✅ Get normal price counts from counter
    const priceCountsSnapshot = await db.collection('priceCounts').get();
    const normalPriceList = [];
    priceCountsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.availableCount > 0) {
        normalPriceList.push({
          price: doc.id,
          availableCount: data.availableCount
        });
      }
    });
    normalPriceList.sort((a, b) => parseInt(a.price) - parseInt(b.price));

    // ✅ Get ID price counts from counter
    const idPriceCountsSnapshot = await db.collection('idPriceCounts').get();
    const idPriceList = [];
    idPriceCountsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.availableCount > 0) {
        idPriceList.push({
          price: doc.id,
          availableCount: data.availableCount
        });
      }
    });
    idPriceList.sort((a, b) => parseInt(a.price) - parseInt(b.price));

    // ✅ Get user's purchased numbers (limit 50 recent)
    const normalPurchasedSnapshot = await db.collection('users').doc(userId)
      .collection('purchased')
      .where('status', '==', 'active')
      .where('type', '==', 'normal')
      .orderBy('purchasedAt', 'desc')
      .limit(50)
      .get();
    
    const myNumbers = [];
    normalPurchasedSnapshot.forEach(doc => {
      myNumbers.push({ id: doc.id, ...doc.data() });
    });

    // ✅ Get user's purchased ID numbers (limit 50 recent)
    const idPurchasedSnapshot = await db.collection('users').doc(userId)
      .collection('purchased')
      .where('status', '==', 'active')
      .where('type', '==', 'id')
      .orderBy('purchasedAt', 'desc')
      .limit(50)
      .get();
    
    const myIdNumbers = [];
    idPurchasedSnapshot.forEach(doc => {
      myIdNumbers.push({ id: doc.id, ...doc.data() });
    });

    // ✅ Get bulk prices
    const bulkPricesDoc = await db.collection('settings').doc('bulkPrices').get();
    let bulkPrices = {
      normal_10: null,
      normal_20: null,
      id_10: null,
      id_20: null,
      id_50: null,
      id_100: null
    };
    if (bulkPricesDoc.exists) {
      bulkPrices = bulkPricesDoc.data();
    }

    // ✅ Get transfer history (last 30 recent)
    const transfersSnapshot = await db.collection('users').doc(userId)
      .collection('transfers')
      .orderBy('timestamp', 'desc')
      .limit(30)
      .get();
    
    const transfers = [];
    transfersSnapshot.forEach(doc => {
      const data = doc.data();
      let timestamp = data.timestamp;
      if (timestamp && timestamp.toDate) {
        timestamp = timestamp.toDate().toISOString();
      }
      transfers.push({
        id: doc.id,
        type: data.type || 'unknown',
        recipientEmail: data.recipientEmail || '',
        senderEmail: data.senderEmail || '',
        amount: data.amount || 0,
        balanceAfter: data.balanceAfter || 0,
        timestamp: timestamp,
        date: timestamp ? new Date(timestamp).toLocaleDateString() : '',
        time: timestamp ? new Date(timestamp).toLocaleTimeString() : ''
      });
    });

    const result = {
      success: true,
      balance: userData.balance || 0,
      email: userData.email || '',
      normalPriceList,
      idPriceList,
      myNumbers,
      myIdNumbers,
      bulkPrices,
      transfers,
      totalNormal: myNumbers.length,
      totalId: myIdNumbers.length
    };

    // Cache the result
    setCached(cacheKey, result);

    res.json(result);

  } catch (error) {
    console.error('Combined dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DEPRECATED: Keep for backward compatibility but redirect to combined
app.post('/api/user/dashboard', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }
    
    // Redirect to combined dashboard
    const response = await fetch(`${req.protocol}://${req.get('host')}/api/user/combined-dashboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Dashboard fallback error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DEPRECATED: Keep for backward compatibility
app.post('/api/user/id-dashboard', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }
    
    // Redirect to combined dashboard
    const response = await fetch(`${req.protocol}://${req.get('host')}/api/user/combined-dashboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    const data = await response.json();
    
    // Extract only ID dashboard data
    res.json({
      balance: data.balance || 0,
      email: data.email || '',
      priceList: data.idPriceList || [],
      bulkPrices: data.bulkPrices || {}
    });
  } catch (error) {
    console.error('ID dashboard fallback error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// USER BALANCE TRANSFER (Unchanged)
// ============================================

app.post('/api/user/transfer-balance', async (req, res) => {
  try {
    const { userId, recipientEmail, amount } = req.body;
    
    if (!userId || !recipientEmail || !amount) {
      return res.status(400).json({ error: 'UserId, recipient email, and amount required' });
    }
    
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }
    
    const amountNum = parseInt(amount);
    
    const senderDoc = await db.collection('users').doc(userId).get();
    if (!senderDoc.exists) {
      return res.status(404).json({ error: 'Sender not found' });
    }
    
    const senderData = senderDoc.data();
    if (senderData.email.toLowerCase() === recipientEmail.toLowerCase()) {
      return res.status(400).json({ error: 'Cannot transfer to yourself' });
    }
    
    if (senderData.balance < amountNum) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    const recipientSnapshot = await db.collection('users')
      .where('email', '==', recipientEmail.toLowerCase().trim())
      .limit(1)
      .get();
    
    if (recipientSnapshot.empty) {
      return res.status(404).json({ error: 'Recipient user not found' });
    }
    
    const recipientDoc = recipientSnapshot.docs[0];
    const recipientId = recipientDoc.id;
    const recipientData = recipientDoc.data();
    
    if (recipientData.role === 'admin') {
      return res.status(400).json({ error: 'Cannot transfer to admin account' });
    }
    
    await db.runTransaction(async (transaction) => {
      const senderRef = db.collection('users').doc(userId);
      const recipientRef = db.collection('users').doc(recipientId);
      
      const senderSnapshot = await transaction.get(senderRef);
      const recipientSnapshot2 = await transaction.get(recipientRef);
      
      if (!senderSnapshot.exists || !recipientSnapshot2.exists) {
        throw new Error('User not found');
      }
      
      const senderData2 = senderSnapshot.data();
      if (senderData2.balance < amountNum) {
        throw new Error('Insufficient balance');
      }
      
      transaction.update(senderRef, {
        balance: admin.firestore.FieldValue.increment(-amountNum)
      });
      
      transaction.update(recipientRef, {
        balance: admin.firestore.FieldValue.increment(amountNum)
      });
      
      const transferRef = db.collection('users').doc(userId)
        .collection('transfers').doc();
      transaction.set(transferRef, {
        type: 'sent',
        recipientEmail: recipientEmail.toLowerCase().trim(),
        recipientId: recipientId,
        amount: amountNum,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        balanceAfter: senderData2.balance - amountNum
      });
      
      const recipientTransferRef = db.collection('users').doc(recipientId)
        .collection('transfers').doc();
      transaction.set(recipientTransferRef, {
        type: 'received',
        senderEmail: senderData.email,
        senderId: userId,
        amount: amountNum,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        balanceAfter: (recipientData.balance || 0) + amountNum
      });
    });
    
    // Clear cache for both users
    clearUserCache(userId);
    clearUserCache(recipientId);
    
    const updatedSender = await db.collection('users').doc(userId).get();
    const newBalance = updatedSender.data().balance || 0;
    
    res.json({
      success: true,
      message: `Successfully transferred ${amountNum} PKR to ${recipientEmail}`,
      newBalance: newBalance,
      transferredAmount: amountNum,
      recipientEmail: recipientEmail
    });
    
  } catch (error) {
    console.error('Transfer balance error:', error);
    res.status(400).json({ error: error.message || 'Transfer failed' });
  }
});

// OPTIMIZED: Get transfer history (limit 30)
app.post('/api/user/transfer-history', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }

    const cacheKey = `transfers_${userId}`;
    const cachedData = getCached(cacheKey);
    if (cachedData) {
      return res.json({
        success: true,
        transfers: cachedData,
        cached: true
      });
    }
    
    const transfersSnapshot = await db.collection('users').doc(userId)
      .collection('transfers')
      .orderBy('timestamp', 'desc')
      .limit(30)
      .get();
    
    const transfers = [];
    transfersSnapshot.forEach(doc => {
      const data = doc.data();
      let timestamp = data.timestamp;
      if (timestamp && timestamp.toDate) {
        timestamp = timestamp.toDate().toISOString();
      }
      transfers.push({
        id: doc.id,
        type: data.type || 'unknown',
        recipientEmail: data.recipientEmail || '',
        senderEmail: data.senderEmail || '',
        amount: data.amount || 0,
        balanceAfter: data.balanceAfter || 0,
        timestamp: timestamp,
        date: timestamp ? new Date(timestamp).toLocaleDateString() : '',
        time: timestamp ? new Date(timestamp).toLocaleTimeString() : ''
      });
    });
    
    setCached(cacheKey, transfers);
    
    res.json({
      success: true,
      transfers
    });
    
  } catch (error) {
    console.error('Get transfer history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// BUY SINGLE NUMBER (Normal) - With Cache Clear
// ============================================

app.post('/api/user/buy-number', async (req, res) => {
  try {
    const { userId, price } = req.body;
    
    if (!userId || !price) {
      return res.status(400).json({ error: 'UserId and price required' });
    }
    
    const priceStr = price.toString();
    
    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);
      
      if (!userDoc.exists) {
        throw new Error('User not found');
      }
      
      const userData = userDoc.data();
      
      if (userData.balance < parseInt(priceStr)) {
        throw new Error('Insufficient balance');
      }
      
      const priceCountRef = db.collection('priceCounts').doc(priceStr);
      const priceCountDoc = await transaction.get(priceCountRef);
      
      if (!priceCountDoc.exists || priceCountDoc.data().availableCount === 0) {
        throw new Error('No numbers available at this price');
      }
      
      const numbersQuery = await db.collection('numbers')
        .where('price', '==', priceStr)
        .where('status', '==', 'available')
        .limit(1)
        .get();
      
      if (numbersQuery.empty) {
        throw new Error('No numbers available');
      }
      
      const numberDoc = numbersQuery.docs[0];
      const numberData = numberDoc.data();
      
      transaction.update(numberDoc.ref, { 
        status: 'sold',
        soldTo: userId,
        soldAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      transaction.update(priceCountRef, {
        availableCount: admin.firestore.FieldValue.increment(-1),
        soldCount: admin.firestore.FieldValue.increment(1)
      });
      
      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(-parseInt(priceStr))
      });
      
      const userNumberRef = db.collection('users').doc(userId).collection('purchased').doc(numberDoc.id);
      transaction.set(userNumberRef, {
        number: numberData.number,
        apiUrl: numberData.apiUrl,
        price: priceStr,
        purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'active',
        type: 'normal'
      });
      
      return {
        numberId: numberDoc.id,
        number: numberData.number,
        apiUrl: numberData.apiUrl
      };
    });
    
    // Clear cache
    clearUserCache(userId);
    
    res.json({
      success: true,
      number: result.number,
      numberId: result.numberId,
      apiUrl: result.apiUrl
    });
    
  } catch (error) {
    console.error('Buy number error:', error);
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// BUY BULK NUMBERS (Normal) - With Cache Clear
// ============================================

app.post('/api/user/bulk-buy-number', async (req, res) => {
  try {
    const { userId, quantity } = req.body;
    
    if (!userId || !quantity) {
      return res.status(400).json({ error: 'UserId and quantity required' });
    }
    
    if (![10, 20].includes(quantity)) {
      return res.status(400).json({ error: 'Quantity must be 10 or 20' });
    }
    
    const bulkPricesDoc = await db.collection('settings').doc('bulkPrices').get();
    if (!bulkPricesDoc.exists) {
      return res.status(400).json({ error: 'Bulk prices not set by admin' });
    }
    
    const bulkPrices = bulkPricesDoc.data();
    const priceKey = `normal_${quantity}`;
    const totalPrice = bulkPrices[priceKey];
    
    if (!totalPrice || totalPrice <= 0) {
      return res.status(400).json({ error: `Bulk price for ${quantity} numbers not set` });
    }
    
    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);
      
      if (!userDoc.exists) {
        throw new Error('User not found');
      }
      
      const userData = userDoc.data();
      const currentBalance = userData.balance || 0;
      
      if (currentBalance < totalPrice) {
        throw new Error(`Insufficient balance. Need ${totalPrice} PKR, you have ${currentBalance} PKR`);
      }
      
      const numbersQuery = await db.collection('numbers')
        .where('status', '==', 'available')
        .limit(quantity)
        .get();
      
      if (numbersQuery.size < quantity) {
        throw new Error(`Only ${numbersQuery.size} numbers available. Need ${quantity}`);
      }
      
      const purchasedNumbers = [];
      const priceUpdates = {};
      
      for (const doc of numbersQuery.docs) {
        const numberData = doc.data();
        const price = numberData.price;
        
        transaction.update(doc.ref, {
          status: 'sold',
          soldTo: userId,
          soldAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        priceUpdates[price] = (priceUpdates[price] || 0) + 1;
        
        const userNumberRef = db.collection('users').doc(userId).collection('purchased').doc(doc.id);
        transaction.set(userNumberRef, {
          number: numberData.number,
          apiUrl: numberData.apiUrl,
          price: price,
          purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'active',
          type: 'normal',
          bulkPurchase: true,
          bulkQuantity: quantity
        });
        
        purchasedNumbers.push({
          id: doc.id,
          number: numberData.number,
          apiUrl: numberData.apiUrl,
          price: price
        });
      }
      
      for (const [price, count] of Object.entries(priceUpdates)) {
        const priceCountRef = db.collection('priceCounts').doc(price);
        transaction.update(priceCountRef, {
          availableCount: admin.firestore.FieldValue.increment(-count),
          soldCount: admin.firestore.FieldValue.increment(count)
        });
      }
      
      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(-totalPrice)
      });
      
      return {
        purchasedNumbers,
        totalPrice,
        quantity: purchasedNumbers.length,
        newBalance: currentBalance - totalPrice
      };
    });
    
    clearUserCache(userId);
    
    res.json({
      success: true,
      message: `${result.quantity} numbers purchased successfully for ${result.totalPrice} PKR`,
      numbers: result.purchasedNumbers,
      quantity: result.quantity,
      totalPrice: result.totalPrice,
      newBalance: result.newBalance
    });
    
  } catch (error) {
    console.error('Bulk buy number error:', error);
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// OPTIMIZED: Get user's purchased numbers (limit 50)
// ============================================

app.post('/api/user/my-numbers', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }

    const cacheKey = `numbers_${userId}`;
    const cachedData = getCached(cacheKey);
    if (cachedData) {
      return res.json({ numbers: cachedData, cached: true });
    }
    
    const purchasedSnapshot = await db.collection('users').doc(userId)
      .collection('purchased')
      .where('status', '==', 'active')
      .where('type', '==', 'normal')
      .orderBy('purchasedAt', 'desc')
      .limit(50)
      .get();
    
    const numbers = [];
    purchasedSnapshot.forEach(doc => {
      numbers.push({
        id: doc.id,
        ...doc.data()
      });
    });
    
    setCached(cacheKey, numbers);
    
    res.json({ numbers });
    
  } catch (error) {
    console.error('Get my numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// DELETE USER NUMBERS - With Cache Clear
// ============================================

app.post('/api/user/delete-number', async (req, res) => {
  try {
    const { userId, numberId } = req.body;
    
    if (!userId || !numberId) {
      return res.status(400).json({ error: 'UserId and numberId required' });
    }
    
    const userNumberRef = db.collection('users').doc(userId)
      .collection('purchased').doc(numberId);
    
    await userNumberRef.update({
      status: 'deleted',
      deletedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    clearUserCache(userId);
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Delete number error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/user/delete-numbers', async (req, res) => {
  try {
    const { userId, numberIds } = req.body;
    
    if (!userId || !numberIds || !Array.isArray(numberIds) || numberIds.length === 0) {
      return res.status(400).json({ error: 'UserId and numberIds array required' });
    }
    
    const batch = db.batch();
    
    for (const numberId of numberIds) {
      const userNumberRef = db.collection('users').doc(userId)
        .collection('purchased').doc(numberId);
      
      batch.update(userNumberRef, {
        status: 'deleted',
        deletedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    
    await batch.commit();
    clearUserCache(userId);
    
    res.json({ 
      success: true, 
      message: `${numberIds.length} numbers deleted successfully` 
    });
    
  } catch (error) {
    console.error('Delete numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// ID NUMBERS ENDPOINTS (Optimized)
// ============================================

app.post('/api/user/buy-id-number', async (req, res) => {
  try {
    const { userId, price } = req.body;
    
    if (!userId || !price) {
      return res.status(400).json({ error: 'UserId and price required' });
    }
    
    const priceStr = price.toString();
    
    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);
      
      if (!userDoc.exists) {
        throw new Error('User not found');
      }
      
      const userData = userDoc.data();
      
      if (userData.balance < parseInt(priceStr)) {
        throw new Error('Insufficient balance');
      }
      
      const priceCountRef = db.collection('idPriceCounts').doc(priceStr);
      const priceCountDoc = await transaction.get(priceCountRef);
      
      if (!priceCountDoc.exists || priceCountDoc.data().availableCount === 0) {
        throw new Error('No ID numbers available at this price');
      }
      
      const numbersQuery = await db.collection('idNumbers')
        .where('price', '==', priceStr)
        .where('status', '==', 'available')
        .limit(1)
        .get();
      
      if (numbersQuery.empty) {
        throw new Error('No ID numbers available');
      }
      
      const numberDoc = numbersQuery.docs[0];
      const numberData = numberDoc.data();
      
      transaction.update(numberDoc.ref, { 
        status: 'sold',
        soldTo: userId,
        soldAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      transaction.update(priceCountRef, {
        availableCount: admin.firestore.FieldValue.increment(-1),
        soldCount: admin.firestore.FieldValue.increment(1)
      });
      
      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(-parseInt(priceStr))
      });
      
      const userNumberRef = db.collection('users').doc(userId).collection('purchased').doc(numberDoc.id);
      transaction.set(userNumberRef, {
        number: numberData.number,
        apiUrl: numberData.apiUrl,
        price: priceStr,
        purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'active',
        type: 'id'
      });
      
      return {
        numberId: numberDoc.id,
        number: numberData.number,
        apiUrl: numberData.apiUrl
      };
    });
    
    clearUserCache(userId);
    
    res.json({
      success: true,
      number: result.number,
      numberId: result.numberId,
      apiUrl: result.apiUrl
    });
    
  } catch (error) {
    console.error('Buy ID number error:', error);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/user/bulk-buy-id-number', async (req, res) => {
  try {
    const { userId, quantity } = req.body;
    
    if (!userId || !quantity) {
      return res.status(400).json({ error: 'UserId and quantity required' });
    }
    
    if (![10, 20, 50, 100].includes(quantity)) {
      return res.status(400).json({ error: 'Quantity must be 10, 20, 50, or 100' });
    }
    
    const bulkPricesDoc = await db.collection('settings').doc('bulkPrices').get();
    if (!bulkPricesDoc.exists) {
      return res.status(400).json({ error: 'Bulk prices not set by admin' });
    }
    
    const bulkPrices = bulkPricesDoc.data();
    const priceKey = `id_${quantity}`;
    const totalPrice = bulkPrices[priceKey];
    
    if (!totalPrice || totalPrice <= 0) {
      return res.status(400).json({ error: `Bulk price for ${quantity} ID numbers not set` });
    }
    
    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);
      
      if (!userDoc.exists) {
        throw new Error('User not found');
      }
      
      const userData = userDoc.data();
      const currentBalance = userData.balance || 0;
      
      if (currentBalance < totalPrice) {
        throw new Error(`Insufficient balance. Need ${totalPrice} PKR, you have ${currentBalance} PKR`);
      }
      
      const numbersQuery = await db.collection('idNumbers')
        .where('status', '==', 'available')
        .limit(quantity)
        .get();
      
      if (numbersQuery.size < quantity) {
        throw new Error(`Only ${numbersQuery.size} ID numbers available. Need ${quantity}`);
      }
      
      const purchasedNumbers = [];
      const priceUpdates = {};
      
      for (const doc of numbersQuery.docs) {
        const numberData = doc.data();
        const price = numberData.price;
        
        transaction.update(doc.ref, {
          status: 'sold',
          soldTo: userId,
          soldAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        priceUpdates[price] = (priceUpdates[price] || 0) + 1;
        
        const userNumberRef = db.collection('users').doc(userId).collection('purchased').doc(doc.id);
        transaction.set(userNumberRef, {
          number: numberData.number,
          apiUrl: numberData.apiUrl,
          price: price,
          purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'active',
          type: 'id',
          bulkPurchase: true,
          bulkQuantity: quantity
        });
        
        purchasedNumbers.push({
          id: doc.id,
          number: numberData.number,
          apiUrl: numberData.apiUrl,
          price: price
        });
      }
      
      for (const [price, count] of Object.entries(priceUpdates)) {
        const priceCountRef = db.collection('idPriceCounts').doc(price);
        transaction.update(priceCountRef, {
          availableCount: admin.firestore.FieldValue.increment(-count),
          soldCount: admin.firestore.FieldValue.increment(count)
        });
      }
      
      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(-totalPrice)
      });
      
      return {
        purchasedNumbers,
        totalPrice,
        quantity: purchasedNumbers.length,
        newBalance: currentBalance - totalPrice
      };
    });
    
    clearUserCache(userId);
    
    res.json({
      success: true,
      message: `${result.quantity} ID numbers purchased successfully for ${result.totalPrice} PKR`,
      numbers: result.purchasedNumbers,
      quantity: result.quantity,
      totalPrice: result.totalPrice,
      newBalance: result.newBalance
    });
    
  } catch (error) {
    console.error('Bulk buy ID number error:', error);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/user/my-id-numbers', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }

    const cacheKey = `id_numbers_${userId}`;
    const cachedData = getCached(cacheKey);
    if (cachedData) {
      return res.json({ numbers: cachedData, cached: true });
    }
    
    const purchasedSnapshot = await db.collection('users').doc(userId)
      .collection('purchased')
      .where('status', '==', 'active')
      .where('type', '==', 'id')
      .orderBy('purchasedAt', 'desc')
      .limit(50)
      .get();
    
    const numbers = [];
    purchasedSnapshot.forEach(doc => {
      numbers.push({
        id: doc.id,
        ...doc.data()
      });
    });
    
    setCached(cacheKey, numbers);
    
    res.json({ numbers });
    
  } catch (error) {
    console.error('Get my ID numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/user/delete-id-number', async (req, res) => {
  try {
    const { userId, numberId } = req.body;
    
    if (!userId || !numberId) {
      return res.status(400).json({ error: 'UserId and numberId required' });
    }
    
    const userNumberRef = db.collection('users').doc(userId)
      .collection('purchased').doc(numberId);
    
    await userNumberRef.update({
      status: 'deleted',
      deletedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    clearUserCache(userId);
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Delete ID number error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/user/delete-id-numbers', async (req, res) => {
  try {
    const { userId, numberIds } = req.body;
    
    if (!userId || !numberIds || !Array.isArray(numberIds) || numberIds.length === 0) {
      return res.status(400).json({ error: 'UserId and numberIds array required' });
    }
    
    const batch = db.batch();
    
    for (const numberId of numberIds) {
      const userNumberRef = db.collection('users').doc(userId)
        .collection('purchased').doc(numberId);
      
      batch.update(userNumberRef, {
        status: 'deleted',
        deletedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    
    await batch.commit();
    clearUserCache(userId);
    
    res.json({ 
      success: true, 
      message: `${numberIds.length} ID numbers deleted successfully` 
    });
    
  } catch (error) {
    console.error('Delete ID numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// PROXY ENDPOINT (Unchanged)
// ============================================

app.post('/api/proxy', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL required' });
    }
    
    const fetch = (await import('node-fetch')).default;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ProxyBot/1.0)'
      },
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
// 🚀 OPTIMIZED ADMIN ENDPOINTS
// ============================================

// OPTIMIZED: Admin Combined Dashboard - ONE API CALL
app.post('/api/admin/combined-dashboard', async (req, res) => {
  try {
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check cache
    const cacheKey = 'admin_dashboard';
    const cachedData = getCached(cacheKey);
    if (cachedData) {
      return res.json({
        ...cachedData,
        cached: true,
        cachedAt: new Date(cacheTimestamps[cacheKey]).toISOString()
      });
    }

    // ✅ Get user count from counter
    const userCounterDoc = await db.collection('counters').doc('users').get();
    let totalUsers = 0;
    if (userCounterDoc.exists) {
      totalUsers = userCounterDoc.data().count || 0;
    }

    // ✅ Get number counts from priceCounts
    let availableNumbers = 0;
    let soldNumbers = 0;
    const priceCountsSnapshot = await db.collection('priceCounts').get();
    priceCountsSnapshot.forEach(doc => {
      const data = doc.data();
      availableNumbers += data.availableCount || 0;
      soldNumbers += data.soldCount || 0;
    });

    // ✅ Get ID number counts
    let idAvailableNumbers = 0;
    let idSoldNumbers = 0;
    const idPriceCountsSnapshot = await db.collection('idPriceCounts').get();
    idPriceCountsSnapshot.forEach(doc => {
      const data = doc.data();
      idAvailableNumbers += data.availableCount || 0;
      idSoldNumbers += data.soldCount || 0;
    });

    // ✅ Get recent numbers (limit 30)
    const numbersQuery = await db.collection('numbers')
      .orderBy('createdAt', 'desc')
      .limit(30)
      .get();
    
    const numbers = [];
    numbersQuery.forEach(doc => {
      numbers.push({ id: doc.id, ...doc.data() });
    });

    // ✅ Get recent users (limit 30)
    const usersQuery = await db.collection('users')
      .orderBy('createdAt', 'desc')
      .limit(30)
      .get();
    
    const users = [];
    usersQuery.forEach(doc => {
      users.push({
        id: doc.id,
        email: doc.data().email,
        balance: doc.data().balance || 0,
        role: doc.data().role || 'user'
      });
    });

    // ✅ Get bulk prices
    const bulkPricesDoc = await db.collection('settings').doc('bulkPrices').get();
    let bulkPrices = {
      normal_10: null,
      normal_20: null,
      id_10: null,
      id_20: null,
      id_50: null,
      id_100: null
    };
    if (bulkPricesDoc.exists) {
      bulkPrices = bulkPricesDoc.data();
    }

    const result = {
      success: true,
      totalUsers,
      availableNumbers,
      soldNumbers,
      idAvailableNumbers,
      idSoldNumbers,
      numbers,
      users,
      bulkPrices
    };

    setCached(cacheKey, result);

    res.json(result);

  } catch (error) {
    console.error('Admin combined error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DEPRECATED: Keep for backward compatibility
app.post('/api/admin/dashboard', async (req, res) => {
  try {
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const response = await fetch(`${req.protocol}://${req.get('host')}/api/admin/combined-dashboard`, {
      method: 'POST',
      headers: { 'admin-token': adminToken }
    });
    const data = await response.json();
    
    // Return only stats
    res.json({
      totalUsers: data.totalUsers || 0,
      availableNumbers: data.availableNumbers || 0,
      soldNumbers: data.soldNumbers || 0,
      idAvailableNumbers: data.idAvailableNumbers || 0,
      idSoldNumbers: data.idSoldNumbers || 0
    });
  } catch (error) {
    console.error('Admin dashboard fallback error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// ADMIN ADD NUMBERS - With Counter Updates
// ============================================

app.post('/api/admin/add-numbers', async (req, res) => {
  try {
    const { numbersText, price } = req.body;
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!numbersText || !price) {
      return res.status(400).json({ error: 'Numbers text and price required' });
    }
    
    const lines = numbersText.trim().split('\n');
    const batch = db.batch();
    let addedCount = 0;
    
    const priceStr = price.toString();
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      
      let number, apiUrl;
      
      if (trimmedLine.includes('|')) {
        const parts = trimmedLine.split('|');
        number = parts[0].trim();
        apiUrl = parts[1].trim();
      } else {
        continue;
      }
      
      if (!number || !apiUrl) continue;
      
      const numberRef = db.collection('numbers').doc();
      batch.set(numberRef, {
        number,
        apiUrl,
        price: priceStr,
        status: 'available',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      addedCount++;
    }
    
    if (addedCount === 0) {
      return res.status(400).json({ error: 'No valid numbers found. Use format: number|apiUrl' });
    }
    
    // ✅ Update counter
    await updateNormalPriceCounter(priceStr, addedCount);
    
    await batch.commit();
    
    // Clear admin cache
    clearCache('admin_dashboard');
    
    res.json({
      success: true,
      addedCount,
      message: `${addedCount} numbers added successfully at PKR ${price}`
    });
    
  } catch (error) {
    console.error('Add numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// ADMIN GET NUMBERS (Optimized - limit 20)
// ============================================

app.post('/api/admin/numbers', async (req, res) => {
  try {
    const { status, lastDocId } = req.body;
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    let query = db.collection('numbers').orderBy('createdAt', 'desc').limit(20);
    
    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }
    
    if (lastDocId) {
      const lastDoc = await db.collection('numbers').doc(lastDocId).get();
      query = query.startAfter(lastDoc);
    }
    
    const snapshot = await query.get();
    
    const numbers = [];
    let lastId = null;
    
    snapshot.forEach(doc => {
      numbers.push({
        id: doc.id,
        ...doc.data()
      });
      lastId = doc.id;
    });
    
    res.json({
      numbers,
      lastDocId: lastId,
      hasMore: numbers.length === 20
    });
    
  } catch (error) {
    console.error('Get numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// ADMIN DELETE NUMBERS - With Counter Updates
// ============================================

app.post('/api/admin/delete-numbers', async (req, res) => {
  try {
    const { numberIds, deleteAllSold } = req.body;
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (deleteAllSold) {
      const soldSnapshot = await db.collection('numbers')
        .where('status', '==', 'sold')
        .get();
      
      const batch = db.batch();
      let deletedCount = 0;
      
      soldSnapshot.forEach(doc => {
        batch.delete(doc.ref);
        deletedCount++;
      });
      
      if (deletedCount > 0) {
        await batch.commit();
        // Recalculate counters
        await recalculateAllCounters();
        clearCache('admin_dashboard');
      }
      
      return res.json({
        success: true,
        message: `${deletedCount} sold numbers deleted`
      });
      
    } else if (numberIds && numberIds.length > 0) {
      const BATCH_SIZE = 10;
      const results = {
        totalDeleted: 0,
        priceUpdates: {}
      };
      
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
          await updateNormalPriceCounter(price, -count);
        }
        
        await batch.commit();
      }
      
      clearCache('admin_dashboard');
      
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
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// ============================================
// ADMIN ID NUMBERS (Optimized)
// ============================================

app.post('/api/admin/add-id-numbers', async (req, res) => {
  try {
    const { numbersText, price } = req.body;
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!numbersText || !price) {
      return res.status(400).json({ error: 'Numbers text and price required' });
    }
    
    const lines = numbersText.trim().split('\n');
    const batch = db.batch();
    let addedCount = 0;
    
    const priceStr = price.toString();
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      
      let number, apiUrl;
      
      if (trimmedLine.includes('|')) {
        const parts = trimmedLine.split('|');
        number = parts[0].trim();
        apiUrl = parts[1].trim();
      } else {
        continue;
      }
      
      if (!number || !apiUrl) continue;
      
      const numberRef = db.collection('idNumbers').doc();
      batch.set(numberRef, {
        number,
        apiUrl,
        price: priceStr,
        status: 'available',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      addedCount++;
    }
    
    if (addedCount === 0) {
      return res.status(400).json({ error: 'No valid ID numbers found. Use format: number|apiUrl' });
    }
    
    await updateIdPriceCounter(priceStr, addedCount);
    await batch.commit();
    
    clearCache('admin_dashboard');
    
    res.json({
      success: true,
      addedCount,
      message: `${addedCount} ID numbers added successfully at PKR ${price}`
    });
    
  } catch (error) {
    console.error('Add ID numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/id-numbers', async (req, res) => {
  try {
    const { status, lastDocId, limit } = req.body;
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const pageLimit = limit || 50;
    
    let query = db.collection('idNumbers').orderBy('createdAt', 'desc').limit(pageLimit);
    
    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }
    
    if (lastDocId) {
      const lastDoc = await db.collection('idNumbers').doc(lastDocId).get();
      query = query.startAfter(lastDoc);
    }
    
    const snapshot = await query.get();
    
    const numbers = [];
    let lastId = null;
    
    snapshot.forEach(doc => {
      numbers.push({
        id: doc.id,
        ...doc.data()
      });
      lastId = doc.id;
    });
    
    res.json({
      numbers,
      lastDocId: lastId,
      hasMore: numbers.length === pageLimit
    });
    
  } catch (error) {
    console.error('Get ID numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/delete-id-numbers', async (req, res) => {
  try {
    const { numberIds, deleteAllSold } = req.body;
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (deleteAllSold) {
      const soldSnapshot = await db.collection('idNumbers')
        .where('status', '==', 'sold')
        .get();
      
      const batch = db.batch();
      let deletedCount = 0;
      
      soldSnapshot.forEach(doc => {
        batch.delete(doc.ref);
        deletedCount++;
      });
      
      if (deletedCount > 0) {
        await batch.commit();
        await recalculateAllCounters();
        clearCache('admin_dashboard');
      }
      
      return res.json({
        success: true,
        message: `${deletedCount} sold ID numbers deleted`
      });
      
    } else if (numberIds && numberIds.length > 0) {
      const BATCH_SIZE = 10;
      const results = {
        totalDeleted: 0,
        priceUpdates: {}
      };
      
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
          await updateIdPriceCounter(price, -count);
        }
        
        await batch.commit();
      }
      
      clearCache('admin_dashboard');
      
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
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// ============================================
// ADMIN BULK PRICES (Unchanged)
// ============================================

app.post('/api/admin/set-bulk-prices', async (req, res) => {
  try {
    const { 
      normal_10, 
      normal_20, 
      id_10, 
      id_20,
      id_50,
      id_100
    } = req.body;
    
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const prices = [
      { key: 'normal_10', value: normal_10 },
      { key: 'normal_20', value: normal_20 },
      { key: 'id_10', value: id_10 },
      { key: 'id_20', value: id_20 },
      { key: 'id_50', value: id_50 },
      { key: 'id_100', value: id_100 }
    ];
    
    for (const p of prices) {
      if (p.value !== null && p.value !== undefined) {
        if (isNaN(p.value) || parseInt(p.value) < 0) {
          return res.status(400).json({ error: `Invalid price for ${p.key}` });
        }
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
    
    clearCache('admin_dashboard');
    
    res.json({
      success: true,
      message: 'Bulk prices updated successfully',
      bulkPrices
    });
    
  } catch (error) {
    console.error('Set bulk prices error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/get-bulk-prices', async (req, res) => {
  try {
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const bulkPricesDoc = await db.collection('settings').doc('bulkPrices').get();
    
    if (!bulkPricesDoc.exists) {
      return res.json({
        success: true,
        bulkPrices: {
          normal_10: null,
          normal_20: null,
          id_10: null,
          id_20: null,
          id_50: null,
          id_100: null
        }
      });
    }
    
    res.json({
      success: true,
      bulkPrices: bulkPricesDoc.data()
    });
    
  } catch (error) {
    console.error('Get bulk prices error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// ADMIN USER MANAGEMENT (Optimized)
// ============================================

app.post('/api/admin/users', async (req, res) => {
  try {
    const { lastDocId, searchEmail } = req.body;
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (searchEmail) {
      const snapshot = await db.collection('users')
        .where('email', '==', searchEmail.toLowerCase().trim())
        .limit(1)
        .get();
      
      const users = [];
      snapshot.forEach(doc => {
        users.push({
          id: doc.id,
          email: doc.data().email,
          balance: doc.data().balance || 0,
          role: doc.data().role || 'user',
          createdAt: doc.data().createdAt
        });
      });
      
      return res.json({ users, lastDocId: null, hasMore: false });
    }
    
    let query = db.collection('users').orderBy('createdAt', 'desc').limit(20);
    
    if (lastDocId) {
      const lastDoc = await db.collection('users').doc(lastDocId).get();
      query = query.startAfter(lastDoc);
    }
    
    const snapshot = await query.get();
    
    const users = [];
    let lastId = null;
    
    snapshot.forEach(doc => {
      users.push({
        id: doc.id,
        email: doc.data().email,
        balance: doc.data().balance || 0,
        role: doc.data().role || 'user',
        createdAt: doc.data().createdAt
      });
      lastId = doc.id;
    });
    
    res.json({
      users,
      lastDocId: lastId,
      hasMore: users.length === 20
    });
    
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/update-user-balance', async (req, res) => {
  try {
    const { userId, newBalance } = req.body;
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!userId || newBalance === undefined) {
      return res.status(400).json({ error: 'UserId and newBalance required' });
    }
    
    if (isNaN(parseInt(newBalance)) || parseInt(newBalance) < 0) {
      return res.status(400).json({ error: 'Invalid balance value' });
    }
    
    await db.collection('users').doc(userId).update({
      balance: parseInt(newBalance)
    });
    
    clearUserCache(userId);
    clearCache('admin_dashboard');
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Update balance error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/delete-user', async (req, res) => {
  try {
    const { userId } = req.body;
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }
    
    const purchasedSnapshot = await db.collection('users').doc(userId)
      .collection('purchased').get();
    
    const batch = db.batch();
    purchasedSnapshot.forEach(doc => {
      batch.delete(doc.ref);
    });
    
    batch.delete(db.collection('users').doc(userId));
    
    await batch.commit();
    
    try {
      await auth.deleteUser(userId);
    } catch (authError) {
      console.error('Auth deletion error:', authError);
    }
    
    await updateUserCounter();
    clearCache('admin_dashboard');
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// 🚀 RECALCULATE COUNTERS (Admin Only)
// ============================================

app.post('/api/admin/recalculate-counters', async (req, res) => {
  try {
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    await recalculateAllCounters();
    clearCache('admin_dashboard');
    
    res.json({
      success: true,
      message: 'All counters recalculated successfully'
    });
    
  } catch (error) {
    console.error('Recalculate counters error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// HEALTH & VERSION (Unchanged)
// ============================================

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    firebase: admin.apps.length > 0 ? 'connected' : 'disconnected'
  });
});

app.get('/api/version', (req, res) => {
  res.json({ 
    version: '4.0.4-optimized',
    timestamp: Date.now()
  });
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'USA Nums by Moon API (Optimized v4.0.4)',
    endpoints: [
      '/api/health',
      '/api/version',
      '/api/auth/signup',
      '/api/auth/login',
      '/api/admin/login',
      '/api/user/combined-dashboard',  // ✅ NEW OPTIMIZED
      '/api/user/dashboard',  // DEPRECATED
      '/api/user/id-dashboard',  // DEPRECATED
      '/api/user/transfer-balance',
      '/api/user/transfer-history',
      '/api/user/buy-number',
      '/api/user/bulk-buy-number',
      '/api/user/my-numbers',
      '/api/user/delete-number',
      '/api/user/delete-numbers',
      '/api/user/buy-id-number',
      '/api/user/bulk-buy-id-number',
      '/api/user/my-id-numbers',
      '/api/user/delete-id-number',
      '/api/user/delete-id-numbers',
      '/api/proxy',
      '/api/admin/combined-dashboard',  // ✅ NEW OPTIMIZED
      '/api/admin/dashboard',  // DEPRECATED
      '/api/admin/add-numbers',
      '/api/admin/numbers',
      '/api/admin/delete-numbers',
      '/api/admin/add-id-numbers',
      '/api/admin/id-numbers',
      '/api/admin/delete-id-numbers',
      '/api/admin/set-bulk-prices',
      '/api/admin/get-bulk-prices',
      '/api/admin/users',
      '/api/admin/update-user-balance',
      '/api/admin/delete-user',
      '/api/admin/recalculate-counters'  // ✅ NEW
    ]
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
