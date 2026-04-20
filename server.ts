import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL || '';
// Use SERVICE ROLE KEY if available for security, otherwise fall back to ANON
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

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
      
      console.log(`[SYNC] Request for: ${username || 'Unknown'} (${idStr})`);

      if (!idStr) return res.status(400).json({ error: 'telegramId required' });

      if (!verifyUserMatch(req, idStr)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

      let { data: user, error } = await supabase.from('profiles').select('*').eq('id', idStr).single();

      if (error && error.code !== 'PGRST116') throw error;

      if (!user) {
        console.log(`[SYNC] REGISTERING NEW USER: ${idStr}`);
        const { data: newUser, error: createError } = await supabase
          .from('profiles')
          .insert([{
            id: idStr,
            username: username || '',
            first_name: first_name || '',
            photo_url: photo_url || null,
            referred_by: referred_by || null,
            updated_at: new Date().toISOString()
          }])
          .select()
          .single();

        if (createError) {
          console.error('[SYNC] Registration Error:', createError);
          throw createError;
        }
        user = newUser;
      }

      // Energy calculation logic remains robust...
      if (user) {
        const lastUpdate = new Date(user.updated_at || user.created_at);
        const diffSecs = Math.floor((Date.now() - lastUpdate.getTime()) / 1000);
        const refilled = Math.min(1000, (user.energy || 0) + Math.max(0, diffSecs));

        if (refilled !== user.energy) {
          const { data: updated } = await supabase
            .from('profiles')
            .update({ energy: refilled, updated_at: new Date().toISOString() })
            .eq('id', idStr)
            .select()
            .single();
          if (updated) user = updated;
        }
      }

      const { count: refCount } = await supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('referred_by', idStr);
      res.json({ ...user, referralCount: refCount || 0 });
    } catch (err: any) {
      console.error('[SYNC] Fatal Error:', err.message);
      res.status(500).json({ error: 'Sync failed. Database might be down.' });
    }
  });

  // Unified Adsgram Reward
  const grantAdReward = async (id: string) => {
    console.log(`[REWARD-SYSTEM] Processing user: ${id}`);
    const { data: user } = await supabase.from('profiles').select('*').eq('id', id).single();
    if (!user) return null;

    const questStates = user.daily_quest_states || {};
    const adState = questStates.adsgram || { count: 0, last_ad_at: 0 };
    
    const today = new Date().toDateString();
    const lastDate = new Date(adState.last_ad_at || 0).toDateString();
    const countToday = today === lastDate ? adState.count : 0;

    if (countToday >= 10) {
      console.warn(`[REWARD-SYSTEM] Limit reached for ${id}`);
      return null;
    }

    const { data: updated } = await supabase
      .from('profiles')
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
    // Making this robust for any variation of the parameter name
    const userid = req.query.userid || req.query.userId || req.query.user_id;
    console.log(`[ADSGRAM-WEBHOOK] Ping received for user: ${userid}`);
    
    if (!userid) {
      console.warn('[ADSGRAM-WEBHOOK] Missing userid parameter in request');
      return res.status(400).send('missing userid');
    }
    
    const success = await grantAdReward(userid.toString());
    res.send(success ? 'ok' : 'error');
  });

  app.post('/api/user/ad-reward', validateTelegramData, async (req, res) => {
    const { telegramId } = req.body;
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });
    const user = await grantAdReward(telegramId.toString());
    if (user) res.json(user);
    else res.status(400).json({ error: 'Reward failed or limit reached' });
  });

  // Quest Completion
  app.post('/api/user/complete-quest', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, questId, reward, points } = req.body;
      const idStr = telegramId.toString();

      if (!verifyUserMatch(req, telegramId)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

      const { data: user } = await supabase.from('profiles').select('*').eq('id', idStr).single();
      if (!user) throw new Error('User not found');

      const questStates = user.daily_quest_states || {};
      const now = new Date();

      // Simple daily check
      if (questStates[questId]) {
        const last = new Date(questStates[questId]);
        if (last.toDateString() === now.toDateString()) {
          return res.status(400).json({ error: 'Already done today' });
        }
      }

      const { data: updated, error } = await supabase
        .from('profiles')
        .update({
          balance: user.balance + reward,
          airdropRank: user.airdropRank + points,
          daily_quest_states: { ...questStates, [questId]: now.toISOString() }
        })
        .eq('id', idStr)
        .select()
        .single();

      if (error) throw error;
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Secure Tapping Sync (The user cannot just send any balance)
  app.post('/api/user/sync-taps', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, taps } = req.body;
      const idStr = telegramId?.toString();
      if (!idStr) return res.status(400).json({ error: 'missing id' });

      if (!verifyUserMatch(req, telegramId)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

      // Get current state
      const { data: user, error: fetchError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', idStr)
        .single();
      
      if (fetchError) throw fetchError;

      // Sanitize taps (user cannot spend more energy than they have)
      const validTaps = Math.min(taps || 0, user.energy);
      const newBalance = (user.balance || 0) + validTaps;
      const newEnergy = Math.max(0, user.energy - validTaps);

      const { data, error } = await supabase
        .from('profiles')
        .update({ 
          balance: newBalance, 
          energy: newEnergy, 
          updated_at: new Date().toISOString() 
        })
        .eq('id', idStr)
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
      
      if (!verifyUserMatch(req, telegramId)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

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
          last_claim_at: now.toISOString(),
          updated_at: now.toISOString()
        })
        .eq('id', telegramId.toString())
        .select()
        .single();

      if (updateError) throw updateError;
      
      const finalUser = updatedUser || { ...user, balance: user.balance + earnings, last_claim_at: now.toISOString() };
      res.json({ user: finalUser, earned: earnings });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upgrade Developer
  app.post('/api/user/upgrade', validateTelegramData, async (req, res) => {
    try {
      const { telegramId, developerId, cost, boost } = req.body;
      
      if (!verifyUserMatch(req, telegramId)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

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
          multiplier: user.multiplier + boost,
          updated_at: new Date().toISOString()
        })
        .eq('id', telegramId.toString())
        .select()
        .single();

      if (updateError) throw updateError;
      
      const finalUser = updatedUser || { ...user, balance: newBalance, multiplier: user.multiplier + boost };
      res.json(finalUser);
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
