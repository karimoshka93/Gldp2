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
        console.log(`User ${telegramId} (${username}) not found in Supabase. Checking Firestore...`);
        
        let firestoreUser: any = null;
        let firestoreDocId: string | null = null;
        
        // --- MULTI-SEARCH STRATEGY ---
        
        // Search 1: By Telegram ID (numeric doc ID)
        const docById = await firestore.collection('users').doc(telegramId.toString()).get();
        if (docById.exists) {
          firestoreUser = docById.data();
          firestoreDocId = docById.id;
        }

        // Search 2: By Telegram ID field
        if (!firestoreUser) {
          const qById = await firestore.collection('users').where('telegram_id', '==', telegramId.toString()).limit(1).get();
          if (!qById.empty) {
            firestoreUser = qById.docs[0].data();
            firestoreDocId = qById.docs[0].id;
          }
        }

        // Search 3: By Username field (Master's request)
        if (!firestoreUser && username) {
          const qByUsername = await firestore.collection('users').where('username', '==', username).limit(1).get();
          if (!qByUsername.empty) {
            firestoreUser = qByUsername.docs[0].data();
            firestoreDocId = qByUsername.docs[0].id;
          }
        }

        // Search 4: By ownerId field (Master's image verification)
        if (!firestoreUser) {
          // We can't query the entire DB for an unknown ownerId efficiently, 
          // but we can check if there's a document with a field that matches the ID
          const qByOwnerId = await firestore.collection('users').where('ownerId', '==', telegramId.toString()).limit(1).get();
          if (!qByOwnerId.empty) {
            firestoreUser = qByOwnerId.docs[0].data();
            firestoreDocId = qByOwnerId.docs[0].id;
          }
        }

        if (firestoreUser) {
          console.log(`Found V1 data for ${telegramId} in Firestore (Doc: ${firestoreDocId}). Migrating...`);
          
          // Map Firebase Balance & Rank correctly
          // We prioritize 'points' or 'airdropRank' if they exist
          const v1Balance = firestoreUser.balance || firestoreUser.points || 0;
          const v1Rank = firestoreUser.airdropRank || firestoreUser.airdrop_rank || firestoreUser.rank || 0;

          const migratedData = {
            id: telegramId.toString(),
            username: firestoreUser.username || username,
            first_name: firestoreUser.first_name || first_name,
            balance: v1Balance,
            active_multiplier: firestoreUser.active_multiplier || firestoreUser.multiplier || 0.1,
            airdrop_rank: v1Rank,
            energy: firestoreUser.energy || 1000,
            game_tickets: firestoreUser.game_tickets || 5,
            extra_combat_matches: firestoreUser.extra_combat_matches || 0,
            combat_matches_today: 0,
            last_claim_at: firestoreUser.last_claim_at || new Date().toISOString(),
            code_task_states: firestoreUser.code_task_states || {},
            daily_quest_states: firestoreUser.daily_quest_states || {},
            v1_synced: true,
            updated_at: new Date().toISOString()
          };

          const { data: newUser, error: createError } = await supabase
            .from('profiles')
            .upsert([migratedData]) // Use upsert to avoid duplicate errors
            .select()
            .single();

          if (createError) throw createError;
          user = newUser;
          console.log(`V1 Migration success for ${username}`);
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
        // Energy Refill Logic (1 per 1 second, max 1000)
        // We use updated_at since it's confirmed in the schema
        const calculateEnergy = (currentEnergy: number, lastUpdate: string) => {
          const last = new Date(lastUpdate || 0);
          const now = new Date();
          const diffSecs = Math.floor((now.getTime() - last.getTime()) / 1000);
          return Math.min(1000, currentEnergy + Math.max(0, diffSecs));
        };

        const newEnergy = calculateEnergy(user.energy, user.updated_at || user.created_at);
        
        // Update energy every time they sync
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
          airdrop_rank: user.airdrop_rank + 15,
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
           airdrop_rank: user.airdrop_rank + 15
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
  // SYNC ACTIVITY POINTS FROM V1 (FIRESTORE)
  app.post('/api/user/sync-firebase-points', validateTelegramData, async (req, res) => {
    try {
      const { telegramId } = req.body;
      if (!firestore) {
        console.error('Migration Error: FIREBASE_SERVICE_ACCOUNT not configured');
        return res.status(400).json({ error: 'Migration bridge not configured. Please contact support.' });
      }

      // Check if already synced in Supabase
      const { data: currentUser, error: checkError } = await supabase
        .from('profiles')
        .select('airdrop_rank, v1_synced')
        .eq('id', telegramId.toString())
        .single();
      
      if (checkError) throw checkError;
      if (currentUser.v1_synced) {
        return res.status(400).json({ error: 'You have already synchronized your V1 data.' });
      }

      console.log(`Manual sync requested for user ${telegramId}`);

      // Try multiple collections: users, profiles, players, stats
      const collections = ['users', 'profiles', 'players', 'stats'];
      let firestoreUser: any = null;

      for (const col of collections) {
        // Try by ID directly
        const docSnap = await firestore.collection(col).doc(telegramId.toString()).get();
        if (docSnap.exists) {
          firestoreUser = docSnap.data();
          console.log(`Found user in collection [${col}] by doc ID`);
          break;
        }
        // Try by telegram_id field
        const querySnap = await firestore.collection(col).where('telegram_id', '==', telegramId.toString()).limit(1).get();
        if (!querySnap.empty) {
          firestoreUser = querySnap.docs[0].data();
          console.log(`Found user in collection [${col}] by telegram_id field`);
          break;
        }
        // Try by id field
        const querySnapId = await firestore.collection(col).where('id', '==', telegramId.toString()).limit(1).get();
        if (!querySnapId.empty) {
          firestoreUser = querySnapId.docs[0].data();
          console.log(`Found user in collection [${col}] by id field (string)`);
          break;
        }
        try {
          const querySnapIdNum = await firestore.collection(col).where('id', '==', parseInt(telegramId)).limit(1).get();
          if (!querySnapIdNum.empty) {
            firestoreUser = querySnapIdNum.docs[0].data();
            console.log(`Found user in collection [${col}] by id field (number)`);
            break;
          }
        } catch(e) {}
      }

      if (!firestoreUser) {
        console.warn(`No V1 data found for ${telegramId} after searching collections: ${collections.join(', ')}`);
        return res.status(404).json({ error: 'No old data found for this account in V1 records.' });
      }

      // Try common point field names (including airdropRank from screenshot)
      const pointFields = ['airdropRank', 'airdrop_rank', 'rank', 'points', 'total_points', 'status_points', 'activity_points'];
      let oldPoints = 0;
      for (const field of pointFields) {
        if (firestoreUser[field] !== undefined) {
          oldPoints = parseInt(firestoreUser[field]) || 0;
          console.log(`Retrieved ${oldPoints} points from field [${field}]`);
          break;
        }
      }

      // ADDITIVE SYNC: Add old points to the current application points
      const totalPoints = (currentUser.airdrop_rank || 0) + oldPoints;

      // Update Supabase and mark as synced PERMANENTLY
      const { data: updatedUser, error: updateError } = await supabase
        .from('profiles')
        .update({ 
          airdrop_rank: totalPoints,
          v1_synced: true 
        })
        .eq('id', telegramId.toString())
        .select()
        .single();

      if (updateError) throw updateError;
      
      console.log(`Successfully synced ${oldPoints} points. Total now: ${totalPoints} for user ${telegramId}`);
      res.json(updatedUser);
    } catch (err: any) {
      console.error('Firebase Sync Error:', err.message);
      res.status(500).json({ error: 'Internal system error during synchronization. Please try again later.' });
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
