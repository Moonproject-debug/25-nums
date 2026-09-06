// index.js - USA Nums by Moon API (Complete)
// Version: 4.1.0
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
// CACHE SYSTEM (5-Minute TTL)
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
  clearCache(`my_numbers_${userId}`);
  clearCache(`my_id_numbers_${userId}`);
  clearCache(`transfers_${userId}`);
  clearCache(`combined_${userId}`);
}

// ============================================
// COUNTER HELPERS
// ============================================
async function updateCounter(collection, id, increment) {
  const counterRef = db.collection('counters').doc(collection);
  await counterRef.set({
    [id]: admin.firestore.FieldValue.increment(increment)
  }, { merge: true });
}

async function getCounter(collection, id) {
  const counterRef = db.collection('counters').doc(collection);
  const doc = await counterRef.get();
  if (doc.exists) {
    return doc.data()[id] || 0;
  }
  return 0;
}

async function updateUserCounter(increment) {
  const counterRef = db.collection('counters').doc('users');
  await counterRef.set({
    count: admin.firestore.FieldValue.increment(increment)
  }, { merge: true });
}

async function updatePriceCounter(price, increment) {
  const counterRef = db.collection('counters').doc('priceCounts');
  await counterRef.set({
    [`${price}`]: admin.firestore.FieldValue.increment(increment)
  }, { merge: true });
}

async function updateIdPriceCounter(price, increment) {
  const counterRef = db.collection('counters').doc('idPriceCounts');
  await counterRef.set({
    [`${price}`]: admin.firestore.FieldValue.increment(increment)
  }, { merge: true });
}

// ============================================
// AUTH ENDPOINTS
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
    
    // Create user document
    await db.collection('users').doc(userId).set({
      email: email.toLowerCase().trim(),
      balance: 0,
      role: 'user',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Update user counter
    await updateUserCounter(1);
    
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

// User Login
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
      await updateUserCounter(1);
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

// Admin Login
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
// USER ENDPOINTS
// ============================================

// Get user dashboard data (Normal Numbers)
app.post('/api/user/dashboard', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }
    
    // Check cache
    const cacheKey = `dashboard_${userId}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }
    
    const userDoc = await db.collection('users').doc(userId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userData = userDoc.data();
    
    // Get price counts from counter
    const priceCounterDoc = await db.collection('counters').doc('priceCounts').get();
    const priceCounts = priceCounterDoc.exists ? priceCounterDoc.data() : {};
    
    const priceList = [];
    for (const [price, count] of Object.entries(priceCounts)) {
      if (count > 0 && !isNaN(parseInt(price))) {
        priceList.push({
          price: price,
          availableCount: count
        });
      }
    }
    priceList.sort((a, b) => parseInt(a.price) - parseInt(b.price));
    
    // Get bulk prices
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
      balance: userData.balance || 0,
      email: userData.email,
      priceList,
      bulkPrices
    };
    
    // Cache result
    setCached(cacheKey, result);
    
    res.json(result);
    
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user ID dashboard data
app.post('/api/user/id-dashboard', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }
    
    // Check cache
    const cacheKey = `id_dashboard_${userId}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }
    
    const userDoc = await db.collection('users').doc(userId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userData = userDoc.data();
    
    // Get ID price counts from counter
    const idPriceCounterDoc = await db.collection('counters').doc('idPriceCounts').get();
    const idPriceCounts = idPriceCounterDoc.exists ? idPriceCounterDoc.data() : {};
    
    const priceList = [];
    for (const [price, count] of Object.entries(idPriceCounts)) {
      if (count > 0 && !isNaN(parseInt(price))) {
        priceList.push({
          price: price,
          availableCount: count
        });
      }
    }
    priceList.sort((a, b) => parseInt(a.price) - parseInt(b.price));
    
    // Get bulk prices
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
      balance: userData.balance || 0,
      email: userData.email,
      priceList,
      bulkPrices
    };
    
    // Cache result
    setCached(cacheKey, result);
    
    res.json(result);
    
  } catch (error) {
    console.error('ID Dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// COMBINED DASHBOARD (NEW - 4.1.0)
// ============================================

app.post('/api/user/combined-dashboard', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }
    
    // Check cache
    const cacheKey = `combined_${userId}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }
    
    // Get user data
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userData = userDoc.data();

    // Get normal numbers prices from counter
    const priceCounterDoc = await db.collection('counters').doc('priceCounts').get();
    const priceCounts = priceCounterDoc.exists ? priceCounterDoc.data() : {};
    
    const normalPriceList = [];
    for (const [price, count] of Object.entries(priceCounts)) {
      if (count > 0 && !isNaN(parseInt(price))) {
        normalPriceList.push({ price, availableCount: count });
      }
    }
    normalPriceList.sort((a, b) => parseInt(a.price) - parseInt(b.price));

    // Get ID numbers prices from counter
    const idPriceCounterDoc = await db.collection('counters').doc('idPriceCounts').get();
    const idPriceCounts = idPriceCounterDoc.exists ? idPriceCounterDoc.data() : {};
    
    const idPriceList = [];
    for (const [price, count] of Object.entries(idPriceCounts)) {
      if (count > 0 && !isNaN(parseInt(price))) {
        idPriceList.push({ price, availableCount: count });
      }
    }
    idPriceList.sort((a, b) => parseInt(a.price) - parseInt(b.price));

    // Get user's purchased normal numbers (limited to 50)
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

    // Get user's purchased ID numbers (limited to 50)
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

    // Get bulk prices
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

    // Get transfer history (last 50)
    const transfersSnapshot = await db.collection('users').doc(userId)
      .collection('transfers')
      .orderBy('timestamp', 'desc')
      .limit(50)
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

    // Cache result (5 minutes)
    setCached(cacheKey, result);

    res.json(result);

  } catch (error) {
    console.error('Combined dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// USER BALANCE TRANSFER
// ============================================

// Transfer balance from one user to another
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
    
    // Don't allow transfer to self
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
    
    // Find recipient by email
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
    
    // Don't allow transfer to admin accounts
    if (recipientData.role === 'admin') {
      return res.status(400).json({ error: 'Cannot transfer to admin account' });
    }
    
    // Perform transaction
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
      
      // Deduct from sender
      transaction.update(senderRef, {
        balance: admin.firestore.FieldValue.increment(-amountNum)
      });
      
      // Add to recipient
      transaction.update(recipientRef, {
        balance: admin.firestore.FieldValue.increment(amountNum)
      });
      
      // Log transaction in sender's transfer history
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
      
      // Log transaction in recipient's transfer history
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
    
    // Clear user cache
    clearUserCache(userId);
    clearUserCache(recipientId);
    
    // Get updated balance
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

// Get user's transfer history
app.post('/api/user/transfer-history', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }
    
    // Check cache
    const cacheKey = `transfers_${userId}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }
    
    const transfersSnapshot = await db.collection('users').doc(userId)
      .collection('transfers')
      .orderBy('timestamp', 'desc')
      .limit(50)
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
      transfers
    };
    
    setCached(cacheKey, result);
    
    res.json(result);
    
  } catch (error) {
    console.error('Get transfer history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Buy single number (Normal Numbers)
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
      
      const numbersQuery = await db.collection('numbers')
        .where('price', '==', priceStr)
        .where('status', '==', 'available')
        .limit(1)
        .get();
      
      if (numbersQuery.empty) {
        throw new Error('No numbers available at this price');
      }
      
      const numberDoc = numbersQuery.docs[0];
      const numberData = numberDoc.data();
      
      transaction.update(numberDoc.ref, { 
        status: 'sold',
        soldTo: userId,
        soldAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Update counter
      await updatePriceCounter(priceStr, -1);
      
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
    
    // Clear user cache
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

// Buy bulk numbers (Normal Numbers) - 10 & 20 only
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
      
      // Update counters
      for (const [price, count] of Object.entries(priceUpdates)) {
        await updatePriceCounter(price, -count);
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
    
    // Clear user cache
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

// Get user's purchased numbers (Normal Numbers)
app.post('/api/user/my-numbers', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }
    
    // Check cache
    const cacheKey = `my_numbers_${userId}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
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
    
    const result = { numbers };
    setCached(cacheKey, result);
    
    res.json(result);
    
  } catch (error) {
    console.error('Get my numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete user's purchased number (Normal Numbers)
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
    
    // Clear user cache
    clearUserCache(userId);
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Delete number error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete multiple user's purchased numbers (Normal Numbers)
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
    
    // Clear user cache
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
// USER ENDPOINTS (ID CREATION NUMBERS)
// ============================================

// Buy single ID number
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
      
      const numbersQuery = await db.collection('idNumbers')
        .where('price', '==', priceStr)
        .where('status', '==', 'available')
        .limit(1)
        .get();
      
      if (numbersQuery.empty) {
        throw new Error('No ID numbers available at this price');
      }
      
      const numberDoc = numbersQuery.docs[0];
      const numberData = numberDoc.data();
      
      transaction.update(numberDoc.ref, { 
        status: 'sold',
        soldTo: userId,
        soldAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Update ID price counter
      await updateIdPriceCounter(priceStr, -1);
      
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
    
    // Clear user cache
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

// Buy bulk ID numbers - 10, 20, 50, 100
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
      
      // Update ID price counters
      for (const [price, count] of Object.entries(priceUpdates)) {
        await updateIdPriceCounter(price, -count);
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
    
    // Clear user cache
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

// Get user's purchased ID numbers
app.post('/api/user/my-id-numbers', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }
    
    // Check cache
    const cacheKey = `my_id_numbers_${userId}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
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
    
    const result = { numbers };
    setCached(cacheKey, result);
    
    res.json(result);
    
  } catch (error) {
    console.error('Get my ID numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete user's purchased ID number
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
    
    // Clear user cache
    clearUserCache(userId);
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Delete ID number error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete multiple user's purchased ID numbers
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
    
    // Clear user cache
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

// Proxy endpoint for API content
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
// ADMIN ENDPOINTS
// ============================================

// Admin Dashboard Stats (Optimized - 4.1.0)
app.post('/api/admin/dashboard', async (req, res) => {
  try {
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Check cache
    const cacheKey = 'admin_dashboard';
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }
    
    // Get user count from counter
    const userCounterDoc = await db.collection('counters').doc('users').get();
    const totalUsers = userCounterDoc.exists ? userCounterDoc.data().count || 0 : 0;
    
    // Get normal number counts from price counters
    const priceCounterDoc = await db.collection('counters').doc('priceCounts').get();
    const priceCounts = priceCounterDoc.exists ? priceCounterDoc.data() : {};
    
    let availableNormal = 0;
    for (const [price, count] of Object.entries(priceCounts)) {
      if (!isNaN(parseInt(price)) && count > 0) {
        availableNormal += count;
      }
    }
    
    // Get sold count from numbers collection (count query - limited use)
    const soldSnapshot = await db.collection('numbers')
      .where('status', '==', 'sold')
      .count()
      .get();
    const soldNormal = soldSnapshot.data().count || 0;
    
    // Get ID number counts from ID price counters
    const idPriceCounterDoc = await db.collection('counters').doc('idPriceCounts').get();
    const idPriceCounts = idPriceCounterDoc.exists ? idPriceCounterDoc.data() : {};
    
    let availableId = 0;
    for (const [price, count] of Object.entries(idPriceCounts)) {
      if (!isNaN(parseInt(price)) && count > 0) {
        availableId += count;
      }
    }
    
    // Get ID sold count
    const idSoldSnapshot = await db.collection('idNumbers')
      .where('status', '==', 'sold')
      .count()
      .get();
    const soldId = idSoldSnapshot.data().count || 0;
    
    const result = {
      totalUsers,
      availableNumbers: availableNormal,
      soldNumbers: soldNormal,
      idAvailableNumbers: availableId,
      idSoldNumbers: soldId
    };
    
    // Cache for 2 minutes (admin data updates frequently)
    setCached(cacheKey, result);
    
    res.json(result);
    
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Combined Admin Dashboard (NEW - 4.1.0)
app.post('/api/admin/combined-dashboard', async (req, res) => {
  try {
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Check cache
    const cacheKey = 'admin_combined';
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }
    
    // Get user count from counter
    const userCounterDoc = await db.collection('counters').doc('users').get();
    const totalUsers = userCounterDoc.exists ? userCounterDoc.data().count || 0 : 0;
    
    // Get normal number counts from price counters
    const priceCounterDoc = await db.collection('counters').doc('priceCounts').get();
    const priceCounts = priceCounterDoc.exists ? priceCounterDoc.data() : {};
    
    let availableNormal = 0;
    for (const [price, count] of Object.entries(priceCounts)) {
      if (!isNaN(parseInt(price)) && count > 0) {
        availableNormal += count;
      }
    }
    
    // Get sold count from numbers collection
    const soldSnapshot = await db.collection('numbers')
      .where('status', '==', 'sold')
      .count()
      .get();
    const soldNormal = soldSnapshot.data().count || 0;
    
    // Get ID number counts from ID price counters
    const idPriceCounterDoc = await db.collection('counters').doc('idPriceCounts').get();
    const idPriceCounts = idPriceCounterDoc.exists ? idPriceCounterDoc.data() : {};
    
    let availableId = 0;
    for (const [price, count] of Object.entries(idPriceCounts)) {
      if (!isNaN(parseInt(price)) && count > 0) {
        availableId += count;
      }
    }
    
    const idSoldSnapshot = await db.collection('idNumbers')
      .where('status', '==', 'sold')
      .count()
      .get();
    const soldId = idSoldSnapshot.data().count || 0;
    
    // Get numbers (first 30)
    const numbersQuery = await db.collection('numbers')
      .orderBy('createdAt', 'desc')
      .limit(30)
      .get();
    
    const numbers = [];
    numbersQuery.forEach(doc => {
      numbers.push({ id: doc.id, ...doc.data() });
    });
    
    // Get users (first 30)
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
    
    // Get bulk prices
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
      availableNumbers: availableNormal,
      soldNumbers: soldNormal,
      idAvailableNumbers: availableId,
      idSoldNumbers: soldId,
      numbers,
      users,
      bulkPrices
    };
    
    // Cache for 1 minute
    setCached(cacheKey, result);
    
    res.json(result);
    
  } catch (error) {
    console.error('Admin combined error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add numbers (Normal Numbers)
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
    
    await batch.commit();
    
    // Update price counter
    await updatePriceCounter(priceStr, addedCount);
    
    // Clear admin cache
    clearCache('admin_dashboard');
    clearCache('admin_combined');
    
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

// Get numbers with pagination (Normal Numbers) - Optimized
app.post('/api/admin/numbers', async (req, res) => {
  try {
    const { status, lastDocId, limit } = req.body;
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const pageLimit = limit || 30;
    
    let query = db.collection('numbers').orderBy('createdAt', 'desc').limit(pageLimit);
    
    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }
    
    if (lastDocId) {
      const lastDoc = await db.collection('numbers').doc(lastDocId).get();
      if (lastDoc.exists) {
        query = query.startAfter(lastDoc);
      }
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
    console.error('Get numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete numbers (Normal Numbers)
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
      }
      
      // Clear admin cache
      clearCache('admin_dashboard');
      clearCache('admin_combined');
      
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
          await updatePriceCounter(price, -count);
        }
        
        await batch.commit();
      }
      
      // Clear admin cache
      clearCache('admin_dashboard');
      clearCache('admin_combined');
      
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
// ADMIN ENDPOINTS (ID CREATION NUMBERS)
// ============================================

// Add ID numbers - FIXED with counter update
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
    
    await batch.commit();
    
    // ✅ FIX: Update ID price counter
    await updateIdPriceCounter(priceStr, addedCount);
    
    // ✅ FIX: Clear admin cache
    clearCache('admin_dashboard');
    clearCache('admin_combined');
    
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

// Get ID numbers with pagination - Optimized
app.post('/api/admin/id-numbers', async (req, res) => {
  try {
    const { status, lastDocId, limit } = req.body;
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const pageLimit = limit || 100;
    
    let query = db.collection('idNumbers').orderBy('createdAt', 'desc').limit(pageLimit);
    
    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }
    
    if (lastDocId) {
      const lastDoc = await db.collection('idNumbers').doc(lastDocId).get();
      if (lastDoc.exists) {
        query = query.startAfter(lastDoc);
      }
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

// Delete ID numbers
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
      }
      
      // Clear admin cache
      clearCache('admin_dashboard');
      clearCache('admin_combined');
      
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
      
      // Clear admin cache
      clearCache('admin_dashboard');
      clearCache('admin_combined');
      
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
// ADMIN BULK PRICES ENDPOINTS
// ============================================

// Set bulk prices
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
    
    // Clear caches
    clearCache('admin_dashboard');
    clearCache('admin_combined');
    
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

// Get bulk prices
app.post('/api/admin/get-bulk-prices', async (req, res) => {
  try {
    const adminToken = req.headers['admin-token'];
    
    if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Check cache
    const cacheKey = 'bulk_prices';
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }
    
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
      bulkPrices
    };
    
    setCached(cacheKey, result);
    
    res.json(result);
    
  } catch (error) {
    console.error('Get bulk prices error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// ADMIN USER MANAGEMENT
// ============================================

// Get users with pagination - Optimized
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
    
    let query = db.collection('users').orderBy('createdAt', 'desc').limit(30);
    
    if (lastDocId) {
      const lastDoc = await db.collection('users').doc(lastDocId).get();
      if (lastDoc.exists) {
        query = query.startAfter(lastDoc);
      }
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
      hasMore: users.length === 30
    });
    
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user balance
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
    
    // Clear user cache
    clearUserCache(userId);
    clearCache('admin_dashboard');
    clearCache('admin_combined');
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Update balance error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete user
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
    
    // Update user counter
    await updateUserCounter(-1);
    
    try {
      await auth.deleteUser(userId);
    } catch (authError) {
      console.error('Auth deletion error:', authError);
    }
    
    // Clear caches
    clearUserCache(userId);
    clearCache('admin_dashboard');
    clearCache('admin_combined');
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// HEALTH & VERSION ENDPOINTS
// ============================================

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    firebase: admin.apps.length > 0 ? 'connected' : 'disconnected',
    version: '4.1.0'
  });
});

// Version endpoint
app.get('/api/version', (req, res) => {
  res.json({ 
    version: '4.1.0',
    timestamp: Date.now()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'USA Nums by Moon API',
    version: '4.1.0',
    endpoints: [
      '/api/health',
      '/api/version',
      '/api/auth/signup',
      '/api/auth/login',
      '/api/admin/login',
      '/api/user/dashboard',
      '/api/user/id-dashboard',
      '/api/user/combined-dashboard',
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
      '/api/admin/dashboard',
      '/api/admin/combined-dashboard',
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
      '/api/admin/delete-user'
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
