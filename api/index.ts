import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';

dotenv.config();

const app = express();
app.use(express.json());

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Diagnostic logging (Hidden in production, but vital for debugging)
if (!supabaseUrl || !supabaseKey) {
  console.error("CRITICAL: Supabase environment variables are missing!");
} else if (!supabaseUrl.startsWith('https://')) {
  console.error("ERROR: SUPABASE_URL is malformed (must start with https://)");
} else if (supabaseUrl.endsWith('/')) {
  console.warn("WARNING: SUPABASE_URL has a trailing slash. This often causes 'Invalid Path' errors.");
}

let supabase: any;
try {
  supabase = createClient(supabaseUrl, supabaseKey);
} catch (err: any) {
  console.error("Supabase Client Init Error:", err.message);
}

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

// Global cache for leaderboard to save quotas
const leaderboardCaches: Record<string, { data: any[], expires: number }> = {};

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/user/sync', validateTelegramData, async (req, res) => {
  try {
    const { telegramId, username, first_name, photo_url, referred_by } = req.body;
    const idStr = telegramId?.toString();
    if (!idStr || !verifyUserMatch(req, idStr)) return res.status(403).json({ error: 'FORBIDDEN' });

    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('id', idStr)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      throw fetchError;
    }

    let currentUser = user;

    if (!currentUser) {
      // Reward referrer if exists
      if (referred_by) {
        try {
          const { data: referrer, error: refFetchError } = await supabase
            .from('users')
            .select('balance, airdropRank')
            .eq('id', referred_by.toString())
            .single();

          if (referrer) {
            await supabase
              .from('users')
              .update({
                balance: (referrer.balance || 0) + 25000,
                airdropRank: (referrer.airdropRank || 0) + 50,
                updated_at: new Date().toISOString()
              })
              .eq('id', referred_by.toString());
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
        tap_value: 1,
        daily_taps: 0,
        airdropRank: 0,
        energy: 1000, 
        daily_quest_states: {},
        completed_missions: [],
        upgrades: {},
        last_claim_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };

      const { data: insertedUser, error: insertError } = await supabase
        .from('users')
        .insert([newUser])
        .select()
        .single();
      
      if (insertError) throw insertError;
      currentUser = insertedUser;
    } else {
      // Logic for Day Reset and Energy Refill
      const lastUpdate = new Date(currentUser.updated_at);
      const todayStr = new Date().toDateString();
      const lastDateStr = lastUpdate.toDateString();
      
      const diffSecs = Math.floor((Date.now() - lastUpdate.getTime()) / 1000);
      let currentEnergy = currentUser.energy || 0;
      let currentDailyTaps = currentUser.daily_taps || 0;

      // refill energy +1 per sec up to 1000
      currentEnergy = Math.min(1000, currentEnergy + Math.max(0, diffSecs));

      // daily taps reset
      if (todayStr !== lastDateStr) {
        currentDailyTaps = 0;
      }

      const { data: updatedUser, error: updateError } = await supabase
        .from('users')
        .update({
          energy: currentEnergy,
          daily_taps: currentDailyTaps,
          updated_at: new Date().toISOString()
        })
        .eq('id', idStr)
        .select()
        .single();
      
      if (!updateError) currentUser = updatedUser;
    }

    const { count, error: countError } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('referred_by', idStr);

    res.json({ ...currentUser, referralCount: count || 0 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const grantAdReward = async (id: string) => {
  const { data: user, error: fetchError } = await supabase
    .from('users')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !user) return null;

  const questStates = user.daily_quest_states || {};
  const adState = questStates.adsgram || { count: 0, last_ad_at: 0 };
  const today = new Date().toDateString();
  const lastDate = new Date(adState.last_ad_at || 0).toDateString();
  const countToday = today === lastDate ? adState.count : 0;
  if (countToday >= 10) return null;

  const { data: updated, error: updateError } = await supabase
    .from('users')
    .update({
      balance: (user.balance || 0) + 2500,
      airdropRank: (user.airdropRank || 0) + 15,
      daily_quest_states: { ...questStates, adsgram: { count: countToday + 1, last_ad_at: Date.now() } }
    })
    .eq('id', id)
    .select()
    .single();

  return updated;
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
    
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('id', telegramId.toString())
      .single();

    if (!user) throw new Error('User not found');

    const tapValue = user.tap_value || 1;
    const actualTaps = Math.min(taps || 0, user.energy || 0);

    if (actualTaps <= 0 && taps > 0) {
      return res.json(user);
    }

    const reward = actualTaps * tapValue;

    const { data: updated, error: updateError } = await supabase
      .from('users')
      .update({ 
        balance: (user.balance || 0) + reward, 
        energy: (user.energy || 0) - actualTaps,
        daily_taps: (user.daily_taps || 0) + actualTaps,
        updated_at: new Date().toISOString() 
      })
      .eq('id', telegramId.toString())
      .select()
      .single();

    if (updateError) throw updateError;
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/claim', validateTelegramData, async (req, res) => {
  try {
    const { telegramId } = req.body;
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });

    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('id', telegramId.toString())
      .single();

    if (!user) throw new Error('User not found');

    const lastClaim = new Date(user.last_claim_at || user.created_at);
    const earnings = Math.floor(((Date.now() - lastClaim.getTime()) / 1000) * (user.multiplier || 0.1));
    if (earnings <= 0) return res.status(400).json({ error: 'Nothing to claim yet' });

    const { data: updated, error: updateError } = await supabase
      .from('users')
      .update({
        balance: (user.balance || 0) + earnings,
        last_claim_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', telegramId.toString())
      .select()
      .single();

    if (updateError) throw updateError;
    res.json({ user: updated, earned: earnings });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/complete-quest', validateTelegramData, async (req, res) => {
  try {
    const { telegramId, questId, reward, points, type } = req.body;
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });

    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('id', telegramId.toString())
      .single();

    if (!user) throw new Error('User not found');

    if (type === 'social') {
      const completed = user.completed_missions || [];
      if (completed.includes(questId)) {
        return res.status(400).json({ error: 'Already completed' });
      }
      const { data: updated, error: updateError } = await supabase
        .from('users')
        .update({
          balance: (user.balance || 0) + reward,
          airdropRank: (user.airdropRank || 0) + points,
          completed_missions: [...completed, questId]
        })
        .eq('id', telegramId.toString())
        .select()
        .single();

      if (updateError) throw updateError;
      return res.json(updated);
    } else {
      const questStates = user.daily_quest_states || {};
      const now = new Date();

      if (questStates[questId]) {
        const last = new Date(questStates[questId]);
        if (last.toDateString() === now.toDateString()) {
          return res.status(400).json({ error: 'Already done today' });
        }
      }

      const { data: updated, error: updateError } = await supabase
        .from('users')
        .update({
          balance: (user.balance || 0) + reward,
          airdropRank: (user.airdropRank || 0) + points,
          daily_quest_states: { ...questStates, [questId]: now.toISOString() }
        })
        .eq('id', telegramId.toString())
        .select()
        .single();

      if (updateError) throw updateError;
      return res.json(updated);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/upgrade', validateTelegramData, async (req, res) => {
  try {
    const { telegramId, developerId, cost, boost, upgradeType = 'income' } = req.body;
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });

    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('id', telegramId.toString())
      .single();

    if (!user) throw new Error('User not found');

    if ((user.balance || 0) < cost) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const upgrades = user.upgrades || {};
    const nextLevel = (upgrades[developerId] || 0) + 1;
    const newUpgrades = { ...upgrades, [developerId]: nextLevel };

    if (upgradeType === 'tap') {
      const currentTap = user.tap_value || 1;
      if (currentTap >= 100) return res.status(400).json({ error: 'Max level reached' });

      const { data: updated, error: updateError } = await supabase
        .from('users')
        .update({
          balance: (user.balance || 0) - cost,
          upgrades: newUpgrades,
          tap_value: (user.tap_value || 1) + boost,
          updated_at: new Date().toISOString()
        })
        .eq('id', telegramId.toString())
        .select()
        .single();

      if (updateError) throw updateError;
      return res.json(updated);
    } else {
      const { data: updated, error: updateError } = await supabase
        .from('users')
        .update({
          balance: (user.balance || 0) - cost,
          upgrades: newUpgrades,
          multiplier: (user.multiplier || 0.1) + boost,
          updated_at: new Date().toISOString()
        })
        .eq('id', telegramId.toString())
        .select()
        .single();
        
      if (updateError) throw updateError;
      return res.json(updated);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const { sortBy = 'airdropRank', userId } = req.query;
    const validSorts = ['airdropRank', 'multiplier', 'balance'];
    const sortColumn = validSorts.includes(sortBy as string) ? sortBy as string : 'airdropRank';

    const cacheKey = `${sortColumn}`;
    const now = Date.now();
    
    // Cache logic
    if (!leaderboardCaches[cacheKey] || now > leaderboardCaches[cacheKey].expires) {
      const { data: top20, error: fetchError } = await supabase
        .from('users')
        .select('*')
        .order(sortColumn, { ascending: false })
        .limit(20);

      if (fetchError) throw fetchError;

      leaderboardCaches[cacheKey] = {
        data: top20 || [],
        expires: now + (15 * 60 * 1000)
      };
    }

    let userRank = 0;
    if (userId) {
      const { data: userData } = await supabase
        .from('users')
        .select(sortColumn)
        .eq('id', userId.toString())
        .single();

      if (userData) {
        const userValue = userData[sortColumn] || 0;
        const { count, error: rankError } = await supabase
          .from('users')
          .select('*', { count: 'exact', head: true })
          .gt(sortColumn, userValue);
        if (!rankError) userRank = (count || 0) + 1;
      }
    }

    res.json({ 
      top20: leaderboardCaches[cacheKey].data, 
      userRank, 
      lastUpdate: leaderboardCaches[cacheKey].expires - (15 * 60 * 1000) 
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default app;
