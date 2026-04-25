import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Diagnostic logging
if (!supabaseUrl || !supabaseKey) {
    console.error("DIAGNOSTIC: Supabase environment variables are missing in this environment.");
} else if (supabaseUrl.endsWith('/')) {
    console.warn("DIAGNOSTIC: SUPABASE_URL ends with a slash. This usually breaks the SDK.");
}

let supabase: any;
try {
    supabase = createClient(supabaseUrl, supabaseKey);
    // Verification Heartbeat
    supabase.from('users').select('count', { count: 'exact', head: true }).limit(1)
        .then(() => console.log("[DATABASE] Connection Verified: Service Role Key is operational."))
        .catch((err: any) => console.error("[DATABASE] Connection Failed. Check your keys and RLS. Error:", err.message));
} catch (err: any) {
    console.error("DIAGNOSTIC: Supabase initialization failed:", err.message);
}

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

  // --- Helper: Universal Daily Reset ---
  const checkAndResetDailyData = async (user: any) => {
    const now = new Date();
    const lastReset = user.combat_last_reset ? new Date(user.combat_last_reset) : null;
    
    const isNewDay = !lastReset || 
      lastReset.getFullYear() !== now.getFullYear() || 
      lastReset.getMonth() !== now.getMonth() || 
      lastReset.getDate() !== now.getDate();

    if (isNewDay) {
      console.log(`[DAILY-RESET] Triggering reset for user: ${user.id}`);
      const resetData = {
        daily_taps: 0,
        combat_matches_free: 0,
        combat_matches_ads: 0,
        combat_daily_ads_watched: 0,
        combat_extra_charges: 0,
        daily_quest_states: {},
        combat_last_reset: now.toISOString(),
        updated_at: now.toISOString()
      };

      const { data: updated, error } = await supabase
        .from('users')
        .update(resetData)
        .eq('id', user.id)
        .select()
        .single();
      
      if (error) {
        console.error(`[DAILY-RESET] Failed for user ${user.id}:`, error.message);
        return user;
      }
      return updated;
    }
    return user;
  };

  // Sync endpoint - Handles initial connection and energy refill
  app.post('/api/user/sync', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, username, first_name, photo_url, referred_by } = req.body;
      const idStr = telegramId?.toString();
      
      if (!idStr) return res.status(400).json({ error: 'telegramId required' });
      if (!verifyUserMatch(req, idStr)) return res.status(403).json({ error: 'FORBIDDEN' });

      let { data: user, error: fetchError } = await supabase
        .from('users')
        .select('*')
        .eq('id', idStr)
        .single();

      if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;

      if (user) {
        // Universal Reset Check
        user = await checkAndResetDailyData(user);
      } else {
        console.log(`[SYNC] REGISTERING NEW SUPABASE USER: ${idStr}`);
        
        // Reward referrer if exists
        if (referred_by) {
          try {
            const { data: referrer } = await supabase
              .from('users')
              .select('balance, airdropRank')
              .eq('id', referred_by.toString())
              .single();

            if (referrer) {
              await supabase.from('users').update({
                balance: (referrer.balance || 0) + 25000,
                airdropRank: (referrer.airdropRank || 0) + 50,
                updated_at: new Date().toISOString()
              }).eq('id', referred_by.toString());
            }
          } catch (refErr) {}
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
          combat_matches_free: 0,
          combat_matches_ads: 0,
          combat_daily_ads_watched: 0,
          combat_extra_charges: 0,
          combat_last_reset: new Date().toISOString()
        };

        const { data: insertedUser, error: insertError } = await supabase
          .from('users')
          .insert([newUser])
          .select()
          .single();

        if (insertError) throw insertError;
        user = insertedUser;
      }

      // Restore Energy Refill Logic
      if (user) {
        const lastUpdate = new Date(user.updated_at);
        const diffSecs = Math.floor((Date.now() - lastUpdate.getTime()) / 1000);
        let currentEnergy = user.energy || 0;
        
        // refill energy +1 per sec up to 1000
        currentEnergy = Math.min(1000, currentEnergy + Math.max(0, diffSecs));

        if (currentEnergy !== user.energy) {
          const { data: updatedUser } = await supabase
            .from('users')
            .update({
              energy: currentEnergy,
              updated_at: new Date().toISOString()
            })
            .eq('id', idStr)
            .select()
            .single();
          
          if (updatedUser) user = updatedUser;
        }
      }

      // Get referral count
      const { count } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('referred_by', idStr);

      res.json({ ...user, referralCount: count || 0 });
    } catch (err: any) {
      console.error('[SYNC] Fatal Error:', err.message);
      res.status(500).json({ error: 'Sync failed.' });
    }
  });

  // Unified Adsgram Reward
  const grantAdReward = async (id: string, questId: string = 'adsgram') => {
    try {
      console.log(`[REWARD-SYSTEM] Processing Reward for User: ${id}, Quest: ${questId}`);
      
      let { data: user, error: fetchError } = await supabase
        .from('users')
        .select('*')
        .eq('id', id.toString())
        .single();

      if (fetchError || !user) {
        console.error(`[REWARD-SYSTEM] User fetch failed for ${id}:`, fetchError?.message);
        return null;
      }

      // Ensure reset happens before rewarding
      user = await checkAndResetDailyData(user);

      const questStates = user.daily_quest_states || {};
      let adState = questStates[questId];
      
      // Migration/Hardening: If adState is a string (legacy) or missing, convert to object
      if (typeof adState === 'string' || !adState) {
        adState = { count: 0, last_ad_at: 0 };
      }

      const today = new Date().toDateString();
      const lastDate = new Date(adState.last_ad_at || 0).toDateString();
      const countToday = today === lastDate ? (Number(adState.count) || 0) : 0;

      let rewardGldp = 2500;
      let rewardPoints = 15;

      if (questId === 'adsgram_red') {
        rewardGldp = 2000;
        rewardPoints = 10;
      }

      const currentBalance = Number(user.balance || 0);
      const currentRank = Number(user.airdropRank || 0);
      const newCount = countToday + 1;

      console.log(`[REWARD-SYSTEM] Updating: Balance +${rewardGldp}, Rank +${rewardPoints}, Count: ${newCount}`);

      const { data: updated, error: updateError } = await supabase
        .from('users')
        .update({
          balance: currentBalance + rewardGldp,
          airdropRank: currentRank + rewardPoints,
          daily_quest_states: { 
            ...questStates, 
            [questId]: { 
              count: newCount, 
              last_ad_at: Date.now(),
              // Keep an ISO string for UI compatibility if needed
              completed_at: new Date().toISOString() 
            } 
          },
          updated_at: new Date().toISOString()
        })
        .eq('id', id.toString())
        .select()
        .single();
      
      if (updateError) {
        console.error(`[REWARD-SYSTEM] Update failed:`, updateError.message);
        return null;
      }

      console.log(`[REWARD-SYSTEM] Success for ${id}. New Balance: ${updated.balance}`);
      return updated;
    } catch (err: any) {
      console.error(`[REWARD-SYSTEM] Fatal Exception:`, err.message);
      return null;
    }
  };


  app.get('/api/adsgram/reward', async (req, res) => {
    const userid = req.query.userid || req.query.userId || req.query.user_id;
    const questId = req.query.questId?.toString() || 'adsgram';
    console.log(`[ADSGRAM-WEBHOOK] Firebase ping received for user: ${userid} quest: ${questId}`);
    
    if (!userid) {
      console.warn('[ADSGRAM-WEBHOOK] Missing userid parameter in request');
      return res.status(400).send('missing userid');
    }
    
    const success = await grantAdReward(userid.toString(), questId);
    res.send(success ? 'ok' : 'error');
  });

  app.post('/api/user/ad-reward', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, questId } = req.body;
      if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });
      
      const updated = await grantAdReward(telegramId.toString(), questId || 'adsgram');
      if (updated) {
        res.json(updated);
      } else {
        res.status(400).json({ error: 'Reward failed or limit reached' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/user/complete-quest', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, questId, reward, points, type } = req.body;
      const idStr = telegramId.toString();

      if (!verifyUserMatch(req, telegramId)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

      const { data: user, error: fetchError } = await supabase
        .from('users')
        .select('*')
        .eq('id', idStr)
        .single();
        
      if (!user) throw new Error('User not found');

      // Universal Reset Check
      user = await checkAndResetDailyData(user);

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
          .eq('id', idStr)
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
          .eq('id', idStr)
          .select()
          .single();
        
        if (updateError) throw updateError;
        return res.json(updated);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Secure Tapping Sync (Restored Energy Logic)
  app.post('/api/user/sync-taps', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, taps } = req.body;
      const idStr = telegramId?.toString();
      if (!idStr) return res.status(400).json({ error: 'missing id' });

      if (!verifyUserMatch(req, telegramId)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

      const { data: user, error: fetchError } = await supabase
        .from('users')
        .select('*')
        .eq('id', idStr)
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
          daily_taps: (user.daily_taps || 0) + actualTaps, // Still tracking daily taps for stats
          updated_at: new Date().toISOString() 
        })
        .eq('id', idStr)
        .select()
        .single();
      
      if (updateError) throw updateError;
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

      const { data: user, error: fetchError } = await supabase
        .from('users')
        .select('*')
        .eq('id', telegramId.toString())
        .single();

      if (!user) throw new Error('User not found');

      const now = new Date();
      const lastClaim = new Date(user.last_claim_at || user.created_at);
      const diffSecs = (now.getTime() - lastClaim.getTime()) / 1000;
      const earnings = Math.floor(Math.max(0, diffSecs) * (user.multiplier || 0.1));
      
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

  // Upgrade Developer
  app.post('/api/user/upgrade', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, developerId, cost, boost, upgradeType = 'income' } = req.body;
      
      if (!verifyUserMatch(req, telegramId)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

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

      const updateFields: any = {
        balance: (user.balance || 0) - cost,
        [`upgrades.${developerId}`]: nextLevel, // Note: For JSONB updates, we might need a more specific query if nested paths are complex
        updated_at: new Date().toISOString()
      };

      // Handle JSONB update for upgrades correctly in Supabase/Postgres
      const newUpgrades = { ...upgrades, [developerId]: nextLevel };

      if (upgradeType === 'tap') {
        const currentTap = user.tap_value || 1;
        if (currentTap >= 100) return res.status(400).json({ error: 'Maximum Tap Performance Reached' });
        
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
        console.log(`[LEADERBOARD] Refreshing Cache for ${sortColumn} from Supabase`);
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

      let data = [...leaderboardCaches[cacheKey].data];
      let userRank = 0;

      if (userId) {
        const { data: userData, error: userFetchError } = await supabase
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
        top20: data, 
        userRank, 
        lastUpdate: leaderboardCaches[cacheKey].expires - (15 * 60 * 1000) 
      });
    } catch (err: any) {
      console.error('[LEADERBOARD] Supabase Fatal Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // --- Combat System APIs ---

  // Hero Selection
  app.post('/api/combat/select', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, heroClass } = req.body;
      console.log(`[COMBAT-API] Hero selection requested: ${heroClass} for ${telegramId}`);

      if (!['Warrior', 'Archer', 'Mage'].includes(heroClass)) {
        return res.status(400).json({ error: 'INVALID_CLASS' });
      }

      if (!verifyUserMatch(req, telegramId)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

      if (!supabase) {
        console.error("[COMBAT-API] Supabase client not initialized.");
        return res.status(500).json({ error: 'DATABASE_ERROR', message: 'Database connecting, try again.' });
      }

      // Check if already selected
      const { data: user, error: fetchError } = await supabase
        .from('users')
        .select('hero_class, id')
        .eq('id', telegramId.toString())
        .single();

      if (fetchError && fetchError.code !== 'PGRST116') {
        console.error("[COMBAT-API] Fetch error:", fetchError);
        return res.status(500).json({ error: 'FETCH_ERROR', message: fetchError.message });
      }

      if (user?.hero_class) {
        return res.status(400).json({ error: 'ALREADY_SELECTED' });
      }

      // Initial Stats based on class
      let stats = { attack: 100, defense: 100, health: 1000 };
      if (heroClass === 'Warrior') stats = { attack: 80, defense: 80, health: 1500 };
      if (heroClass === 'Archer') stats = { attack: 140, defense: 60, health: 800 };
      if (heroClass === 'Mage') stats = { attack: 100, defense: 120, health: 900 };

      const { data: updated, error: updateError } = await supabase
        .from('users')
        .update({
          hero_class: heroClass,
          hero_level: 0,
          hero_attack: stats.attack,
          hero_defense: stats.defense,
          hero_health: stats.health,
          arena_tier: 'Epic',
          arena_tier_level: 1,
          arena_stars: 0,
          combat_matches_free: 0,
          combat_matches_ads: 0,
          combat_last_reset: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', telegramId.toString())
        .select()
        .single();

      if (updateError) {
        console.error("[COMBAT-API] Update error:", updateError);
        return res.status(500).json({ error: 'UPDATE_ERROR', message: updateError.message });
      }

      console.log(`[COMBAT-API] User ${telegramId} selected ${heroClass} successfully`);
      res.json(updated);
    } catch (err: any) {
      console.error("[COMBAT-API] Fatal error:", err.message);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  });

  // Hero Progression (Level up)
  app.post('/api/combat/upgrade', validateTelegramData, async (req, res) => {
    try {
      const { telegramId } = req.body;
      if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });

      const { data: user, error: fetchError } = await supabase.from('users').select('*').eq('id', telegramId.toString()).single();
      if (!user || !user.hero_class) return res.status(400).json({ error: 'NO_HERO' });

      if (user.hero_level >= 100) return res.status(400).json({ error: 'MAX_LEVEL' });

      const cost = Math.floor(10000 * Math.pow(1.5, user.hero_level));
      if (user.balance < cost) return res.status(400).json({ error: 'INSUFFICIENT_FUNDS' });

      // Progression rates
      let growth = { atk: 10, def: 10, hp: 100 };
      if (user.hero_class === 'Warrior') growth = { atk: 8, def: 8, hp: 150 };
      if (user.hero_class === 'Archer') growth = { atk: 14, def: 6, hp: 80 };
      if (user.hero_class === 'Mage') growth = { atk: 10, def: 12, hp: 90 };

      const { data: updated, error: updateError } = await supabase.from('users').update({
        balance: user.balance - cost,
        hero_level: user.hero_level + 1,
        hero_attack: user.hero_attack + growth.atk,
        hero_defense: user.hero_defense + growth.def,
        hero_health: user.hero_health + growth.hp,
        updated_at: new Date().toISOString()
      }).eq('id', telegramId.toString()).select().single();

      if (updateError) throw updateError;
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Matchmaking (Hybrid Search)
  app.get('/api/combat/search', validateTelegramData, async (req, res) => {
    try {
      const { userId } = req.query;
      const { data: me, error: myError } = await supabase.from('users').select('*').eq('id', userId?.toString()).single();
      if (!me) return res.status(404).json({ error: 'NOT_FOUND' });

      // Matchmaking priority: Same class -> Closest Level -> Closest Ranking
      // We pull a larger pool of potential opponents to sort through
      const { data: pool, error: searchError } = await supabase.from('users')
        .select('id, username, first_name, photo_url, hero_class, hero_level, hero_attack, hero_defense, hero_health, arena_tier, airdropRank')
        .neq('id', me.id)
        .eq('hero_class', me.hero_class)
        .limit(50);

      if (!pool || pool.length === 0) return res.json([]);

      // Sort by priority: 
      // 1. Level proximity (Primary)
      // 2. Ranking proximity (Secondary)
      const sortedPool = [...pool].sort((a, b) => {
        const levelDiffA = Math.abs(a.hero_level - me.hero_level);
        const levelDiffB = Math.abs(b.hero_level - me.hero_level);
        if (levelDiffA !== levelDiffB) return levelDiffA - levelDiffB;

        const rankDiffA = Math.abs((a.airdropRank || 0) - (me.airdropRank || 0));
        const rankDiffB = Math.abs((b.airdropRank || 0) - (me.airdropRank || 0));
        return rankDiffA - rankDiffB;
      });

      // Return top 5 closest matches
      res.json(sortedPool.slice(0, 5));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Battle Simulation
  app.post('/api/combat/battle', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, opponentId } = req.body;
      if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });

      const { data: me, error: meErr } = await supabase.from('users').select('*').eq('id', telegramId.toString()).single();
      const { data: op, error: opErr } = await supabase.from('users').select('*').eq('id', opponentId.toString()).single();

      if (!me || !op) return res.status(400).json({ error: 'MISSING_PROFILE' });

      // Universal Reset Check
      const activeUser = await checkAndResetDailyData(me);

      // Match limit checks: strictly require ads (extra charges)
      let extraCount = activeUser.combat_extra_charges || 0;
      
      if (extraCount > 0) {
        extraCount--;
      } else {
        return res.status(400).json({ error: 'LIMIT_REACHED' });
      }

      // Simulation setup
      let attackerHp = me.hero_health;
      let defenderHp = op.hero_health;
      const rounds = [];
      let winnerId = '';

      for (let r = 1; r <= 6; r++) {
        let atkDmg = Math.max(5, me.hero_attack - (op.hero_defense / 2));
        let defDmg = Math.max(5, op.hero_attack - (me.hero_defense / 2));
        let msg = `Round ${r}: Exchange of blows!`;

        // Skill triggers
        // Warrior: Shield vs Archers (15% reduction) / Recovery R3 & R6
        if (me.hero_class === 'Warrior' && op.hero_class === 'Archer') defDmg *= 0.85;
        if (op.hero_class === 'Warrior' && me.hero_class === 'Archer') atkDmg *= 0.85;

        if (me.hero_class === 'Warrior' && (r === 3 || r === 6)) {
          const heal = Math.floor(me.hero_health * 0.15);
          attackerHp = Math.min(me.hero_health, attackerHp + heal);
          msg += ` Warrior heals ${heal}!`;
        }

        // Archer: Power vs Mage (15% buff) / Dodge R3 & R6 (15% reduction)
        if (me.hero_class === 'Archer' && op.hero_class === 'Mage') atkDmg *= 1.15;
        if (op.hero_class === 'Archer' && me.hero_class === 'Mage') defDmg *= 1.15;

        if (me.hero_class === 'Archer' && (r === 3 || r === 6)) defDmg *= 0.85;
        if (op.hero_class === 'Archer' && (r === 3 || r === 6)) atkDmg *= 0.85;

        // Mage: 25% global Dodge / 40% Burn Warrior R1,2,3
        if (me.hero_class === 'Mage' && Math.random() < 0.25) { defDmg = 0; msg += ` Mage dodged!`; }
        if (op.hero_class === 'Mage' && Math.random() < 0.25) { atkDmg = 0; msg += ` Enemy Mage dodged!`; }

        if (me.hero_class === 'Mage' && op.hero_class === 'Warrior' && r <= 3 && Math.random() < 0.40) {
          const burn = Math.floor(op.hero_health * 0.10);
          defenderHp -= burn;
          msg += ` Fire Burn! -${burn} HP.`;
        }

        attackerHp -= defDmg;
        defenderHp -= atkDmg;

        rounds.push({
          attacker_hp: Math.max(0, attackerHp),
          defender_hp: Math.max(0, defenderHp),
          attacker_damage: Math.floor(atkDmg),
          defender_damage: Math.floor(defDmg),
          event_msg: msg
        });

        if (attackerHp <= 0 || defenderHp <= 0) break;
      }

      winnerId = attackerHp > defenderHp ? me.id : op.id;
      const isWin = winnerId === me.id;

      // Tier logic
      let stars = me.arena_stars || 0;
      let tierLevel = me.arena_tier_level || 1;
      let tier = me.arena_tier || 'Epic';

      if (isWin) {
        stars++;
        if (stars >= 5) {
          stars = 0;
          tierLevel++;
          if (tierLevel > 5) {
            tierLevel = 1;
            if (tier === 'Epic') tier = 'Legend';
            else if (tier === 'Legend') tier = 'Mythic';
          }
        }
      } else {
        stars = Math.max(0, stars - 1);
      }

      // Final rewards
      const rewardGldp = isWin ? 5000 : 0;
      const rewardPoints = isWin ? 10 : 3;

      const { data: updated, error: finalUpdateErr } = await supabase.from('users').update({
        balance: activeUser.balance + rewardGldp,
        airdropRank: (activeUser.airdropRank || 0) + rewardPoints,
        arena_tier: tier,
        arena_tier_level: tierLevel,
        arena_stars: stars,
        combat_extra_charges: extraCount,
        updated_at: new Date().toISOString()
      }).eq('id', activeUser.id).select().single();

      res.json({
        winner_id: winnerId,
        rounds,
        reward_gldp: rewardGldp,
        reward_points: rewardPoints,
        star_change: isWin ? 1 : -1,
        user: updated
      });

    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Combat Ad Reward (Gives extra charges)
  app.post('/api/combat/ad-reward', validateTelegramData, async (req, res) => {
    try {
      const { telegramId } = req.body;
      if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });

      let { data: user } = await supabase.from('users').select('*').eq('id', telegramId.toString()).single();
      if (!user) return res.status(404).send('Not found');

      // Universal Reset Check
      user = await checkAndResetDailyData(user);

      const adsWatchedToday = (user.combat_daily_ads_watched || 0) + 1;
      const extraCharges = (user.combat_extra_charges || 0) + 1;

      const { data: updated, error } = await supabase
        .from('users')
        .update({
          combat_daily_ads_watched: adsWatchedToday,
          combat_extra_charges: extraCharges,
          updated_at: new Date().toISOString()
        })
        .eq('id', telegramId.toString())
        .select()
        .single();

      if (error) throw error;
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- End Combat System APIs ---

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
