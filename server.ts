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
const supabase = createClient(supabaseUrl, supabaseKey);

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
      
      console.log(`[SYNC] Supabase Request for: ${username || 'Unknown'} (${idStr})`);

      if (!idStr) return res.status(400).json({ error: 'telegramId required' });

      if (!verifyUserMatch(req, idStr)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

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
        console.log(`[SYNC] REGISTERING NEW SUPABASE USER: ${idStr}`);
        
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
          energy: 1000, // Energy is now 1000
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
      }

      // Restore Energy Refill Logic and Reset Daily Taps if new day
      if (currentUser) {
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

        if (currentEnergy !== currentUser.energy || currentDailyTaps !== currentUser.daily_taps) {
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
      }

      // Get referral count
      const { count, error: countError } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('referred_by', idStr);

      res.json({ ...currentUser, referralCount: count || 0 });
    } catch (err: any) {
      console.error('[SYNC] Supabase Fatal Error:', err.message);
      res.status(500).json({ error: 'Sync failed.' });
    }
  });

  // Unified Adsgram Reward
  const grantAdReward = async (id: string) => {
    console.log(`[REWARD-SYSTEM] Supabase processing user: ${id}`);
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

    if (countToday >= 10) {
      console.warn(`[REWARD-SYSTEM] Limit reached for ${id}`);
      return null;
    }

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

      const { data: user, error: fetchError } = await supabase
        .from('users')
        .select('*')
        .eq('id', idStr)
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
