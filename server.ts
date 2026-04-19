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

      // 2. If not in Supabase, try migrating from Firestore
      if (!user && firestore) {
        console.log(`User ${telegramId} not found in Supabase. Checking Firestore...`);
        
        // Try to find user in Firestore "users" collection
        // Assuming the document ID is the telegramId or it has a telegramId field
        let firestoreUser: any = null;
        
        // First try doc ID
        const docRef = firestore.collection('users').doc(telegramId.toString());
        const docSnap = await docRef.get();
        
        if (docSnap.exists) {
          firestoreUser = docSnap.data();
        } else {
          // Then try querying by field
          const querySnap = await firestore.collection('users').where('telegram_id', '==', telegramId.toString()).limit(1).get();
          if (!querySnap.empty) {
            firestoreUser = querySnap.docs[0].data();
          }
        }

        if (firestoreUser) {
          console.log(`Found user ${telegramId} in Firestore. Migrating...`);
          
          // Map Firestore fields to Supabase schema
          const migratedData = {
            id: telegramId.toString(),
            username: firestoreUser.username || username,
            first_name: firestoreUser.first_name || first_name,
            balance: firestoreUser.balance || 0,
            active_multiplier: firestoreUser.active_multiplier || firestoreUser.multiplier || 0.1,
            airdrop_rank: firestoreUser.airdrop_rank || firestoreUser.rank || 0,
            energy: firestoreUser.energy || 1000,
            game_tickets: firestoreUser.game_tickets || 5,
            extra_combat_matches: firestoreUser.extra_combat_matches || 0,
            combat_matches_today: 0,
            last_claim_at: firestoreUser.last_claim_at || new Date().toISOString(),
            code_task_states: firestoreUser.code_task_states || {},
            daily_quest_states: firestoreUser.daily_quest_states || {}
          };

          const { data: newUser, error: createError } = await supabase
            .from('profiles')
            .insert([migratedData])
            .select()
            .single();

          if (createError) throw createError;
          user = newUser;
          console.log(`Migration successful for user ${telegramId}`);
        }
      }

      // 3. If still no user, create a fresh one
      if (!user) {
        const { data: newUser, error: createError } = await supabase
          .from('profiles')
          .insert([
            {
              id: telegramId.toString(),
              username,
              first_name,
              balance: 0,
              active_multiplier: 0.1,
              airdrop_rank: 0,
              energy: 1000,
              game_tickets: 5,
              extra_combat_matches: 0,
              combat_matches_today: 0,
              last_claim_at: new Date().toISOString(),
              last_energy_reset_at: new Date().toISOString(),
              code_task_states: {},
              daily_quest_states: {}
            }
          ])
          .select()
          .single();

        if (createError) throw createError;
        user = newUser;
      } else {
        // Daily Energy Reset Check
        const now = new Date();
        const lastReset = user.last_energy_reset_at ? new Date(user.last_energy_reset_at) : new Date(0);
        
        // Reset if it's a different calendar day
        if (now.toDateString() !== lastReset.toDateString()) {
           const { data: updatedUser, error: updateError } = await supabase
            .from('profiles')
            .update({
              energy: 1000,
              last_energy_reset_at: now.toISOString()
            })
            .eq('id', telegramId.toString())
            .select()
            .single();
          
          if (!updateError) user = updatedUser;
        }
      }

      res.json(user);
    } catch (err: any) {
      console.error('Sync Error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Adsgram Reward Endpoint (GET as per Adsgram tooltip)
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

      // Check ad count/cooldown
      const questStates = user.daily_quest_states || {};
      const adState = questStates.adsgram || { count: 0, last_ad_at: 0 };
      
      if (adState.count >= 10) return res.status(400).send('Limit reached');
      
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      if (now - adState.last_ad_at < oneHour) return res.status(400).send('On cooldown');

      // Update user
      const { error: updateError } = await supabase
        .from('profiles')
        .update({
          balance: user.balance + 2500,
          airdrop_rank: user.airdrop_rank + 15,
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
      console.error('Adsgram Reward Error:', err);
      res.status(500).send('Internal error');
    }
  });

  // Manual Quest Complete (For social links)
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
          airdrop_rank: user.airdrop_rank + points,
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
        .update({ balance, energy })
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
      const lastClaim = new Date(user.last_claim_at);
      const diffMs = now.getTime() - lastClaim.getTime();
      const diffSecs = diffMs / 1000;
      
      // Calculate earnings based on per-second rate
      // Allow claiming at any time if earned > 0
      const earnings = Math.floor(diffSecs * user.active_multiplier);
      
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
          active_multiplier: user.active_multiplier + boost
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
      const { sortBy = 'airdrop_rank' } = req.query;
      const validSorts = ['airdrop_rank', 'active_multiplier'];
      const sortColumn = validSorts.includes(sortBy as string) ? sortBy as string : 'airdrop_rank';

      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, first_name, airdrop_rank, active_multiplier, photo_url')
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
      if (!firestore) return res.status(400).json({ error: 'Migration bridge not configured' });

      // Look up in Firestore
      const docRef = firestore.collection('users').doc(telegramId.toString());
      const docSnap = await docRef.get();
      let firestoreUser: any = null;

      if (docSnap.exists) {
        firestoreUser = docSnap.data();
      } else {
        const querySnap = await firestore.collection('users').where('telegram_id', '==', telegramId.toString()).limit(1).get();
        if (!querySnap.empty) firestoreUser = querySnap.docs[0].data();
      }

      if (!firestoreUser) return res.status(404).json({ error: 'No old data found for this user' });

      const oldPoints = firestoreUser.airdrop_rank || firestoreUser.rank || 0;

      // Update Supabase
      const { data: updatedUser, error: updateError } = await supabase
        .from('profiles')
        .update({ airdrop_rank: oldPoints })
        .eq('id', telegramId.toString())
        .select()
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
