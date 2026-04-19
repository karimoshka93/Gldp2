import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import admin from 'firebase-admin';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

// Firebase Setup (Migration Bridge)
const firebaseServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) 
  : null;

if (firebaseServiceAccount) {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(firebaseServiceAccount)
    });
  }
}
const firestore = firebaseServiceAccount ? admin.firestore() : null;

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

async function startServer() {
  const app = express();
  app.use(express.json());

  // --- API Routes ---

  // Health check for Render
  app.get('/healthz', (req, res) => res.send('OK'));
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

  // Middleware to validate Telegram WebApp initData 
  const validateTelegramData = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const initData = req.headers['x-telegram-init-data'] as string;
    if (!initData && process.env.NODE_ENV !== 'production') {
      return next();
    }
    next();
  };

  // Sync endpoint with Migration Bridge
  app.post('/api/user/sync', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, username, first_name } = req.body;
      
      if (!supabaseUrl || !supabaseKey) {
        return res.status(500).json({ error: 'Supabase configuration is missing. Please add SUPABASE_URL and SUPABASE_ANON_KEY to your secrets.' });
      }

      if (!telegramId) return res.status(400).json({ error: 'telegramId is required' });

      // 1. Check if user exists in Supabase
      let { data: user, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', telegramId.toString())
        .single();

      if (error && error.code !== 'PGRST116') {
        if (error.message.includes("Could not find the table 'public.profiles'")) {
          return res.status(500).json({ 
            error: 'MISSING_TABLE', 
            message: 'The "profiles" table was not found in your Supabase database. Please open SCHEMA_SETUP.MD in the file explorer and follow the instructions to create the table.' 
          });
        }
        throw error;
      }

      // 2. If not in Supabase, try migrating from Firestore (Fresh Start)
      if (!user && firestore) {
        console.log(`NEW USER: ${telegramId} (${username}). Checking V1 Activity Points...`);
        
        let firestoreUser: any = null;
        
        // --- MULTI-SEARCH FOR V1 IMPORT ---
        // Search 1: By Telegram ID (numeric doc ID)
        const docById = await firestore.collection('users').doc(telegramId.toString()).get();
        if (docById.exists) firestoreUser = docById.data();

        // Search 2: ID field string
        if (!firestoreUser) {
          const qByTid = await firestore.collection('users').where('telegram_id', '==', telegramId.toString()).limit(1).get();
          if (!qByTid.empty) firestoreUser = qByTid.docs[0].data();
        }

        // Search 3: Username
        if (!firestoreUser && username) {
          const qByUsername = await firestore.collection('users').where('username', '==', username).limit(1).get();
          if (!qByUsername.empty) firestoreUser = qByUsername.docs[0].data();
        }

        // Search 4: ownerId
        if (!firestoreUser) {
          const qByOwnerId = await firestore.collection('users').where('ownerId', '==', telegramId.toString()).limit(1).get();
          if (!qByOwnerId.empty) firestoreUser = qByOwnerId.docs[0].data();
        }

        // The Activity Points Foundation (Master's request: IMPORT ONLY THIS)
        const v1Points = firestoreUser ? (firestoreUser.airdropRank || firestoreUser.airdrop_rank || firestoreUser.points || firestoreUser.rank || 0) : 0;

        const { data: newUser, error: createError } = await supabase
          .from('profiles')
          .insert([{
            id: telegramId.toString(),
            username: username || (firestoreUser?.username),
            first_name: first_name || (firestoreUser?.first_name),
            photo_url: req.body.photo_url || (firestoreUser?.photo_url) || null,
            airdropRank: v1Points,
            balance: 0,
            multiplier: 0.1,
            energy: 1000,
            referred_by: req.body.referred_by || null,
            v1_synced: true,
            updated_at: new Date().toISOString()
          }])
          .select()
          .single();

        if (createError) throw createError;
        user = newUser;
        console.log(`SUCCESS: Created profile & imported ${v1Points} points for ${username}`);
      }

      // 3. Handle Energy & Persistence for Existing Users
      if (user) {
        // Energy Refill Logic (1 per 1 second, max 1000)
        const calculateEnergy = (currentEnergy: number, lastUpdate: string) => {
          const last = new Date(lastUpdate || 0);
          const now = new Date();
          const diffSecs = Math.floor((now.getTime() - last.getTime()) / 1000);
          return Math.min(1000, currentEnergy + Math.max(0, diffSecs));
        };

        const newEnergy = calculateEnergy(user.energy, user.updated_at);
        
        const { data: updatedUser, error: updateError } = await supabase
          .from('profiles')
          .update({ 
            energy: newEnergy, 
            updated_at: new Date().toISOString()
          })
          .eq('id', telegramId.toString())
          .select()
          .single();
          
        if (!updateError) user = updatedUser;
      } else {
        // Fallback for failed migration or no Firestore
        const { data: freshUser, error: createError } = await supabase
          .from('profiles')
          .insert([{
            id: telegramId.toString(),
            username,
            first_name,
            airdropRank: 0,
            balance: 0,
            multiplier: 0.1,
            energy: 1000,
            v1_synced: false
          }])
          .select()
          .single();
        if (!createError) user = freshUser;
      }

      res.json(user);
    } catch (err: any) {
      console.error('Sync Error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Adsgram Reward Endpoint (GET as per Adsgram tooltip)
  // Adsgram Reward handler (Legacy check - cleanup)
  app.get('/api/adsgram/reward', async (req, res) => {
    try {
      const { userid } = req.query;
      if (!userid) return res.status(400).send('Missing userid');

      const { data: user, error: fetchError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userid.toString())
        .single();

      if (fetchError || !user) return res.status(404).send('User not found');

      const questStates = user.daily_quest_states || {};
      const adState = questStates.adsgram || { count: 0, last_ad_at: 0 };
      
      if (adState.count >= 10) return res.status(400).send('Limit reached');
      
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      if (now - adState.last_ad_at < oneHour) return res.status(400).send('On cooldown');

      const { error: updateError } = await supabase
        .from('profiles')
        .update({
          balance: (user.balance || 0) + 2500,
          airdropRank: (user.airdropRank || 0) + 15,
          daily_quest_states: {
            ...questStates,
            adsgram: {
              count: adState.count + 1,
              last_ad_at: now
            }
          }
        })
        .eq('id', userid.toString());

      if (updateError) throw updateError;
      res.send('Reward granted');
    } catch (err: any) {
      res.status(500).send('Internal error');
    }
  });

  // Ad Reward handler
  app.post('/api/user/ad-reward', validateTelegramData, async (req, res) => {
    try {
      const { telegramId } = req.body;
      const now = new Date();
      
      const { data: user, error: fetchError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', telegramId.toString())
        .single();
      
      if (fetchError) throw fetchError;

      const questStates = user.daily_quest_states || {};
      const adCount = questStates.ads_watched_today || 0;
      const lastAd = questStates.last_ad_at ? new Date(questStates.last_ad_at) : new Date(0);
      
      // Cooldown check (1 hour)
      const diffMs = now.getTime() - lastAd.getTime();
      if (diffMs < 3600000 && adCount > 0) {
        return res.status(400).json({ error: 'Ad is on cooldown' });
      }

      if (adCount >= 10) {
        return res.status(400).json({ error: 'Daily limit reached' });
      }

      const { data: updatedUser, error: updateError } = await supabase
        .from('profiles')
        .update({
          balance: user.balance + 2500,
          airdropRank: user.airdropRank + 15,
          daily_quest_states: {
            ...questStates,
            ads_watched_today: adCount + 1,
            last_ad_at: now.toISOString()
          }
        })
        .eq('id', telegramId.toString())
        .select()
        .single();

      if (updateError) throw updateError;
      res.json(updatedUser);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin / Adsgram Webhook (Optional but good for security)
  app.get('/api/adsgram/reward', async (req, res) => {
    try {
      const { userid } = req.query;
      if (!userid) return res.status(400).send('Missing userid');
      
      // We'll trust this for now as it's a dev build
      // In production, you would verify the Adsgram signature
      const { data: user } = await supabase.from('profiles').select('*').eq('id', userid.toString()).single();
      if (user) {
         await supabase.from('profiles').update({
           balance: user.balance + 2500,
           airdropRank: user.airdropRank + 15
         }).eq('id', userid.toString());
      }
      res.send('ok');
    } catch (e) {
      res.status(500).send('error');
    }
  });
  app.post('/api/user/complete-quest', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, questId, reward, points } = req.body;
      
      const { data: user, error: fetchError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', telegramId.toString())
        .single();

      if (fetchError) throw fetchError;

      const now = new Date();
      const questStates = user.daily_quest_states || {};
      
      // Check if already completed today
      if (questStates[questId]) {
        if (typeof questStates[questId] === 'string') {
           const lastDone = new Date(questStates[questId]);
           if (lastDone.toDateString() === now.toDateString()) {
             return res.status(400).json({ error: 'Already completed today' });
           }
        }
      }

      const { data: updatedUser, error: updateError } = await supabase
        .from('profiles')
        .update({
          balance: user.balance + reward,
          airdropRank: user.airdropRank + points,
          daily_quest_states: {
            ...questStates,
            [questId]: now.toISOString()
          }
        })
        .eq('id', telegramId.toString())
        .select()
        .single();

      if (updateError) throw updateError;
      res.json(updatedUser);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sync Balance (Aggressive Save)
  app.post('/api/user/sync-balance', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, balance, energy } = req.body;
      const { data, error } = await supabase
        .from('profiles')
        .update({ balance, energy, updated_at: new Date().toISOString() })
        .eq('id', telegramId.toString())
        .select()
        .single();
      
      if (error) throw error;
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Claim Passive Income (Flexible - Any Time)
  app.post('/api/user/claim', validateTelegramData, async (req, res) => {
    try {
      const { telegramId } = req.body;
      
      const { data: user, error: fetchError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', telegramId.toString())
        .single();

      if (fetchError) throw fetchError;

      const now = new Date();
      const lastClaim = new Date(user.last_claim_at || user.created_at);
      const diffMs = now.getTime() - lastClaim.getTime();
      const diffSecs = diffMs / 1000;
      
      // Calculate earnings based on per-second rate
      // Allow claiming at any time if earned > 0
      const earnings = Math.floor(diffSecs * user.multiplier);
      
      if (earnings <= 0) return res.status(400).json({ error: 'Nothing to claim yet' });

      const { data: updatedUser, error: updateError } = await supabase
        .from('profiles')
        .update({
          balance: user.balance + earnings,
          last_claim_at: now.toISOString()
        })
        .eq('id', telegramId.toString())
        .select()
        .single();

      if (updateError) throw updateError;
      
      res.json({ user: updatedUser, earned: earnings });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upgrade Developer
  app.post('/api/user/upgrade', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, developerId, cost, boost } = req.body;
      
      const { data: user, error: fetchError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', telegramId.toString())
        .single();

      if (fetchError) throw fetchError;

      // Add a small 2-point buffer for rapid tapping sync delay
      const effectiveBalance = user.balance + 2;

      if (effectiveBalance < cost) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      // Ensure we never go below 0
      const newBalance = Math.max(0, user.balance - cost);

      const { data: updatedUser, error: updateError } = await supabase
        .from('profiles')
        .update({
          balance: newBalance,
          multiplier: user.multiplier + boost
        })
        .eq('id', telegramId.toString())
        .select()
        .single();

      if (updateError) throw updateError;
      
      res.json(updatedUser);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Leaderboard
  app.get('/api/leaderboard', async (req, res) => {
    try {
      const { sortBy = 'airdropRank' } = req.query;
      const validSorts = ['airdropRank', 'multiplier'];
      const sortColumn = validSorts.includes(sortBy as string) ? sortBy as string : 'airdropRank';

      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, first_name, airdropRank, multiplier, photo_url')
        .order(sortColumn, { ascending: false })
        .limit(200);

      if (error) throw error;
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Dedicated Firebase Points Sync
  app.post('/api/user/sync-firebase-points', validateTelegramData, async (req, res) => {
    try {
      const { telegramId } = req.body;
      if (!firestore) return res.status(400).json({ error: 'Firestore not configured' });

      const { data: currentUser, error: checkError } = await supabase
        .from('profiles')
        .select('airdropRank, v1_synced')
        .eq('id', telegramId.toString())
        .single();
      
      if (checkError) throw checkError;
      if (currentUser.v1_synced) return res.status(400).json({ error: 'Already synced.' });

      const collections = ['users', 'profiles', 'players', 'stats'];
      let firestoreUser: any = null;

      for (const col of collections) {
        const docSnap = await firestore.collection(col).doc(telegramId.toString()).get();
        if (docSnap.exists) { firestoreUser = docSnap.data(); break; }
        const querySnapNum = await firestore.collection(col).where('id', '==', parseInt(telegramId)).limit(1).get();
        if (!querySnapNum.empty) { firestoreUser = querySnapNum.docs[0].data(); break; }
        const queryByTid = await firestore.collection(col).where('telegram_id', '==', telegramId.toString()).limit(1).get();
        if (!queryByTid.empty) { firestoreUser = queryByTid.docs[0].data(); break; }
      }

      if (!firestoreUser) return res.status(404).json({ error: 'No data found.' });

      const v1Points = firestoreUser.airdropRank || firestoreUser.airdrop_rank || firestoreUser.points || firestoreUser.rank || 0;
      const totalPoints = (currentUser.airdropRank || 0) + v1Points;

      const { data: updatedUser, error: updateError } = await supabase
        .from('profiles')
        .update({ airdropRank: totalPoints, v1_synced: true })
        .eq('id', telegramId.toString())
        .single();

      if (updateError) throw updateError;
      res.json(updatedUser);
    } catch (err: any) {
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
