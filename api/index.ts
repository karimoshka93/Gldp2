import express from 'express';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
app.use(express.json());

// Firebase Setup
const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
let firebaseConfig: any = {};
if (fs.existsSync(configPath)) {
  firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

if (!admin.apps.length) {
  // If we have a service account in env vars, use it (Required for Vercel)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: firebaseConfig.projectId,
      });
    } catch (e) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT:', e);
      admin.initializeApp({ projectId: firebaseConfig.projectId });
    }
  } else {
    // Normal initialization for AI Studio environment
    admin.initializeApp({
      projectId: firebaseConfig.projectId,
    });
  }
}

const fdb = firebaseConfig.firestoreDatabaseId ? getFirestore(firebaseConfig.firestoreDatabaseId) : getFirestore();

// Middleware to validate Telegram WebApp initData 
const verifyTelegramInitData = (initData: string): { id: number; username?: string; first_name?: string } | null => {
  if (!initData) return null;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return null;

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
    }
  } catch (e) {}
  return null;
};

const validateTelegramData = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const initData = req.headers['x-telegram-init-data'] as string;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  (req as any).tgUser = tgUser || { id: 0 };
  next();
};

const verifyUserMatch = (req: express.Request, targetId: any): boolean => {
  const authId = (req as any).tgUser?.id?.toString();
  if (!authId && process.env.NODE_ENV !== 'production') return true;
  return authId === targetId?.toString();
};

// --- API Routes ---

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/user/sync', validateTelegramData, async (req, res) => {
  try {
    const { telegramId, username, first_name, photo_url, referred_by } = req.body;
    const idStr = telegramId?.toString();
    if (!idStr || !verifyUserMatch(req, idStr)) return res.status(403).json({ error: 'FORBIDDEN' });

    const userRef = fdb.collection('users').doc(idStr);
    let userDoc = await userRef.get();
    let user = userDoc.exists ? userDoc.data() : null;

    if (!user) {
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

      user = {
        id: idStr,
        username: username || '',
        first_name: first_name || '',
        photo_url: photo_url || null,
        referred_by: referred_by || null,
        balance: referred_by ? 5000 : 0, // 5k bonus for being referred
        multiplier: 0.1,
        airdropRank: 0,
        energy: 1000,
        daily_quest_states: {},
        completed_missions: [],
        upgrades: {},
        last_claim_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      };
      await userRef.set(user);
    } else {
      // Energy refill
      const lastUpdate = user.updated_at?.toDate?.() || new Date(user.updated_at);
      const diffSecs = Math.floor((Date.now() - lastUpdate.getTime()) / 1000);
      const refilled = Math.min(1000, (user.energy || 0) + Math.max(0, diffSecs));
      if (refilled !== user.energy) {
        await userRef.update({ energy: refilled, updated_at: admin.firestore.FieldValue.serverTimestamp() });
        user.energy = refilled;
      }
    }

    const refSnapshot = await fdb.collection('users').where('referred_by', '==', idStr).count().get();
    res.json({ ...user, referralCount: refSnapshot.data().count });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const grantAdReward = async (id: string) => {
  const userRef = fdb.collection('users').doc(id);
  const userDoc = await userRef.get();
  if (!userDoc.exists) return null;
  const user = userDoc.data()!;
  const questStates = user.daily_quest_states || {};
  const adState = questStates.adsgram || { count: 0, last_ad_at: 0 };
  const today = new Date().toDateString();
  const lastDate = new Date(adState.last_ad_at || 0).toDateString();
  const countToday = today === lastDate ? adState.count : 0;
  if (countToday >= 10) return null;

  await userRef.update({
    balance: (user.balance || 0) + 2500,
    airdropRank: (user.airdropRank || 0) + 15,
    daily_quest_states: { ...questStates, adsgram: { count: countToday + 1, last_ad_at: Date.now() } }
  });
  return (await userRef.get()).data();
};

app.get('/api/adsgram/reward', async (req, res) => {
  const userid = req.query.userid || req.query.userId || req.query.user_id;
  if (!userid) return res.status(400).send('missing userid');
  const success = await grantAdReward(userid.toString());
  res.send(success ? 'ok' : 'error');
});

app.post('/api/user/sync-taps', validateTelegramData, async (req, res) => {
  try {
    const { telegramId, taps } = req.body;
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });
    const userRef = fdb.collection('users').doc(telegramId.toString());
    const userDoc = await userRef.get();
    if (!userDoc.exists) throw new Error('User not found');
    const user = userDoc.data()!;
    const validTaps = Math.min(taps || 0, user.energy);
    await userRef.update({ 
      balance: (user.balance || 0) + validTaps, 
      energy: Math.max(0, user.energy - validTaps), 
      updated_at: admin.firestore.FieldValue.serverTimestamp() 
    });
    res.json((await userRef.get()).data());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/claim', validateTelegramData, async (req, res) => {
  try {
    const { telegramId } = req.body;
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });
    const userRef = fdb.collection('users').doc(telegramId.toString());
    const userDoc = await userRef.get();
    if (!userDoc.exists) throw new Error('User not found');
    const user = userDoc.data()!;
    const lastClaim = user.last_claim_at?.toDate?.() || new Date(user.last_claim_at || user.created_at);
    const earnings = Math.floor(((Date.now() - lastClaim.getTime()) / 1000) * (user.multiplier || 0.1));
    if (earnings <= 0) return res.status(400).json({ error: 'Nothing to claim yet' });
    await userRef.update({
      balance: (user.balance || 0) + earnings,
      last_claim_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ user: (await userRef.get()).data(), earned: earnings });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Removal of app.post('/api/user/ad-reward', ...)
app.post('/api/user/complete-quest', validateTelegramData, async (req, res) => {
  try {
    const { telegramId, questId, reward, points, type } = req.body;
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });

    const userRef = fdb.collection('users').doc(telegramId.toString());
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

    res.json((await userRef.get()).data());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/upgrade', validateTelegramData, async (req, res) => {
  try {
    const { telegramId, developerId, cost, boost } = req.body;
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });

    const userRef = fdb.collection('users').doc(telegramId.toString());
    const userDoc = await userRef.get();
    if (!userDoc.exists) throw new Error('User not found');
    const user = userDoc.data()!;

    if ((user.balance || 0) < cost) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const upgrades = user.upgrades || {};
    const nextLevel = (upgrades[developerId] || 0) + 1;

    await userRef.update({
      balance: (user.balance || 0) - cost,
      multiplier: (user.multiplier || 0.1) + boost,
      [`upgrades.${developerId}`]: nextLevel,
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json((await userRef.get()).data());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const { sortBy = 'airdropRank' } = req.query;
    const validSorts = ['airdropRank', 'multiplier', 'balance'];
    const sortColumn = validSorts.includes(sortBy as string) ? sortBy as string : 'airdropRank';

    const snapshot = await fdb.collection('users').orderBy(sortColumn, 'desc').limit(100).get();
    res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default app;
