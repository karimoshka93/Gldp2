import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

// Firebase Setup
const configPath = path.join(__dirname, 'firebase-applet-config.json');
let firebaseConfig: any = {};
if (fs.existsSync(configPath)) {
  firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

admin.initializeApp({
  projectId: firebaseConfig.projectId,
});

// Correct way to get Firestore instance for a specific database ID in firebase-admin v13+
const fdb = firebaseConfig.firestoreDatabaseId ? getFirestore(firebaseConfig.firestoreDatabaseId) : getFirestore();

// Global cache for leaderboard to save quotas
const leaderboardCaches: Record<string, { data: any[], expires: number }> = {};

async function startServer() {
  const app = express();
  app.use(express.json());

  // --- API Routes ---

  // Health check for Render
  app.get('/healthz', (req, res) => res.send('OK'));
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

  // Middleware to validate Telegram WebApp initData 
  const verifyTelegramInitData = (initData: string): { id: number; username?: string; first_name?: string } | null => {
    if (!initData) {
      console.warn('[AUTH] No initData provided');
      return null;
    }
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      console.warn('[AUTH] TELEGRAM_BOT_TOKEN is missing. Falling back to mock for dev.');
      try {
        const urlParams = new URLSearchParams(initData);
        const userStr = urlParams.get('user');
        if (userStr) return JSON.parse(userStr);
      } catch (e) {}
      return null;
    }

    try {
      const urlParams = new URLSearchParams(initData);
      const hash = urlParams.get('hash');
      urlParams.delete('hash');

      const dataCheckString = Array.from(urlParams.entries())
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join('\n');

      const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
      const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

      if (calculatedHash === hash) {
        const userStr = urlParams.get('user');
        if (userStr) return JSON.parse(userStr);
      } else {
        console.warn('[AUTH] Hash mismatch. Check TELEGRAM_BOT_TOKEN.');
      }
    } catch (e) {
      console.error('[AUTH] Validation Error:', e);
    }
    return null;
  };

  const validateTelegramData = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const initData = req.headers['x-telegram-init-data'] as string;
    
    if (!initData && process.env.NODE_ENV !== 'production') {
      return next();
    }

    const tgUser = verifyTelegramInitData(initData);
    if (!tgUser) {
      console.warn('[API] Unauthorized access attempt from:', req.ip);
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or expired Telegram session.' });
    }

    (req as any).tgUser = tgUser;
    next();
  };

  // Helper to ensure the body ID matches the authenticated ID
  const verifyUserMatch = (req: express.Request, targetId: any): boolean => {
    const authId = (req as any).tgUser?.id?.toString();
    if (!authId && process.env.NODE_ENV !== 'production') return true; 
    const match = authId === targetId?.toString();
    if (!match) console.warn(`[AUTH] User mismatch: Auth(${authId}) vs targetId(${targetId})`);
    return match;
  };

  // Sync endpoint - Handles initial connection and energy refill
  app.post('/api/user/sync', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, username, first_name, photo_url, referred_by } = req.body;
      const idStr = telegramId?.toString();
      
      console.log(`[SYNC] Firebase Request for: ${username || 'Unknown'} (${idStr})`);

      if (!idStr) return res.status(400).json({ error: 'telegramId required' });

      if (!verifyUserMatch(req, idStr)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

      const userRef = fdb.collection('users').doc(idStr);
      let userDoc = await userRef.get();
      let user = userDoc.exists ? userDoc.data() : null;

      if (!user) {
        console.log(`[SYNC] REGISTERING NEW FIREBASE USER: ${idStr}`);
        
        // Reward referrer if exists
        if (referred_by) {
          try {
            const referrerRef = fdb.collection('users').doc(referred_by.toString());
            const referrerDoc = await referrerRef.get();
            if (referrerDoc.exists) {
              await referrerRef.update({
                balance: admin.firestore.FieldValue.increment(25000), // 25k bonus for referring
                airdropRank: admin.firestore.FieldValue.increment(50), // +50 Activity Points
                updated_at: admin.firestore.FieldValue.serverTimestamp()
              });
            }
          } catch (refErr) {
            console.error("Referral reward error:", refErr);
          }
        }

        const newUser = {
          id: idStr,
          username: username || '',
          first_name: first_name || '',
          photo_url: photo_url || null,
          referred_by: referred_by || null,
          balance: referred_by ? 5000 : 0, 
          multiplier: 0.1,
          tap_value: 1, // Default tap value
          daily_taps: 0, // Count of taps today
          airdropRank: 0,
          energy: 100, // ENERGY IS NOW "DAILY TAPS LEFT"
          daily_quest_states: {},
          completed_missions: [],
          upgrades: {},
          last_claim_at: admin.firestore.FieldValue.serverTimestamp(),
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        };
        await userRef.set(newUser);
        user = newUser;
      }

      // Reset daily taps if it's a new day
      if (user) {
        const lastUpdate = user.updated_at?.toDate?.() || new Date(user.updated_at);
        const today = new Date().toDateString();
        const lastDate = lastUpdate.toDateString();

        if (today !== lastDate) {
          // New day - reset taps and energy
          await userRef.update({
            daily_taps: 0,
            energy: 100, // Reset to 100 taps available
            updated_at: admin.firestore.FieldValue.serverTimestamp()
          });
          user.daily_taps = 0;
          user.energy = 100;
        }
      }

      // Get referral count
      const refSnapshot = await fdb.collection('users').where('referred_by', '==', idStr).count().get();
      const refCount = refSnapshot.data().count;

      res.json({ ...user, referralCount: refCount || 0 });
    } catch (err: any) {
      console.error('[SYNC] Firebase Fatal Error:', err.message);
      res.status(500).json({ error: 'Sync failed. Database might be down.' });
    }
  });

  // Unified Adsgram Reward
  const grantAdReward = async (id: string) => {
    console.log(`[REWARD-SYSTEM] Firebase processing user: ${id}`);
    const userRef = fdb.collection('users').doc(id);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return null;
    const user = userDoc.data()!;

    const questStates = user.daily_quest_states || {};
    const adState = questStates.adsgram || { count: 0, last_ad_at: 0 };
    
    const today = new Date().toDateString();
    const lastDate = new Date(adState.last_ad_at || 0).toDateString();
    const countToday = today === lastDate ? adState.count : 0;

    if (countToday >= 10) {
      console.warn(`[REWARD-SYSTEM] Limit reached for ${id}`);
      return null;
    }

    await userRef.update({
      balance: (user.balance || 0) + 2500,
      airdropRank: (user.airdropRank || 0) + 15,
      daily_quest_states: { ...questStates, adsgram: { count: countToday + 1, last_ad_at: Date.now() } }
    });
    
    const updated = (await userRef.get()).data();
    return updated;
  };

  app.get('/api/adsgram/reward', async (req, res) => {
    const userid = req.query.userid || req.query.userId || req.query.user_id;
    console.log(`[ADSGRAM-WEBHOOK] Firebase ping received for user: ${userid}`);
    
    if (!userid) {
      console.warn('[ADSGRAM-WEBHOOK] Missing userid parameter in request');
      return res.status(400).send('missing userid');
    }
    
    const success = await grantAdReward(userid.toString());
    res.send(success ? 'ok' : 'error');
  });

  app.post('/api/user/complete-quest', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, questId, reward, points, type } = req.body;
      const idStr = telegramId.toString();

      if (!verifyUserMatch(req, telegramId)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

      const userRef = fdb.collection('users').doc(idStr);
      const userDoc = await userRef.get();
      if (!userDoc.exists) throw new Error('User not found');
      const user = userDoc.data()!;

      if (type === 'social') {
        const completed = user.completed_missions || [];
        if (completed.includes(questId)) {
          return res.status(400).json({ error: 'Already completed' });
        }
        await userRef.update({
          balance: (user.balance || 0) + reward,
          airdropRank: (user.airdropRank || 0) + points,
          completed_missions: admin.firestore.FieldValue.arrayUnion(questId)
        });
      } else {
        const questStates = user.daily_quest_states || {};
        const now = new Date();

        if (questStates[questId]) {
          const last = new Date(questStates[questId]);
          if (last.toDateString() === now.toDateString()) {
            return res.status(400).json({ error: 'Already done today' });
          }
        }

        await userRef.update({
          balance: (user.balance || 0) + reward,
          airdropRank: (user.airdropRank || 0) + points,
          daily_quest_states: { ...questStates, [questId]: now.toISOString() }
        });
      }

      const updated = (await userRef.get()).data();
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Secure Tapping Sync
  app.post('/api/user/sync-taps', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, taps } = req.body;
      const idStr = telegramId?.toString();
      if (!idStr) return res.status(400).json({ error: 'missing id' });

      if (!verifyUserMatch(req, telegramId)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

      const userRef = fdb.collection('users').doc(idStr);
      const userDoc = await userRef.get();
      if (!userDoc.exists) throw new Error('User not found');
      const user = userDoc.data()!;

      // Calculate how many taps can still be done
      const dailyLimit = 100;
      const currentDaily = user.daily_taps || 0;
      const available = Math.max(0, dailyLimit - currentDaily);
      const actualTaps = Math.min(taps || 0, available);

      if (actualTaps <= 0 && taps > 0) {
        return res.json(user);
      }

      const tapValue = user.tap_value || 1;
      const reward = actualTaps * tapValue;

      await userRef.update({ 
        balance: (user.balance || 0) + reward, 
        energy: Math.max(0, available - actualTaps), // "Energy" is now daily taps left
        daily_taps: currentDaily + actualTaps,
        updated_at: admin.firestore.FieldValue.serverTimestamp() 
      });
      
      const updated = (await userRef.get()).data();
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Claim Passive Income
  app.post('/api/user/claim', validateTelegramData, async (req, res) => {
    try {
      const { telegramId } = req.body;
      
      if (!verifyUserMatch(req, telegramId)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

      const userRef = fdb.collection('users').doc(telegramId.toString());
      const userDoc = await userRef.get();
      if (!userDoc.exists) throw new Error('User not found');
      const user = userDoc.data()!;

      const now = new Date();
      const lastClaim = user.last_claim_at?.toDate?.() || new Date(user.last_claim_at || user.created_at);
      const diffSecs = (now.getTime() - lastClaim.getTime()) / 1000;
      const earnings = Math.floor(diffSecs * (user.multiplier || 0.1));
      
      if (earnings <= 0) return res.status(400).json({ error: 'Nothing to claim yet' });

      await userRef.update({
        balance: (user.balance || 0) + earnings,
        last_claim_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      });

      const updated = (await userRef.get()).data();
      res.json({ user: updated, earned: earnings });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upgrade Developer
  app.post('/api/user/upgrade', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, developerId, cost, boost, upgradeType = 'income' } = req.body;
      
      if (!verifyUserMatch(req, telegramId)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

      const userRef = fdb.collection('users').doc(telegramId.toString());
      const userDoc = await userRef.get();
      if (!userDoc.exists) throw new Error('User not found');
      const user = userDoc.data()!;

      if ((user.balance || 0) < cost) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      const upgrades = user.upgrades || {};
      const nextLevel = (upgrades[developerId] || 0) + 1;

      const updateData: any = {
        balance: admin.firestore.FieldValue.increment(-cost),
        [`upgrades.${developerId}`]: nextLevel,
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      };

      if (upgradeType === 'tap') {
        const currentTap = user.tap_value || 1;
        if (currentTap >= 100) return res.status(400).json({ error: 'Maximum Tap Performance Reached' });
        updateData.tap_value = admin.firestore.FieldValue.increment(boost);
      } else {
        updateData.multiplier = admin.firestore.FieldValue.increment(boost);
      }

      await userRef.update(updateData);

      const updated = (await userRef.get()).data();
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Leaderboard with 15m Cache & Top 20 Limit
  app.get('/api/leaderboard', async (req, res) => {
    try {
      const { sortBy = 'airdropRank', userId } = req.query;
      const validSorts = ['airdropRank', 'multiplier', 'balance'];
      const sortColumn = validSorts.includes(sortBy as string) ? sortBy as string : 'airdropRank';

      const cacheKey = `${sortColumn}`;
      const now = Date.now();
      
      // Cache logic
      if (!leaderboardCaches[cacheKey] || now > leaderboardCaches[cacheKey].expires) {
        console.log(`[LEADERBOARD] Refreshing Cache for ${sortColumn}`);
        const snapshot = await fdb.collection('users')
          .orderBy(sortColumn, 'desc')
          .limit(20)
          .get();

        leaderboardCaches[cacheKey] = {
          data: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })),
          expires: now + (15 * 60 * 1000)
        };
      }

      let data = [...leaderboardCaches[cacheKey].data];
      let userRank = 0;

      // If user provides their ID, we fetch their specific rank efficiency
      if (userId) {
        const userDoc = await fdb.collection('users').doc(userId.toString()).get();
        if (userDoc.exists) {
          const userData = userDoc.data()!;
          const userValue = userData[sortColumn] || 0;
          
          // Get rank by counting users with higher value
          const rankSnapshot = await fdb.collection('users')
            .where(sortColumn, '>', userValue)
            .count()
            .get();
          
          userRank = rankSnapshot.data().count + 1;
        }
      }

      res.json({ 
        top20: data, 
        userRank, 
        lastUpdate: leaderboardCaches[cacheKey].expires - (15 * 60 * 1000) 
      });
    } catch (err: any) {
      console.error('[LEADERBOARD] Fatal Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // --- End API Routes ---

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
