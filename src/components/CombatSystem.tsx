import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Shield, 
  Target, 
  Zap, 
  RefreshCcw, 
  Trophy, 
  Clock, 
  ChevronRight,
  Sword
} from 'lucide-react';
import { cn } from '../lib/utils';
import { UserProfile } from '../types';

// --- Matchmaking Component ---
export const ArenaMatchmaking = ({ user, onStartBattle }: { user: UserProfile, onStartBattle: (op: any) => void }) => {
  const [opponents, setOpponents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchOpponents = async () => {
    setLoading(true);
    try {
      console.log("[COMBAT] Searching for opponents...");
      const res = await fetch(`/api/combat/search?userId=${user.id}`, {
        headers: { 'x-telegram-init-data': window.Telegram?.WebApp?.initData || '' }
      });
      
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        const text = await res.text();
        console.error("[COMBAT] Server returned non-JSON search result:", text.substring(0, 200));
        throw new Error("Server returned HTML instead of search data. This usually indicates a routing conflict.");
      }

      const data = await res.json();
      setOpponents(data);
    } catch (e: any) {
      console.error("[COMBAT] Matchmaking error:", e);
      alert("Matchmaking Failed: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchOpponents(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between px-2">
        <h3 className="text-sm font-black uppercase text-neutral-400 tracking-widest">Find Opponent</h3>
        <button onClick={fetchOpponents} className="p-2 bg-white/5 rounded-lg active:rotate-180 transition-all duration-500">
          <RefreshCcw className="w-4 h-4 text-yellow-500" />
        </button>
      </div>

      {loading ? (
        <div className="py-20 text-center animate-pulse text-xs font-black text-yellow-500/50">SCANNING SECTOR FOR HOSTILES...</div>
      ) : (
        <div className="space-y-3">
          {opponents.length === 0 ? (
            <div className="py-10 text-center text-xs text-neutral-500 uppercase tracking-widest">No opponents found in range</div>
          ) : opponents.map((op, i) => (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.1 }}
              key={op.id}
              className="glass-card p-4 flex items-center justify-between border-white/5 bg-white/5 hover:bg-white/10 transition-all"
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full border-2 border-white/10 overflow-hidden bg-neutral-900 shadow-inner">
                   {op.photo_url ? (
                     <img src={op.photo_url} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                   ) : (
                     <div className="w-full h-full flex items-center justify-center font-black text-indigo-400">{op.username?.[0]?.toUpperCase()}</div>
                   )}
                </div>
                <div>
                   <p className="text-xs font-black text-white">@{op.username}</p>
                   <p className="text-[10px] text-yellow-500 font-black uppercase tracking-tighter">LVL {op.hero_level} {op.hero_class}</p>
                </div>
              </div>
              <button 
                onClick={() => onStartBattle(op)}
                className="px-4 py-2 bg-red-600/90 hover:bg-red-500 text-white text-[10px] font-black uppercase rounded-lg shadow-lg shadow-red-600/20 active:scale-95 transition-all border border-red-400/20"
              >
                ATTACK
              </button>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
};

// --- Battle Arena Component ---
export const BattleArena = ({ user, opponent, onFinish, setUser }: { user: UserProfile, opponent: any, onFinish: () => void, setUser: any }) => {
  const [battleData, setBattleData] = useState<any>(null);
  const [roundIndex, setRoundIndex] = useState(-1);
  const [loading, setLoading] = useState(true);

  const startFight = async () => {
    try {
      console.log(`[COMBAT] Starting battle against ${opponent.username}`);
      const res = await fetch('/api/combat/battle', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-telegram-init-data': window.Telegram?.WebApp?.initData || ''
        },
        body: JSON.stringify({ telegramId: user.id, opponentId: opponent.id })
      });

      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        const text = await res.text();
        console.error("[COMBAT] Server returned non-JSON battle result:", text.substring(0, 200));
        throw new Error("Combat Simulation Failed: Server returned HTML. Check API routing.");
      }

      const data = await res.json();
      if (data.error) {
        alert(data.error);
        onFinish();
        return;
      }
      
      setBattleData(data);
      setLoading(false);
      
      // Update global user state immediately so balances are synced
      if (data.user) {
        console.log("[COMBAT] Syncing user state from battle result...");
        setUser(data.user);
        // Dispatch local event for components that might need a nudge
        window.dispatchEvent(new CustomEvent('user-sync', { detail: data.user }));
      }
      
      // Auto-play rounds with slight delay
      let idx = 0;
      const interval = setInterval(() => {
        setRoundIndex(idx);
        idx++;
        if (idx >= data.rounds.length) {
          clearInterval(interval);
        }
      }, 1500);

    } catch (e: any) {
      console.error("[COMBAT] Battle simulation error:", e);
      alert(e.message);
      onFinish();
    }
  };

  useEffect(() => { startFight(); }, []);

  if (loading) return (
    <div className="fixed inset-0 bg-[#0f172a] z-[100] flex flex-col items-center justify-center p-10 text-center">
       <div className="w-24 h-24 border-b-4 border-red-600 rounded-full animate-spin mb-8 shadow-[0_0_40px_rgba(220,38,38,0.2)]" />
       <h2 className="text-3xl font-black uppercase tracking-tighter text-red-500 italic">Entering Combat Zone</h2>
       <p className="text-[10px] text-neutral-500 mt-4 uppercase tracking-[0.4em] animate-pulse">Syncing Battle Parameters...</p>
    </div>
  );

  const isFinished = roundIndex >= battleData.rounds.length - 1;
  const isWin = battleData.winner_id === user.id;
  const currentRound = roundIndex >= 0 ? battleData.rounds[roundIndex] : null;

  return (
    <div className="fixed inset-0 bg-[#0f172a] z-[100] p-6 pt-16 overflow-y-auto">
      {/* Dynamic Fighters Background Effect */}
      <div className="absolute inset-0 bg-gradient-to-b from-red-600/5 to-transparent pointer-events-none" />

      {/* Fighters Header */}
      <div className="flex items-center justify-between mb-16 relative z-10">
        <div className="text-center space-y-3 flex-1 flex flex-col items-center">
          <div className="w-24 h-24 rounded-3xl bg-blue-500/10 border-2 border-blue-500/40 overflow-hidden relative shadow-[0_0_30px_rgba(59,130,246,0.2)] group transition-all">
             {user.photo_url ? (
               <img src={user.photo_url} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
             ) : (
               <div className="w-full h-full flex items-center justify-center font-black text-3xl text-blue-400">{user.username?.[0]?.toUpperCase()}</div>
             )}
             <div className="absolute top-0 left-0 bg-blue-500 text-[9px] px-2 py-0.5 font-black text-white shadow-lg">PLAYER</div>
             {/* Attacker Flash Effect */}
             <AnimatePresence>
               {currentRound && roundIndex % 2 === 0 && (
                 <motion.div 
                   initial={{ opacity: 0 }}
                   animate={{ opacity: [0, 0.4, 0] }}
                   className="absolute inset-0 bg-white"
                 />
               )}
             </AnimatePresence>
          </div>
          <p className="text-[11px] font-black uppercase tracking-widest text-white truncate max-w-[100px]">@{user.username}</p>
          <div className="w-full max-w-[120px] bg-white/5 h-2.5 rounded-full overflow-hidden border border-white/10 shadow-inner">
             <motion.div 
               animate={{ width: `${(currentRound?.attacker_hp ?? user.hero_health) / (user.hero_health || 100) * 100}%` }}
               className="h-full bg-gradient-to-r from-blue-400 to-blue-600" 
             />
          </div>
        </div>

        <div className="px-6 text-4xl font-black text-red-600 italic tracking-tighter drop-shadow-[0_0_15px_rgba(220,38,38,0.5)]">VS</div>

        <div className="text-center space-y-3 flex-1 flex flex-col items-center">
          <div className="w-24 h-24 rounded-3xl bg-red-500/10 border-2 border-red-500/40 overflow-hidden relative shadow-[0_0_30px_rgba(239,68,68,0.2)]">
             {opponent.photo_url ? (
               <img src={opponent.photo_url} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
             ) : (
               <div className="w-full h-full flex items-center justify-center font-black text-3xl text-red-400">{opponent.username?.[0]?.toUpperCase()}</div>
             )}
             <div className="absolute top-0 right-0 bg-red-500 text-[9px] px-2 py-0.5 font-black text-white shadow-lg">HOSTILE</div>
             {/* Defender Flash Effect */}
             <AnimatePresence>
               {currentRound && roundIndex % 2 !== 0 && (
                 <motion.div 
                   initial={{ opacity: 0 }}
                   animate={{ opacity: [0, 0.4, 0] }}
                   className="absolute inset-0 bg-white"
                 />
               )}
             </AnimatePresence>
          </div>
          <p className="text-[11px] font-black uppercase tracking-widest text-white truncate max-w-[100px]">@{opponent.username}</p>
          <div className="w-full max-w-[120px] bg-white/5 h-2.5 rounded-full overflow-hidden border border-white/10 shadow-inner">
            <motion.div 
               animate={{ width: `${(currentRound?.defender_hp ?? opponent.hero_health) / (opponent.hero_health || 100) * 100}%` }}
               className="h-full bg-gradient-to-r from-red-400 to-red-600" 
             />
          </div>
        </div>
      </div>

      {/* Round Events Scroller */}
      <div className="space-y-4 pb-32">
        <AnimatePresence mode="popLayout">
          {battleData.rounds.slice(0, roundIndex + 1).map((r: any, i: number) => (
            <motion.div 
              key={i}
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className={cn(
                "glass-card p-5 border-white/5 flex items-center gap-5 relative overflow-hidden",
                i === roundIndex ? "bg-white/10 border-red-500/30" : "bg-white/5 opacity-60"
              )}
            >
              <div className="w-10 h-10 rounded-2xl bg-red-600/20 flex items-center justify-center font-black text-xs text-red-500 shrink-0 border border-red-500/20 shadow-inner">
                {i+1}
              </div>
              <div className="flex-1">
                <p className="text-[12px] font-bold text-white leading-snug tracking-tight uppercase italic">{r.event_msg}</p>
                <div className="flex gap-4 mt-2">
                  <span className="text-[9px] font-black text-blue-400 flex items-center gap-1">
                    <Shield className="w-2.5 h-2.5" />
                    {r.attacker_hp} HP LEFT
                  </span>
                  <span className="text-[9px] font-black text-red-500 flex items-center gap-1">
                    <Sword className="w-2.5 h-2.5" />
                    DEALT {r.defender_damage} DMG
                  </span>
                </div>
              </div>
            </motion.div>
          )).reverse()}
        </AnimatePresence>
      </div>

      {/* Final Result Modal */}
      {isFinished && (
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 bg-black/90 backdrop-blur-md z-[110] flex items-center justify-center p-6"
        >
          <div className="w-full max-w-sm glass-card p-10 text-center border-white/10 bg-gradient-to-tr from-[#1e293b] to-[#0f172a] shadow-2xl relative">
             <div className="absolute -top-12 left-1/2 -translate-x-1/2 p-6 bg-[#0f172a] rounded-3xl border-2 border-white/10 shadow-[0_0_50px_rgba(234,179,8,0.3)]">
                {isWin ? (
                  <Trophy className="w-16 h-16 text-yellow-500 animate-bounce" />
                ) : (
                  <Shield className="w-16 h-16 text-neutral-600" />
                )}
             </div>
             
             <h2 className={cn("text-5xl font-black uppercase mb-4 mt-8 tracking-tighter italic", isWin ? "gold-gradient" : "text-neutral-600")}>
               {isWin ? "Victorious" : "Defeated"}
             </h2>
             <p className="text-[10px] text-neutral-500 mb-8 uppercase tracking-[0.4em] font-black">Simulation Terminates • Syncing Account...</p>
             
             <div className="grid grid-cols-2 gap-4 mb-4">
               <div className="p-5 bg-white/5 rounded-2xl border border-white/5 shadow-inner">
                 <p className="text-[9px] text-neutral-500 uppercase font-black mb-2 tracking-widest leading-none">Yield</p>
                 <div className="flex flex-col items-center">
                    <p className="text-2xl font-black text-white leading-none">+{battleData.reward_gldp?.toLocaleString() ?? '0'}</p>
                    <p className="text-[8px] text-yellow-500 font-black uppercase mt-1 tracking-widest">GLDp</p>
                 </div>
               </div>
               <div className="p-5 bg-white/5 rounded-2xl border border-white/5 shadow-inner">
                 <p className="text-[9px] text-neutral-500 uppercase font-black mb-2 tracking-widest leading-none">Rank Points</p>
                 <div className="flex flex-col items-center">
                    <p className="text-2xl font-black text-white leading-none">+{isWin ? (battleData.reward_points ?? 10) : (battleData.reward_points ?? 3)}</p>
                    <p className="text-[8px] text-indigo-400 font-black uppercase mt-1 tracking-widest">Activity</p>
                 </div>
               </div>
             </div>

             <div className="bg-white/5 rounded-2xl p-4 border border-white/5 mb-10">
                <p className="text-[9px] text-neutral-500 uppercase font-black mb-3 tracking-widest">Arena Progression</p>
                <div className="flex justify-center gap-2">
                  {[1,2,3,4,5].map(s => (
                    <div 
                      key={s} 
                      className={cn(
                        "w-5 h-2 rounded-full border border-white/10 transition-all duration-1000",
                        s <= (battleData.user?.arena_stars || 0) ? "bg-yellow-500 border-yellow-400 shadow-[0_0_10px_#eab308]" : "bg-white/5"
                      )}
                    />
                  ))}
                </div>
                <p className="text-[10px] text-white/40 font-black uppercase mt-3 tracking-widest">
                  {battleData.user?.arena_tier || 'Epic'} Sector {battleData.user?.arena_tier_level || 1}
                </p>
             </div>

             <button 
               onClick={onFinish}
               className={cn(
                 "w-full py-5 rounded-2xl font-black text-[11px] uppercase tracking-[0.3em] active:scale-95 transition-all shadow-2xl",
                 isWin ? "bg-yellow-500 text-black shadow-yellow-500/20" : "bg-white/10 text-white border border-white/10"
               )}
             >
               TERMINATE SESSION
             </button>
          </div>
        </motion.div>
      )}
    </div>
  );
};

// --- Main Hero Tab ---
export const HeroTab = ({ user, setUser }: { user: UserProfile, setUser: any }) => {
  const [isBattleActive, setIsBattleActive] = useState(false);
  const [selectedOpponent, setSelectedOpponent] = useState<any>(null);

  const classes = [
    { 
      name: 'Warrior', 
      icon: Shield, 
      color: 'blue',
      desc: 'Expert in defensive maneuvers and high physical resilience.',
      stats: { atk: 'Medium', def: 'High', hp: 'Heavy' },
      skills: ['Auto-Repair v2', 'Impact Absorption']
    },
    { 
      name: 'Archer', 
      icon: Target, 
      color: 'orange',
      desc: 'Precision attacker capable of high-velocity critical strikes.',
      stats: { atk: 'High', def: 'Mid', hp: 'Medium' },
      skills: ['Kinetic Dodge', 'Weakpoint Exploit']
    },
    { 
      name: 'Mage', 
      icon: Zap, 
      color: 'purple',
      desc: 'Elemental manipulator using field effects to drain enemies.',
      stats: { atk: 'Heavy', def: 'Low', hp: 'Low' },
      skills: ['Quantum Phase', 'Entropy Burn']
    }
  ];

  const handleSelectClass = async (heroClass: string) => {
    try {
      console.log(`[COMBAT] Initiating hero selection sequence for: ${heroClass}`);
      const res = await fetch('/api/combat/select', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'x-telegram-init-data': window.Telegram?.WebApp?.initData || '' 
        },
        body: JSON.stringify({ telegramId: user.id, heroClass })
      });

      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        const text = await res.text();
        console.error("[COMBAT] Server returned non-JSON selection result:", text.substring(0, 200));
        
        // Detailed error analysis for the user
        if (text.includes("<!DOCTYPE html>")) {
          throw new Error("API Routing Conflict: The server returned an HTML page (likely index.html) instead of processing the API request. This usually happens when the API path is not correctly registered in server.ts or is blocked by middleware.");
        }
        throw new Error("Selection Server Error: Received malformed response from database.");
      }

      const data = await res.json();
      if (data.id) {
        setUser(data);
        console.log(`[COMBAT] Profile updated with hero: ${heroClass}`);
        alert(`Hero Initialized: Welcome, ${heroClass}!`);
      } else {
        console.error("[COMBAT] Selection logic error:", data);
        alert(`Selection Blocked: ${data.error || "System constraints not met"}`);
      }
    } catch (e: any) {
      console.error("[COMBAT] Hero Selection Crash:", e);
      alert(`NETWORK CRITICAL: ${e.message}`);
    }
  };

  const handleUpgrade = async () => {
    const cost = Math.floor(10000 * Math.pow(1.5, user.hero_level));
    if (user.balance < cost) return alert("System Warning: Insufficient GLDp for hardware upgrade!");
    
    try {
      console.log(`[COMBAT] Upgrading hero from level ${user.hero_level}`);
      const res = await fetch('/api/combat/upgrade', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'x-telegram-init-data': window.Telegram?.WebApp?.initData || '' 
        },
        body: JSON.stringify({ telegramId: user.id })
      });
      
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        throw new Error("Upgrade system offline. (Server routing error)");
      }

      const data = await res.json();
      if (data.id) {
        setUser(data);
        console.log(`[COMBAT] Upgrade successful. New Level: ${data.hero_level}`);
      } else {
        alert(data.error || "Upgrade sequence interrupted.");
      }
    } catch (e: any) { 
      console.error("[COMBAT] Upgrade Crash:", e);
      alert(e.message);
    }
  };

  if (!user.hero_class) {
    return (
      <div className="px-6 py-12 space-y-10 animate-in fade-in zoom-in duration-500">
        <div className="text-center space-y-2">
          <h2 className="text-4xl font-black gold-gradient tracking-tighter italic">CHOOSE YOUR PATH</h2>
          <p className="text-[10px] text-neutral-500 uppercase font-black tracking-[0.5em]">Combat Template Initialization Required</p>
        </div>
        
        <div className="space-y-5">
          {classes.map(c => (
            <motion.div 
              whileTap={{ scale: 0.96 }}
              key={c.name}
              onClick={() => handleSelectClass(c.name)}
              className={cn(
                "glass-card p-6 border-white/5 relative overflow-hidden group cursor-pointer select-none transition-all active:ring-2 active:ring-yellow-500/50",
                c.color === 'blue' ? "bg-blue-500/10" :
                c.color === 'orange' ? "bg-orange-500/10" :
                "bg-purple-500/10"
              )}
            >
              <div className="flex items-center gap-6">
                <div className={cn(
                  "w-20 h-20 rounded-3xl flex items-center justify-center border transition-all duration-700 group-hover:rotate-12 group-hover:scale-110",
                  c.color === 'blue' ? "bg-blue-500/20 border-blue-500/40 text-blue-400" :
                  c.color === 'orange' ? "bg-orange-500/20 border-orange-500/40 text-orange-400" :
                  "bg-purple-500/20 border-purple-500/40 text-purple-400"
                )}>
                  <c.icon className="w-10 h-10" />
                </div>
                <div className="flex-1">
                  <h3 className="text-xl font-black text-white italic tracking-tight">{c.name}</h3>
                  <div className="flex gap-2 mt-2">
                    {Object.entries(c.stats).map(([k, v]) => (
                      <span key={k} className="text-[8px] uppercase font-black px-2 py-1 bg-white/5 rounded-lg border border-white/5 text-neutral-400">
                        {k}: <span className="text-white">{v}</span>
                      </span>
                    ))}
                  </div>
                  <p className="text-[11px] text-neutral-500 mt-3 leading-snug font-medium">{c.desc}</p>
                </div>
                <ChevronRight className="w-6 h-6 opacity-30 group-hover:opacity-100 group-hover:translate-x-2 transition-all" />
              </div>
              
              {/* Subtle background glow */}
              <div className={cn(
                "absolute -right-10 -bottom-10 w-40 h-40 blur-[80px] pointer-events-none transition-all duration-700 group-hover:blur-[60px]",
                c.color === 'blue' ? "bg-blue-500/20" :
                c.color === 'orange' ? "bg-orange-500/20" :
                "bg-purple-500/20"
              )} />
            </motion.div>
          ))}
        </div>
      </div>
    );
  }

  const freeMatchesLeft = 10 - (user.combat_matches_free || 0);
  const nextUpgradeCost = Math.floor(10000 * Math.pow(1.5, user.hero_level));

  return (
    <div className="px-6 py-6 pb-24 space-y-6 animate-in slide-in-from-bottom-5 duration-500">
      {isBattleActive && selectedOpponent && (
        <BattleArena 
          user={user} 
          opponent={selectedOpponent} 
          setUser={setUser}
          onFinish={() => {
            setIsBattleActive(false);
            setSelectedOpponent(null);
          }} 
        />
      )}

      {/* Hero Profile - Top Section */}
      <div className="glass-card p-6 bg-gradient-to-br from-[#1e293b] to-[#0f172a] border-white/10 relative overflow-hidden ring-1 ring-white/5">
        <div className="absolute top-0 right-0 w-48 h-48 bg-yellow-500/10 blur-[80px] pointer-events-none rounded-full -mr-20 -mt-20 group-hover:bg-yellow-500/20 transition-all"></div>
        
        <div className="flex items-center gap-6 relative z-10">
          <div className="w-28 h-28 rounded-[2.5rem] bg-[#0f172a] border-2 border-white/10 flex items-center justify-center p-4 relative shadow-2xl group transition-transform duration-500 overflow-hidden">
             {user.hero_class === 'Warrior' && <Shield className="w-full h-full text-blue-400 drop-shadow-[0_0_20px_rgba(59,130,246,0.6)]" />}
             {user.hero_class === 'Archer' && <Target className="w-full h-full text-orange-400 drop-shadow-[0_0_20px_rgba(249,115,22,0.6)]" />}
             {user.hero_class === 'Mage' && <Zap className="w-full h-full text-purple-400 drop-shadow-[0_0_20px_rgba(168,85,247,0.6)]" />}
             <div className="absolute bottom-0 inset-x-0 h-1/3 bg-gradient-to-t from-black/80 to-transparent" />
             <div className="absolute bottom-2 inset-x-0 text-center text-[10px] font-black text-white tracking-[0.2em]">IV v{user.hero_level}</div>
          </div>
          
          <div className="flex-1 space-y-2">
             <div className="flex items-center justify-between">
                <h3 className="text-3xl font-black text-white uppercase tracking-tighter italic leading-none">{user.hero_class}</h3>
                <div className="bg-yellow-500/10 border border-yellow-500/30 px-3 py-1 rounded-full flex items-center gap-2">
                   <Trophy className="w-3.5 h-3.5 text-yellow-500" />
                   <span className="text-[10px] font-black text-yellow-500 uppercase tracking-widest leading-none">MK-{user.hero_level}</span>
                </div>
             </div>
             
             <div className="flex items-center gap-2">
                <p className="text-[10px] font-black text-neutral-400 uppercase tracking-[0.2em]">{user.arena_tier} SECTOR {user.arena_tier_level}</p>
             </div>

             <div className="flex gap-1.5 mt-4">
                {[1,2,3,4,5].map(s => (
                  <motion.div 
                    key={s} 
                    animate={s <= user.arena_stars ? { scale: [1, 1.2, 1], boxShadow: "0 0 10px #eab308" } : {}}
                    className={cn(
                      "w-4 h-1.5 rounded-full border border-white/10 transition-all duration-500", 
                      s <= user.arena_stars ? "bg-yellow-500 border-yellow-400 shadow-[0_0_8px_#eab308]" : "bg-white/5 opacity-30"
                    )} 
                  />
                ))}
             </div>
          </div>
        </div>

        {/* Stats Matrix */}
        <div className="grid grid-cols-3 gap-4 mt-8 relative z-10">
           <div className="bg-black/40 p-4 rounded-2xl border border-white/5 text-center shadow-inner group/stat hover:border-blue-500/30 transition-all">
              <p className="text-[9px] uppercase font-black text-neutral-500 mb-1 tracking-widest leading-none">Attack</p>
              <p className="text-xl font-black text-blue-400 tracking-tight leading-none mt-1">{user.hero_attack}</p>
           </div>
           <div className="bg-black/40 p-4 rounded-2xl border border-white/5 text-center shadow-inner group/stat hover:border-emerald-500/30 transition-all">
              <p className="text-[9px] uppercase font-black text-neutral-500 mb-1 tracking-widest leading-none">Defense</p>
              <p className="text-xl font-black text-emerald-400 tracking-tight leading-none mt-1">{user.hero_defense}</p>
           </div>
           <div className="bg-black/40 p-4 rounded-2xl border border-white/5 text-center shadow-inner group/stat hover:border-red-500/30 transition-all">
              <p className="text-[9px] uppercase font-black text-neutral-500 mb-1 tracking-widest leading-none">Health</p>
              <p className="text-xl font-black text-red-500 tracking-tight leading-none mt-1">{user.hero_health}</p>
           </div>
        </div>

        {/* Upgrade Trigger */}
        <button 
          onClick={handleUpgrade}
          className="w-full mt-6 py-5 bg-white/5 border border-white/10 hover:bg-white/10 hover:border-yellow-500/30 rounded-3xl flex items-center justify-between px-8 transition-all active:scale-[0.98] group/upgrade shadow-xl"
        >
          <div className="text-left">
            <p className="text-[9px] uppercase font-black text-yellow-500 tracking-[0.2em] mb-1">Combat Enhancement</p>
            <p className="text-sm font-black text-white italic">UPGRADE TO MARK {user.hero_level + 1}</p>
          </div>
          <div className="bg-black/60 px-4 py-2 rounded-2xl border border-white/5 group-hover/upgrade:border-yellow-500/30 transition-all">
             <p className="text-xs font-mono font-black text-white leading-none whitespace-nowrap">
               {nextUpgradeCost.toLocaleString()} <span className="text-[9px] font-black text-yellow-500 ml-1">GLDp</span>
             </p>
          </div>
        </button>
      </div>

      {/* Energy Management Dashboard */}
      <div className="grid grid-cols-2 gap-4">
        <div className="glass-card p-5 bg-[#1e293b]/30 border-white/5 relative group overflow-hidden">
           <div className="flex items-center gap-2 mb-4">
              <RefreshCcw className="w-4 h-4 text-blue-500 group-hover:rotate-180 transition-all duration-700" />
              <p className="text-[10px] font-black uppercase text-neutral-400 tracking-widest leading-none">Free Passes</p>
           </div>
           <div className="flex items-end justify-between">
              <p className="text-3xl font-black text-white tracking-tighter leading-none">{freeMatchesLeft}</p>
              <span className="text-[8px] font-black px-2.5 py-1.5 bg-blue-500/10 text-blue-400 rounded-lg border border-blue-500/20 uppercase tracking-widest leading-none shadow-lg">RES 10</span>
           </div>
           <div className="absolute -right-4 -bottom-4 w-12 h-12 bg-blue-500/5 blur-2xl rounded-full" />
        </div>
        <div className="glass-card p-5 bg-[#1e293b]/30 border-white/5 relative group overflow-hidden">
           <div className="flex items-center gap-2 mb-4">
              <Zap className="w-4 h-4 text-emerald-500 group-active:scale-125 transition-all" />
              <p className="text-[10px] font-black uppercase text-neutral-400 tracking-widest leading-none">Ad Charges</p>
           </div>
           <div className="flex items-end justify-between">
              <p className="text-3xl font-black text-white tracking-tighter leading-none">{5 - (user.combat_matches_ads || 0)}</p>
              <div className="flex flex-col items-end">
                <span className="text-[8px] font-black px-2.5 py-1.5 bg-emerald-500/10 text-emerald-500 rounded-lg border border-emerald-500/20 uppercase tracking-widest leading-none shadow-lg">STBY</span>
              </div>
           </div>
           <div className="absolute -right-4 -bottom-4 w-12 h-12 bg-emerald-500/5 blur-2xl rounded-full" />
        </div>
      </div>

      {/* Opponent Radar */}
      <ArenaMatchmaking 
        user={user} 
        onStartBattle={(op) => {
          setSelectedOpponent(op);
          setIsBattleActive(true);
        }} 
      />
    </div>
  );
};
