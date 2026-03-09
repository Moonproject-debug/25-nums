const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
try {
  if (!admin.apps.length) {
    const serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    };
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('✅ Firebase initialized');
  }
} catch (error) {
  console.error('❌ Firebase init error:', error);
}

const db = admin.firestore();
const auth = admin.auth();

// ==================== TEST ENDPOINTS ====================
app.get('/', (req, res) => {
  res.json({ 
    message: 'USA Nums by Moon API', 
    version: '1.0.0',
    nodeVersion: process.version,
    endpoints: [
      '/api/health',
      '/api/auth/signup',
      '/api/auth/login',
      '/api/admin/login',
      '/api/user/dashboard',
      '/api/user/buy-number',
      '/api/user/my-numbers',
      '/api/user/delete-number',
      '/api/proxy',
      '/api/admin/dashboard',
      '/api/admin/add-numbers',
      '/api/admin/numbers',
      '/api/admin/delete-numbers',
      '/api/admin/users',
      '/api/admin/update-user-balance',
      '/api/admin/delete-user'
    ]
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== AUTH ENDPOINTS ====================
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const userRecord = await auth.createUser({
      email: email.toLowerCase(),
      password: password,
    });
    
    await db.collection('users').doc(userRecord.uid).set({
      email: email.toLowerCase(),
      balance: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    res.json({ success: true, userId: userRecord.uid, email: email.toLowerCase() });
    
  } catch (error) {
    console.error('Signup error:', error);
    if (error.code === 'auth/email-already-exists') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const userRecord = await auth.getUserByEmail(email.toLowerCase());
    
    const userDoc = await db.collection('users').doc(userRecord.uid).get();
    if (!userDoc.exists) {
      await db.collection('users').doc(userRecord.uid).set({
        email: email.toLowerCase(),
        balance: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    
    res.json({ success: true, userId: userRecord.uid, email: email.toLowerCase() });
    
  } catch (error) {
    console.error('Login error:', error);
    if (error.code === 'auth/user-not-found') {
      return res.status(400).json({ error: 'User not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

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
    
    const userRecord = await auth.getUserByEmail(email.toLowerCase());
    res.json({ success: true, adminEmail: email.toLowerCase() });
    
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== USER ENDPOINTS ====================
app.post('/api/user/dashboard', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'UserId required' });
    
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    
    const priceCountsSnapshot = await db.collection('priceCounts').get();
    const priceList = [];
    priceCountsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.availableCount > 0) {
        priceList.push({ price: doc.id, availableCount: data.availableCount });
      }
    });
    
    priceList.sort((a, b) => parseInt(a.price) - parseInt(b.price));
    
    res.json({
      balance: userDoc.data().balance || 0,
      email: userDoc.data().email,
      priceList
    });
    
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/user/buy-number', async (req, res) => {
  try {
    const { userId, price } = req.body;
    if (!userId || !price) return res.status(400).json({ error: 'UserId and price required' });
    
    const priceStr = price.toString();
    
    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      if (userDoc.data().balance < parseInt(priceStr)) throw new Error('Insufficient balance');
      
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
      
      if (numbersQuery.empty) throw new Error('No numbers available');
      
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
        status: 'active'
      });
      
      return { numberId: numberDoc.id, number: numberData.number, apiUrl: numberData.apiUrl };
    });
    
    res.json({ success: true, ...result });
    
  } catch (error) {
    console.error('Buy number error:', error);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/user/my-numbers', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'UserId required' });
    
    const purchasedSnapshot = await db.collection('users').doc(userId)
      .collection('purchased')
      .where('status', '==', 'active')
      .orderBy('purchasedAt', 'desc')
      .get();
    
    const numbers = [];
    purchasedSnapshot.forEach(doc => numbers.push({ id: doc.id, ...doc.data() }));
    
    res.json({ numbers });
    
  } catch (error) {
    console.error('Get my numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/user/delete-number', async (req, res) => {
  try {
    const { userId, numberId } = req.body;
    if (!userId || !numberId) return res.status(400).json({ error: 'UserId and numberId required' });
    
    await db.collection('users').doc(userId).collection('purchased').doc(numberId).update({
      status: 'deleted',
      deletedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Delete number error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/proxy', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
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

// ==================== ADMIN ENDPOINTS ====================
const verifyAdmin = (req, res, next) => {
  const token = req.headers['admin-token'];
  if (!token || token !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.post('/api/admin/dashboard', verifyAdmin, async (req, res) => {
  try {
    const usersSnapshot = await db.collection('users').count().get();
    const availableSnapshot = await db.collection('numbers').where('status', '==', 'available').count().get();
    const soldSnapshot = await db.collection('numbers').where('status', '==', 'sold').count().get();
    
    res.json({
      totalUsers: usersSnapshot.data().count || 0,
      availableNumbers: availableSnapshot.data().count || 0,
      soldNumbers: soldSnapshot.data().count || 0
    });
    
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/add-numbers', verifyAdmin, async (req, res) => {
  try {
    const { numbersText, price } = req.body;
    if (!numbersText || !price) return res.status(400).json({ error: 'Numbers text and price required' });
    
    const lines = numbersText.trim().split('\n');
    const batch = db.batch();
    let addedCount = 0;
    const priceStr = price.toString();
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      
      const parts = trimmedLine.split('|');
      if (parts.length !== 2) continue;
      
      const number = parts[0].trim();
      const apiUrl = parts[1].trim();
      if (!number || !apiUrl) continue;
      
      batch.set(db.collection('numbers').doc(), {
        number, apiUrl, price: priceStr, status: 'available',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      addedCount++;
    }
    
    if (addedCount === 0) return res.status(400).json({ error: 'No valid numbers found' });
    
    batch.set(db.collection('priceCounts').doc(priceStr), {
      availableCount: admin.firestore.FieldValue.increment(addedCount),
      soldCount: admin.firestore.FieldValue.increment(0)
    }, { merge: true });
    
    await batch.commit();
    res.json({ success: true, addedCount, message: `${addedCount} numbers added at PKR ${price}` });
    
  } catch (error) {
    console.error('Add numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/numbers', verifyAdmin, async (req, res) => {
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
    
    snapshot.forEach(doc => {
      numbers.push({ id: doc.id, ...doc.data() });
      lastId = doc.id;
    });
    
    res.json({ numbers, lastDocId: lastId, hasMore: numbers.length === 30 });
    
  } catch (error) {
    console.error('Get numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/delete-numbers', verifyAdmin, async (req, res) => {
  try {
    const { numberIds, deleteAllSold } = req.body;
    
    if (deleteAllSold) {
      const soldSnapshot = await db.collection('numbers').where('status', '==', 'sold').get();
      if (soldSnapshot.empty) return res.json({ success: true, message: 'No sold numbers' });
      
      const batch = db.batch();
      soldSnapshot.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      res.json({ success: true, message: `${soldSnapshot.size} sold numbers deleted` });
      
    } else if (numberIds?.length > 0) {
      const batch = db.batch();
      numberIds.forEach(id => batch.delete(db.collection('numbers').doc(id)));
      await batch.commit();
      res.json({ success: true, message: `${numberIds.length} numbers deleted` });
      
    } else {
      res.status(400).json({ error: 'No numbers specified' });
    }
    
  } catch (error) {
    console.error('Delete numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/users', verifyAdmin, async (req, res) => {
  try {
    const { lastDocId, searchEmail } = req.body;
    
    if (searchEmail) {
      const snapshot = await db.collection('users').where('email', '==', searchEmail.toLowerCase()).limit(1).get();
      const users = [];
      snapshot.forEach(doc => users.push({ id: doc.id, email: doc.data().email, balance: doc.data().balance || 0 }));
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
      users.push({ id: doc.id, email: doc.data().email, balance: doc.data().balance || 0 });
      lastId = doc.id;
    });
    
    res.json({ users, lastDocId: lastId, hasMore: users.length === 30 });
    
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/update-user-balance', verifyAdmin, async (req, res) => {
  try {
    const { userId, newBalance } = req.body;
    if (!userId || newBalance === undefined) return res.status(400).json({ error: 'UserId and newBalance required' });
    if (isNaN(newBalance) || newBalance < 0) return res.status(400).json({ error: 'Invalid balance' });
    
    await db.collection('users').doc(userId).update({ balance: parseInt(newBalance) || 0 });
    res.json({ success: true });
    
  } catch (error) {
    console.error('Update balance error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/delete-user', verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'UserId required' });
    
    const purchasedSnapshot = await db.collection('users').doc(userId).collection('purchased').get();
    const batch = db.batch();
    purchasedSnapshot.forEach(doc => batch.delete(doc.ref));
    batch.delete(db.collection('users').doc(userId));
    await batch.commit();
    
    try { await auth.deleteUser(userId); } catch (e) { console.error('Auth delete error:', e); }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

module.exports = app;
