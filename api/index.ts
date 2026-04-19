import express from 'express';
import { createClient } from '@supabase/supabase-js';
import admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// Firebase Setup (Migration Bridge)
const firebaseServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) 
  : null;

if (firebaseServiceAccount && !admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(firebaseServiceAccount)
  });
}
const firestore = firebaseServiceAccount ? admin.firestore() : null;

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// --- API Routes ---

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Sync endpoint
app.post('/api/user/sync', async (req, res) => {
  try {
    const { telegramId, username, first_name, photo_url, referred_by } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'telegramId is required' });

    // 1. Check Supabase
    let { data: user, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', telegramId.toString())
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    // 2. Migration Bridge
    if (!user && firestore) {
      const docRef = firestore.collection('users').doc(telegramId.toString());
      const docSnap = await docRef.get();
      
      if (docSnap.exists) {
        const firestoreUser = docSnap.data() as any;
        const migratedData = {
          id: telegramId.toString(),
          username: firestoreUser.username || username,
          first_name: firestoreUser.first_name || first_name,
          photo_url: photo_url || null,
          balance: firestoreUser.balance || 0,
          active_multiplier: firestoreUser.multiplier || 0.1,
          airdrop_rank: firestoreUser.rank || firestoreUser.airdrop_rank || 0,
          energy: firestoreUser.energy || 1000,
          game_tickets: firestoreUser.game_tickets || 5,
          extra_combat_matches: firestoreUser.extra_combat_matches || 0,
          combat_matches_today: 0,
          last_claim_at: new Date().toISOString()
        };

        const { data: newUser, error: createError } = await supabase
          .from('profiles')
          .insert([migratedData])
          .select()
          .single();

        if (!createError) user = newUser;
      }
    }

    // 3. New User
    if (!user) {
      const { data: newUser, error: createError } = await supabase
        .from('profiles')
        .insert([{
          id: telegramId.toString(),
          username,
          first_name,
          photo_url,
          referred_by: referred_by || null,
          balance: 0,
          active_multiplier: 0.1,
          energy: 1000,
          game_tickets: 5,
          airdrop_rank: 0,
          last_claim_at: new Date().toISOString()
        }])
        .select()
        .single();
      
      if (!createError) {
        user = newUser;

        // --- REFERRAL LOGIC ---
        // Give the referrer 50 activity points
        if (referred_by && referred_by !== telegramId.toString()) {
           const { data: referrer } = await supabase.from('profiles').select('airdrop_rank').eq('id', referred_by).single();
           if (referrer) {
              await supabase.from('profiles').update({ airdrop_rank: (referrer.airdrop_rank || 0) + 50 }).eq('id', referred_by);
           }
        }
      }
    } else if (photo_url && user.photo_url !== photo_url) {
      // Update photo if changed in Telegram
      await supabase.from('profiles').update({ photo_url }).eq('id', telegramId.toString());
      user.photo_url = photo_url;
    }

    res.json(user);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Add other routes identical to server.ts here...
// (I will keep this focused for the sync migration)

// Claim Passive Income
app.post('/api/user/claim', async (req, res) => {
  try {
    const { telegramId } = req.body;
    const { data: user, error: fetchError } = await supabase.from('profiles').select('*').eq('id', telegramId.toString()).single();
    if (fetchError) throw fetchError;

    const now = new Date();
    const lastClaim = new Date(user.last_claim_at);
    const diffHrs = (now.getTime() - lastClaim.getTime()) / (1000 * 60 * 60);
    const earnings = Math.floor(Math.min(diffHrs, 4) * 3600 * user.active_multiplier);

    const { data: updatedUser, error: updateError } = await supabase
      .from('profiles')
      .update({ balance: user.balance + earnings, last_claim_at: now.toISOString() })
      .eq('id', telegramId.toString()).select().single();
    if (updateError) throw updateError;
    res.json({ user: updatedUser, earned: earnings });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Upgrade Developer
app.post('/api/user/upgrade', async (req, res) => {
  try {
    const { telegramId, cost, boost } = req.body;
    const { data: user, error: fetchError } = await supabase.from('profiles').select('*').eq('id', telegramId.toString()).single();
    if (fetchError) throw fetchError;
    if (user.balance < cost) return res.status(400).json({ error: 'Insufficient balance' });

    const { data: updatedUser, error: updateError } = await supabase
      .from('profiles')
      .update({ balance: user.balance - cost, active_multiplier: user.active_multiplier + boost })
      .eq('id', telegramId.toString()).select().single();
    if (updateError) throw updateError;
    res.json(updatedUser);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { data, error } = await supabase.from('profiles').select('id, username, first_name, airdrop_rank').order('airdrop_rank', { ascending: false }).limit(200);
    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default app;
