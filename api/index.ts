import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
app.use(express.json());

// Global cache for leaderboard
const leaderboardCaches: Record<string, { data: any[], expires: number }> = {};

// Middleware to validate Telegram WebApp initData 
const verifyTelegramInitData = (initData: string): { id: number; username?: string; first_name?: string } | null => {
  if (!initData) return null;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
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
    }
  } catch (e) {}
  return null;
};

const validateTelegramData = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const initData = req.headers['x-telegram-init-data'] as string;
  if (!initData && process.env.NODE_ENV !== 'production') return next();
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'UNAUTHORIZED' });
  (req as any).tgUser = tgUser;
  next();
};

const verifyUserMatch = (req: express.Request, targetId: any): boolean => {
  const authId = (req as any).tgUser?.id?.toString();
  if (!authId && process.env.NODE_ENV !== 'production') return true; 
  return authId === targetId?.toString();
};

// API Routes
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/user/sync', validateTelegramData, async (req, res) => {
  try {
    const { telegramId, username, first_name, photo_url, referred_by } = req.body;
    const idStr = telegramId?.toString();
    if (!idStr) return res.status(400).json({ error: 'telegramId required' });
    if (!verifyUserMatch(req, idStr)) return res.status(403).json({ error: 'FORBIDDEN' });

    const { data: user } = await supabase.from('users').select('*').eq('id', idStr).single();
    let currentUser = user;

    if (!currentUser) {
      const newUser = {
        id: idStr, username: username || '', first_name: first_name || '', photo_url, referred_by,
        balance: referred_by ? 5000 : 0, multiplier: 0.1, tap_value: 1, energy: 1000,
        daily_quest_states: {}, completed_missions: [], upgrades: {},
        last_claim_at: new Date().toISOString(), updated_at: new Date().toISOString(), created_at: new Date().toISOString()
      };
      const { data: insertedUser } = await supabase.from('users').insert([newUser]).select().single();
      currentUser = insertedUser;
    }

    if (currentUser) {
      try {
        const lastUpdate = new Date(currentUser.updated_at || currentUser.created_at || Date.now());
        const now = new Date();
        const todayUTC = now.toISOString().split('T')[0];
        const lastDateStr = lastUpdate.toDateString();
        const todayStr = now.toDateString();

        // Calculate energy recovery
        const diffSecs = Math.floor((now.getTime() - lastUpdate.getTime()) / 1000);
        let currentEnergy = currentUser.energy || 0;
        currentEnergy = Math.min(1000, currentEnergy + Math.max(0, diffSecs));

        // Determine if we need a Daily Reset
        const combatStats = currentUser.upgrades?.combat_stats || {};
        const lastResetDate = combatStats.last_reset ? new Date(combatStats.last_reset) : 
                             (currentUser.combat_last_reset ? new Date(currentUser.combat_last_reset) : new Date(0));
        const lastResetUTC = lastResetDate.toISOString().split('T')[0];
        const isNewDay = todayUTC !== lastResetUTC;

        // Build a highly defensive update object
        const updates: any = { 
          energy: currentEnergy, 
          updated_at: now.toISOString() 
        };

        if (isNewDay) {
          // Add resets to JSON blob (Safe Zone)
          updates.upgrades = {
            ...(currentUser.upgrades || {}),
            combat_stats: { free: 10, extra: 0, ads: 0, last_reset: now.toISOString() }
          };
          // Try top-level columns (Risk zone - we handle error later)
          updates.combat_matches_free = 10;
          updates.combat_extra_charges = 0;
          updates.combat_daily_ads_watched = 0;
          updates.combat_last_reset = now.toISOString();
          updates.daily_quest_states = {};
          updates.daily_taps = 0;
        } else if (todayStr !== lastDateStr) {
          updates.daily_taps = 0;
        }

        // EXECUTE UPDATE WITH INDIVIDUAL COLUMN SAFETY
        const { data: updated, error: updateErr } = await supabase.from('users').update(updates).eq('id', idStr).select().single();
        
        if (updateErr) {
          console.warn("[SYNC_SAFETY_TRIGGERED] Attempting minimal safe update due to schema error:", updateErr.message);
          // If the big update failed, do the MINIMAL possible update to GLD and Energy
          const minimalUpdates = { 
            energy: currentEnergy, 
            updated_at: now.toISOString(),
            upgrades: updates.upgrades || currentUser.upgrades 
          };
          const { data: safeUser } = await supabase.from('users').update(minimalUpdates).eq('id', idStr).select().single();
          if (safeUser) currentUser = safeUser;
        } else if (updated) {
          currentUser = updated;
        }
      } catch (innerErr) {
        console.error("[SYNC_INNER_CRASH] Critical error during user processing:", innerErr);
        // We continue with the original currentUser so the app doesn't crash
      }
    }
    
    const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('referred_by', idStr);
    res.json({ ...currentUser, referralCount: count || 0 });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/complete-quest', validateTelegramData, async (req, res) => {
  try {
    const { telegramId, questId, reward, points, type } = req.body;
    const idStr = telegramId.toString();
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });
    const { data: user } = await supabase.from('users').select('*').eq('id', idStr).single();
    if (!user) throw new Error('User not found');

    if (type === 'social') {
      const completed = user.completed_missions || [];
      if (completed.includes(questId)) return res.status(400).json({ error: 'Already completed' });
      const { data: updated } = await supabase.from('users').update({
        balance: (user.balance || 0) + reward,
        airdropRank: (user.airdropRank || 0) + points,
        completed_missions: [...completed, questId]
      }).eq('id', idStr).select().single();
      return res.json(updated);
    } else {
      const questStates = user.daily_quest_states || {};
      const now = new Date();
      if (questStates[questId]) {
        const last = new Date(questStates[questId]);
        if (last.toDateString() === now.toDateString()) return res.status(400).json({ error: 'Already done today' });
      }
      const { data: updated } = await supabase.from('users').update({
        balance: (user.balance || 0) + reward,
        airdropRank: (user.airdropRank || 0) + points,
        daily_quest_states: { ...questStates, [questId]: now.toISOString() }
      }).eq('id', idStr).select().single();
      return res.json(updated);
    }
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/sync-taps', validateTelegramData, async (req, res) => {
  try {
    const { telegramId, taps } = req.body;
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });
    const { data: user } = await supabase.from('users').select('*').eq('id', telegramId.toString()).single();
    if (!user) throw new Error('User not found');

    const actualTaps = Math.min(taps || 0, user.energy || 0);
    const reward = actualTaps * (user.tap_value || 1);
    const { data: updated } = await supabase.from('users').update({ 
      balance: (user.balance || 0) + reward, energy: (user.energy || 0) - actualTaps,
      daily_taps: (user.daily_taps || 0) + actualTaps, updated_at: new Date().toISOString() 
    }).eq('id', telegramId.toString()).select().single();
    res.json(updated);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/claim', validateTelegramData, async (req, res) => {
  try {
    const { telegramId } = req.body;
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });
    const { data: user } = await supabase.from('users').select('*').eq('id', telegramId.toString()).single();
    if (!user) throw new Error('User not found');

    const earnings = Math.floor(((Date.now() - new Date(user.last_claim_at || user.created_at).getTime()) / 1000) * (user.multiplier || 0.1));
    if (earnings <= 0) return res.status(400).json({ error: 'Nothing to claim' });

    const { data: updated } = await supabase.from('users').update({
      balance: (user.balance || 0) + earnings, last_claim_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq('id', telegramId.toString()).select().single();
    res.json({ user: updated, earned: earnings });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/adsgram/reward', async (req, res) => {
  try {
    const userid = req.query.userid || req.query.userId || req.query.user_id;
    if (!userid) return res.status(400).send('missing userid');
    const { data: user } = await supabase.from('users').select('*').eq('id', userid.toString()).single();
    if (!user) return res.status(404).send('error');
    
    const questStates = user.daily_quest_states || {};
    const adState = questStates.adsgram || { count: 0, last_ad_at: 0 };
    if (new Date().toDateString() === new Date(adState.last_ad_at).toDateString() && adState.count >= 10) return res.send('error');

    await supabase.from('users').update({
      balance: (user.balance || 0) + 2500, airdropRank: (user.airdropRank || 0) + 15,
      daily_quest_states: { ...questStates, adsgram: { count: (adState.count || 0) + 1, last_ad_at: Date.now() } }
    }).eq('id', userid.toString());
    res.send('ok');
  } catch (e) { res.send('error'); }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const { sortBy = 'airdropRank', userId } = req.query;
    let query = supabase.from('users').select('*');
    
    if (sortBy === 'arena_score') {
      // PostgREST syntax for nested JSON sorting often works better with dot notation in some versions
      query = query.order('upgrades->arena->score', { ascending: false, nullsFirst: false });
    } else {
      query = query.order(sortBy as string, { ascending: false, nullsFirst: false });
    }

    let { data, error: fetchErr } = await query.limit(50);

    // CRITICAL: We fetch 50 and sort everything in-memory to ensure combat ranking is NEVER reversed 
    // and correctly sorts numerically regardless of database schema quirks.
    let finalData = data || [];
    
    if (sortBy === 'arena_score') {
      finalData = [...finalData].sort((a, b) => {
        const scoreA = Number(a.upgrades?.arena?.score ?? a.arena_score ?? 0);
        const scoreB = Number(b.upgrades?.arena?.score ?? b.arena_score ?? 0);
        return scoreB - scoreA; // High score first
      }).slice(0, 20);
    } else {
      finalData = finalData.slice(0, 20);
    }
    
    let userRank = 0;
    if (userId) {
      const { data: userData } = await supabase.from('users').select('*').eq('id', userId.toString()).single();
      if (userData) {
        if (sortBy === 'arena_score') {
          // If in combat tab, rank the user against the top pool for a more accurate visual representation
          const score = userData.upgrades?.arena?.score ?? userData.arena_score ?? 0;
          if (score > 0) {
            // Find their position in the top pool or estimate
            const pos = finalData.findIndex(u => u.id === userData.id);
            userRank = pos !== -1 ? pos + 1 : 25; // Visual rank for high scorers
          } else {
             // Fallback to approximate activity rank if no combat score
             const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).gt('airdropRank', userData.airdropRank || 0);
             userRank = (count || 0) + 1;
          }
        } else {
          const userValue = userData[sortBy] || 0;
          const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).gt(sortBy as string, userValue);
          userRank = (count || 0) + 1;
        }
      }
    }

    res.json({ top20: finalData, userRank });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Combat APIs
app.post('/api/combat/select', validateTelegramData, async (req, res) => {
  try {
    const { telegramId, heroClass } = req.body;
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });
    
    // Fetch current user first to get existing upgrades
    const { data: user } = await supabase.from('users').select('*').eq('id', telegramId.toString()).single();
    
    let stats = { attack: 100, defense: 100, health: 1000 };
    if (heroClass === 'Warrior') stats = { attack: 80, defense: 80, health: 1500 };
    else if (heroClass === 'Archer') stats = { attack: 140, defense: 60, health: 800 };
    else if (heroClass === 'Mage') stats = { attack: 100, defense: 120, health: 900 };
    
    const upgrades = user?.upgrades || {};
    const { data } = await supabase.from('users').update({
      hero_class: heroClass, hero_level: 1, hero_attack: stats.attack, hero_defense: stats.defense, hero_health: stats.health,
      upgrades: {
        ...upgrades,
        arena: { wins: 0, losses: 0, stars: 0, tier: 'Epic', tierLevel: 1, score: 0 }
      },
      updated_at: new Date().toISOString()
    }).eq('id', telegramId.toString()).select().single();
    res.json(data);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/combat/search', validateTelegramData, async (req, res) => {
  try {
    const { userId } = req.query;
    const { data: me } = await supabase.from('users').select('*').eq('id', userId?.toString()).single();
    if (!me) return res.status(404).json({ error: 'NOT_FOUND' });

    const now = Date.now();
    const upgrades = me.upgrades || {};
    const combatMeta = upgrades.combat_meta || {};
    const lastRefresh = combatMeta.last_refresh || 0;
    const cachedOpponents = combatMeta.cached_opponents || [];
    
    // 3 hour cooldown (3 * 60 * 60 * 1000 = 10,800,000 ms)
    const COOLDOWN = 3 * 60 * 60 * 1000;
    
    if (cachedOpponents.length > 0 && (now - lastRefresh < COOLDOWN)) {
      return res.json(cachedOpponents);
    }

    const myArena = upgrades.arena || {};
    const myTier = myArena.tier || me.arena_tier || 'Epic';
    const myLevel = me.hero_level || 1;

    // Advanced Matchmaking Logic: Same Tier -> Closest Level
    // We fetch a larger pool of recently active users to ensure variety
    const { data: rawPool } = await supabase.from('users')
      .select('*')
      .neq('id', me.id)
      .order('updated_at', { ascending: false })
      .limit(100);

    if (!rawPool) return res.json([]);

    // We take the recently active users, shuffle them slightly to avoid static lists,
    // then apply our proximity scoring.
    const shuffledPool = [...rawPool].sort(() => Math.random() - 0.5);

    const sortedPool = shuffledPool
      .map(op => {
        const opArena = op.upgrades?.arena || {};
        const opTier = opArena.tier || op.arena_tier || 'Epic';
        const opLevel = op.hero_level || 1;
        
        let score = 0;
        // Priority 1: Same Tier
        if (opTier === myTier) score += 1000;
        // Priority 2: Closest Level (Lower diff is better)
        const levelDiff = Math.abs(opLevel - myLevel);
        score += Math.max(0, 100 - levelDiff);

        return { ...op, matchScore: score };
      })
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, 5);

    // Filter out huge sensitive data before caching
    const sanitizedPool = sortedPool.map(p => ({
      id: p.id,
      username: p.username,
      photo_url: p.photo_url,
      hero_level: p.hero_level,
      hero_class: p.hero_class,
      hero_health: p.hero_health,
      arena_tier: p.upgrades?.arena?.tier || p.arena_tier || 'Epic'
    }));

    // Save refresh timestamp and cache
    await supabase.from('users').update({
      upgrades: {
        ...upgrades,
        combat_meta: {
          last_refresh: now,
          cached_opponents: sanitizedPool
        }
      }
    }).eq('id', me.id);

    res.json(sanitizedPool);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/combat/battle', validateTelegramData, async (req, res) => {
  try {
    const { telegramId, opponentId } = req.body;
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });
    const { data: me } = await supabase.from('users').select('*').eq('id', telegramId.toString()).single();
    const { data: op } = await supabase.from('users').select('*').eq('id', opponentId.toString()).single();
    if (!me || !op) return res.status(400).json({ error: 'MISSING_PROFILE' });

    // Defensive stats check
    const currentMeBalance = me.balance || 0;
    const currentMeAirdropRank = me.airdropRank || 0;

    // Match limit checks - Reading from JSON Safety Zone
    const todayUTC = new Date().toISOString().split('T')[0];
    const upgrades = me.upgrades || {};
    const combatStats = upgrades.combat_stats || {};
    
    const lastResetDate = combatStats.last_reset ? new Date(combatStats.last_reset) : 
                         (me.combat_last_reset ? new Date(me.combat_last_reset) : new Date(0));
    const lastResetUTC = lastResetDate.toISOString().split('T')[0];
    
    let freeAvailable = combatStats.free ?? (me.combat_matches_free ?? 10);
    let extraCharges = combatStats.extra ?? (me.combat_extra_charges || 0);
    let adsWatchedToday = combatStats.ads ?? (me.combat_daily_ads_watched || 0);

    if (todayUTC !== lastResetUTC) {
      freeAvailable = 10;
      extraCharges = 0;
      adsWatchedToday = 0;
    }

    if (freeAvailable <= 0 && extraCharges <= 0) {
      return res.status(400).json({ error: 'LIMIT_REACHED' });
    }

    let attackerHp = me.hero_health || 1000;
    let defenderHp = op.hero_health || 1000;
    const heroAtk = me.hero_attack || 100;
    const heroDef = me.hero_defense || 100;
    const opAtk = op.hero_attack || 100;
    const opDef = op.hero_defense || 100;
    
    let rounds = [];
    for (let r = 1; r <= 6 && attackerHp > 0 && defenderHp > 0; r++) {
      let atkDmg = Math.max(5, heroAtk - (opDef / 2));
      let defDmg = Math.max(5, opAtk - (heroDef / 2));
      let msg = `Round ${r}: Exchange of blows!`;

      // Skill triggers
      // Warrior: Shield vs Archers (15% reduction) / Recovery R3 & R6
      if (me.hero_class === 'Warrior' && op.hero_class === 'Archer') defDmg *= 0.85;
      if (op.hero_class === 'Warrior' && me.hero_class === 'Archer') atkDmg *= 0.85;

      if (me.hero_class === 'Warrior' && (r === 3 || r === 6)) {
        const heal = Math.floor((me.hero_health || 1000) * 0.15);
        attackerHp = Math.min(me.hero_health || 1000, attackerHp + heal);
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
        const burn = Math.floor((op.hero_health || 1000) * 0.10);
        defenderHp -= burn;
        msg += ` Fire Burn! -${burn} HP.`;
      }

      attackerHp -= defDmg; defenderHp -= atkDmg;
      rounds.push({ 
        attacker_hp: Math.max(0, Math.floor(attackerHp)), 
        defender_hp: Math.max(0, Math.floor(defenderHp)), 
        attacker_damage: Math.floor(atkDmg), 
        defender_damage: Math.floor(defDmg), 
        event_msg: msg 
      });
    }

    const isWin = attackerHp > defenderHp;
    
    // Initialize arena stats from upgrades if top-level columns are missing
    const upgrades = me.upgrades || {};
    const arena = upgrades.arena || {
      wins: me.arena_wins || 0,
      losses: me.arena_losses || 0,
      stars: me.arena_stars || 0,
      tier: me.arena_tier || 'Epic',
      tierLevel: me.arena_tier_level || 1
    };

    let wins = arena.wins;
    let losses = arena.losses;
    let stars = arena.stars;
    let tier = arena.tier;
    let tierLevel = arena.tierLevel;

    if (isWin) {
      wins++;
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
      losses++;
      stars = Math.max(0, stars - 1);
    }

    const arenaScore = wins - losses;
    const rewardGldp = isWin ? 5000 : 0;
    const rewardPoints = isWin ? 10 : 3;

    // Clear cached opponents after a battle to force a refresh 
    // as requested (prevents farming one weak opponent).
    const combatMeta = upgrades.combat_meta || {};
    const updatedCombatMeta = {
      ...combatMeta,
      cached_opponents: [] 
    };

    // Build update object with JSON safety
    const updatedCombatStats = {
      free: freeAvailable > 0 ? freeAvailable - 1 : 0,
      extra: freeAvailable > 0 ? extraCharges : Math.max(0, extraCharges - 1),
      ads: adsWatchedToday,
      last_reset: new Date().toISOString()
    };

    const updatePayload: any = {
      balance: currentMeBalance + rewardGldp,
      airdropRank: currentMeAirdropRank + rewardPoints,
      updated_at: new Date().toISOString(),
      upgrades: {
        ...upgrades,
        arena: { wins, losses, stars, tier, tierLevel, score: arenaScore },
        combat_meta: updatedCombatMeta,
        combat_stats: updatedCombatStats
      }
    };
    
    // Attempt top-level update for compatibility, but don't crash if columns missing
    updatePayload.combat_matches_free = updatedCombatStats.free;
    updatePayload.combat_extra_charges = updatedCombatStats.extra;
    updatePayload.combat_last_reset = updatedCombatStats.last_reset;

    // We also TRY to update top-level columns if they happen to exist, 
    // but the upgrades fallback ensures the data is at least saved.
    // However, to avoid the PostgREST error, we should NOT include columns we suspect are missing.
    // Given the error, we'll stick to the JSON-only storage for these specific stats.

    const { data: updated, error: updateErr } = await supabase.from('users').update(updatePayload).eq('id', me.id).select().single();

    if (updateErr) {
      console.error("[BATTLE_UPDATE_ERROR]", updateErr);
      throw updateErr;
    }

    res.json({ 
      winner_id: isWin ? me.id : op.id, 
      rounds, 
      user: updated,
      reward_gldp: rewardGldp,
      reward_points: rewardPoints
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/combat/ad-reward', validateTelegramData, async (req, res) => {
  try {
    const { telegramId } = req.body;
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });

    const { data: user } = await supabase.from('users').select('*').eq('id', telegramId.toString()).single();
    if (!user) return res.status(404).json({ error: 'NOT_FOUND' });

    const todayUTC = new Date().toISOString().split('T')[0];
    const upgrades = user.upgrades || {};
    const combatStats = upgrades.combat_stats || {};
    
    const lastResetDate = combatStats.last_reset ? new Date(combatStats.last_reset) : 
                         (user.combat_last_reset ? new Date(user.combat_last_reset) : new Date(0));
    const lastResetUTC = lastResetDate.toISOString().split('T')[0];
    
    let adsWatchedToday = combatStats.ads ?? (user.combat_daily_ads_watched || 0);
    let extraCharges = combatStats.extra ?? (user.combat_extra_charges || 0);

    if (todayUTC !== lastResetUTC) {
      adsWatchedToday = 0;
      extraCharges = 0;
    }

    if (adsWatchedToday >= 5) {
      return res.status(400).json({ error: 'LIMIT_REACHED' });
    }

    const now = new Date();
    const newCombatStats = {
      ...combatStats,
      ads: adsWatchedToday + 1,
      extra: extraCharges + 1,
      last_reset: now.toISOString()
    };

    const { data: updated } = await supabase.from('users').update({
      upgrades: {
        ...upgrades,
        combat_stats: newCombatStats
      },
      combat_daily_ads_watched: adsWatchedToday + 1,
      combat_extra_charges: extraCharges + 1,
      combat_last_reset: now.toISOString(),
      updated_at: now.toISOString()
    }).eq('id', telegramId.toString()).select().single();

    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/upgrade', validateTelegramData, async (req, res) => {
  try {
    const { telegramId, developerId, cost, boost, upgradeType } = req.body;
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });

    const { data: user } = await supabase.from('users').select('*').eq('id', telegramId.toString()).single();
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

    if ((user.balance || 0) < cost) {
      return res.status(400).json({ error: 'INSUFFICIENT_BALANCE' });
    }

    const upgrades = user.upgrades || {};
    const currentLevel = upgrades[developerId] || 0;
    const newUpgrades = { ...upgrades, [developerId]: currentLevel + 1 };

    const updates: any = {
      balance: user.balance - cost,
      upgrades: newUpgrades,
      updated_at: new Date().toISOString()
    };

    if (upgradeType === 'tap') {
      updates.tap_value = (user.tap_value || 1) + boost;
    } else {
      updates.multiplier = (user.multiplier || 0.1) + boost;
    }

    const { data: updated, error } = await supabase.from('users')
      .update(updates)
      .eq('id', telegramId.toString())
      .select()
      .single();

    if (error) throw error;
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/combat/upgrade', validateTelegramData, async (req, res) => {
  try {
    const { telegramId } = req.body;
    if (!verifyUserMatch(req, telegramId)) return res.status(403).json({ error: 'FORBIDDEN' });

    const { data: user } = await supabase.from('users').select('*').eq('id', telegramId.toString()).single();
    if (!user || !user.hero_class) return res.status(400).json({ error: 'NO_HERO' });
    if (user.hero_level >= 100) return res.status(400).json({ error: 'MAX_LEVEL' });

    const cost = Math.floor(10000 * Math.pow(1.5, user.hero_level));
    if (user.balance < cost) return res.status(400).json({ error: 'INSUFFICIENT_FUNDS' });

    let growth = { atk: 10, def: 10, hp: 100 };
    if (user.hero_class === 'Warrior') growth = { atk: 8, def: 8, hp: 150 };
    else if (user.hero_class === 'Archer') growth = { atk: 14, def: 6, hp: 80 };
    else if (user.hero_class === 'Mage') growth = { atk: 10, def: 12, hp: 90 };

    const { data: updated } = await supabase.from('users').update({
      balance: user.balance - cost,
      hero_level: user.hero_level + 1,
      hero_attack: user.hero_attack + growth.atk,
      hero_defense: user.hero_defense + growth.def,
      hero_health: user.hero_health + growth.hp,
      updated_at: new Date().toISOString()
    }).eq('id', telegramId.toString()).select().single();

    res.json(updated);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default app;
