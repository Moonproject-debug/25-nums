const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Initialize Express
const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Middleware to verify admin token
const verifyAdminToken = (req, res, next) => {
  const adminToken = req.headers['admin-token'];
  
  if (!adminToken || adminToken !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
};

// ==================== USER ENDPOINTS ====================

// Get user balance and price list (single request)
app.post('/api/user/dashboard', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }
    
    // Get user balance
    const userDoc = await db.collection('users').doc(userId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userData = userDoc.data();
    
    // Get all price counts - single query
    const priceCountsSnapshot = await db.collection('priceCounts').get();
    
    const priceList = [];
    priceCountsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.availableCount > 0) {
        priceList.push({
          price: doc.id,
          availableCount: data.availableCount
        });
      }
    });
    
    // Sort by price
    priceList.sort((a, b) => parseInt(a.price) - parseInt(b.price));
    
    res.json({
      balance: userData.balance || 0,
      email: userData.email,
      priceList
    });
    
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Buy number
app.post('/api/user/buy-number', async (req, res) => {
  try {
    const { userId, price } = req.body;
    
    if (!userId || !price) {
      return res.status(400).json({ error: 'UserId and price required' });
    }
    
    const priceStr = price.toString();
    
    // Run transaction to ensure consistency
    const result = await db.runTransaction(async (transaction) => {
      // Get user data
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);
      
      if (!userDoc.exists) {
        throw new Error('User not found');
      }
      
      const userData = userDoc.data();
      
      // Check balance
      if (userData.balance < parseInt(priceStr)) {
        throw new Error('Insufficient balance');
      }
      
      // Get price count
      const priceCountRef = db.collection('priceCounts').doc(priceStr);
      const priceCountDoc = await transaction.get(priceCountRef);
      
      if (!priceCountDoc.exists || priceCountDoc.data().availableCount === 0) {
        throw new Error('No numbers available at this price');
      }
      
      // Find an available number at this price
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
      
      // Update number status to sold
      transaction.update(numberDoc.ref, { 
        status: 'sold',
        soldTo: userId,
        soldAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Decrease price count
      transaction.update(priceCountRef, {
        availableCount: admin.firestore.FieldValue.increment(-1),
        soldCount: admin.firestore.FieldValue.increment(1)
      });
      
      // Update user balance
      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(-parseInt(priceStr))
      });
      
      // Add to user's purchased numbers
      const userNumberRef = db.collection('users').doc(userId).collection('purchased').doc(numberDoc.id);
      transaction.set(userNumberRef, {
        number: numberData.number,
        apiUrl: numberData.apiUrl,
        price: priceStr,
        purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'active'
      });
      
      return {
        numberId: numberDoc.id,
        number: numberData.number,
        apiUrl: numberData.apiUrl
      };
    });
    
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

// Get user's purchased numbers
app.post('/api/user/my-numbers', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }
    
    const purchasedSnapshot = await db.collection('users').doc(userId)
      .collection('purchased')
      .where('status', '==', 'active')
      .orderBy('purchasedAt', 'desc')
      .get();
    
    const numbers = [];
    purchasedSnapshot.forEach(doc => {
      numbers.push({
        id: doc.id,
        ...doc.data()
      });
    });
    
    res.json({ numbers });
    
  } catch (error) {
    console.error('Get my numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete user's purchased number
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
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Delete number error:', error);
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
    
    const fetch = await import('node-fetch');
    const response = await fetch.default(url, {
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

// ==================== ADMIN ENDPOINTS ====================

// Admin Dashboard Stats
app.post('/api/admin/dashboard', verifyAdminToken, async (req, res) => {
  try {
    // Get total users
    const usersSnapshot = await db.collection('users').count().get();
    
    // Get numbers stats
    const availableSnapshot = await db.collection('numbers')
      .where('status', '==', 'available').count().get();
    
    const soldSnapshot = await db.collection('numbers')
      .where('status', '==', 'sold').count().get();
    
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

// Add numbers in bulk
app.post('/api/admin/add-numbers', verifyAdminToken, async (req, res) => {
  try {
    const { numbersText, price } = req.body;
    
    if (!numbersText || !price) {
      return res.status(400).json({ error: 'Numbers text and price required' });
    }
    
    const lines = numbersText.trim().split('\n');
    const batch = db.batch();
    let addedCount = 0;
    
    const priceStr = price.toString();
    const priceCountRef = db.collection('priceCounts').doc(priceStr);
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      
      const parts = trimmedLine.split('|');
      if (parts.length !== 2) continue;
      
      const number = parts[0].trim();
      const apiUrl = parts[1].trim();
      
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
    
    // Update price count
    batch.set(priceCountRef, {
      availableCount: admin.firestore.FieldValue.increment(addedCount),
      soldCount: admin.firestore.FieldValue.increment(0)
    }, { merge: true });
    
    await batch.commit();
    
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

// Get numbers with pagination (30 per page)
app.post('/api/admin/numbers', verifyAdminToken, async (req, res) => {
  try {
    const { status, lastDocId } = req.body;
    
    let query = db.collection('numbers').orderBy('createdAt', 'desc').limit(30);
    
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
      hasMore: numbers.length === 30
    });
    
  } catch (error) {
    console.error('Get numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete numbers
app.post('/api/admin/delete-numbers', verifyAdminToken, async (req, res) => {
  try {
    const { numberIds, deleteAllSold } = req.body;
    
    if (deleteAllSold) {
      // Delete all sold numbers
      const soldSnapshot = await db.collection('numbers')
        .where('status', '==', 'sold')
        .get();
      
      const batch = db.batch();
      soldSnapshot.forEach(doc => {
        batch.delete(doc.ref);
      });
      
      await batch.commit();
      
      res.json({
        success: true,
        message: `All sold numbers deleted`
      });
      
    } else if (numberIds && numberIds.length > 0) {
      // Delete specific numbers
      const batch = db.batch();
      for (const id of numberIds) {
        const docRef = db.collection('numbers').doc(id);
        batch.delete(docRef);
      }
      
      await batch.commit();
      
      res.json({
        success: true,
        message: `${numberIds.length} numbers deleted`
      });
      
    } else {
      res.status(400).json({ error: 'No numbers specified' });
    }
    
  } catch (error) {
    console.error('Delete numbers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get users with pagination (30 per page)
app.post('/api/admin/users', verifyAdminToken, async (req, res) => {
  try {
    const { lastDocId, searchEmail } = req.body;
    
    if (searchEmail) {
      // Search by email
      const snapshot = await db.collection('users')
        .where('email', '==', searchEmail.toLowerCase())
        .limit(1)
        .get();
      
      const users = [];
      snapshot.forEach(doc => {
        users.push({
          id: doc.id,
          email: doc.data().email,
          balance: doc.data().balance || 0,
          createdAt: doc.data().createdAt
        });
      });
      
      return res.json({ users, lastDocId: null, hasMore: false });
    }
    
    // Paginated users
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
        id: doc.id,
        email: doc.data().email,
        balance: doc.data().balance || 0,
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
app.post('/api/admin/update-user-balance', verifyAdminToken, async (req, res) => {
  try {
    const { userId, newBalance } = req.body;
    
    if (!userId || newBalance === undefined) {
      return res.status(400).json({ error: 'UserId and newBalance required' });
    }
    
    await db.collection('users').doc(userId).update({
      balance: parseInt(newBalance) || 0
    });
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Update balance error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete user
app.post('/api/admin/delete-user', verifyAdminToken, async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'UserId required' });
    }
    
    // Delete user's purchased numbers subcollection
    const purchasedSnapshot = await db.collection('users').doc(userId)
      .collection('purchased').get();
    
    const batch = db.batch();
    purchasedSnapshot.forEach(doc => {
      batch.delete(doc.ref);
    });
    
    // Delete user document
    batch.delete(db.collection('users').doc(userId));
    
    await batch.commit();
    
    // Also delete from Firebase Auth (requires Firebase Admin SDK)
    try {
      await admin.auth().deleteUser(userId);
    } catch (authError) {
      console.error('Auth deletion error:', authError);
      // Continue even if auth deletion fails
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

// Export for Vercel
module.exports = app;

// For local development
if (require.main === module) {
  const port = process.env.PORT || 3001;
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}
