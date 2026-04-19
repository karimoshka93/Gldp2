import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Home as HomeIcon, 
  Users, 
  Gamepad2, 
  Sword, 
  Target, 
  Wallet as WalletIcon, 
  Trophy,
  Zap,
  Ticket,
  ChevronRight,
  TrendingUp,
  Clock,
  ExternalLink,
  Plus,
  Coins,
  Cpu,
  Globe,
  Database,
  Terminal,
  Shield,
  Workflow,
  Layers,
  Server,
  Code,
  HardDrive,
  Send,
  Crown,
  RefreshCcw,
  Lock
} from 'lucide-react';
import { cn } from './lib/utils';
import { 
  TonConnectUIProvider, 
  TonConnectButton 
} from '@tonconnect/ui-react';
import { 
  UserProfile, 
  DeveloperCard, 
  Mission 
} from './types';

// --- Components ---

const Navbar = ({ activeTab, setActiveTab }: { activeTab: string, setActiveTab: (t: string) => void }) => {
  const tabs = [
    { id: 'home', icon: HomeIcon, label: 'Home' },
    { id: 'developers', icon: Code, label: 'Devs' },
    { id: 'ranking', icon: Trophy, label: 'Ranking' },
    { id: 'missions', icon: Target, label: 'Quests' },
    { id: 'wallet', icon: WalletIcon, label: 'Wallet' },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 h-20 bg-[#1e293b]/90 backdrop-blur-2xl border-t border-[#334155] flex items-center justify-around px-2 z-50">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={cn(
            "tab-item group relative",
            activeTab === tab.id ? "text-[#facc15]" : "text-[#94a3b8]"
          )}
        >
          <tab.icon className={cn("w-6 h-6 transition-transform", activeTab === tab.id && "scale-110")} />
          <span className="text-[9px] uppercase font-bold tracking-wider">{tab.label}</span>
          {activeTab === tab.id && (
            <motion.div 
              layoutId="activeTab"
              className="absolute -top-1 w-1.5 h-1.5 bg-[#facc15] rounded-full shadow-[0_0_8px_#facc15]" 
            />
          )}
        </button>
      ))}
    </nav>
  );
};

const Header = ({ user, setActiveTab }: { user: UserProfile | null, setActiveTab: (t: string) => void }) => (
  <header 
    onClick={(e) => {
      e.preventDefault();
      setActiveTab('profile');
    }}
    className="fixed top-0 left-0 right-0 px-6 pt-10 pb-4 bg-[#0f172a]/80 backdrop-blur-md z-40 flex items-center justify-between border-b border-[#334155] cursor-pointer active:bg-white/5 transition-colors"
  >
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-yellow-500 to-amber-600 flex items-center justify-center font-bold text-white shadow-[0_0_15px_rgba(234,179,8,0.3)] border-2 border-yellow-400 overflow-hidden">
        {user?.photo_url ? (
          <img src={user.photo_url} alt="Profile" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <div className="text-sm font-black">{user?.username?.[0]?.toUpperCase() || 'G'}</div>
        )}
      </div>
      <div>
        <p className="text-[10px] text-[#94a3b8] uppercase font-bold tracking-[0.2em] leading-none mb-1">My Identity</p>
        <p className="text-sm font-black tracking-tight leading-none text-white">@{user?.username || 'Collector'}</p>
      </div>
    </div>
    <div className="flex items-center gap-2 px-3 py-1.5 glass-card border-yellow-500/30">
      <Trophy className="w-3.5 h-3.5 text-yellow-500" />
      <span className="text-xs font-mono font-black text-yellow-500">Rank #{user?.airdropRank || 0}</span>
    </div>
  </header>
);

const HomeTab = ({ user, setUser, syncBalance }: { user: UserProfile, setUser: (u: UserProfile) => void, syncBalance: (b: number, e: number) => Promise<void> }) => {
  const [tapValue, setTapValue] = useState(user.balance);
  const [floatingTexts, setFloatingTexts] = useState<{ id: number, x: number, y: number }[]>([]);
  const tapCooldownRef = useRef<NodeJS.Timeout | null>(null);
  const [accumulated, setAccumulated] = useState(0);
  const [timeLeft, setTimeLeft] = useState(14400); // 4 hours in seconds

  // Live calculation of accumulated passive income
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      const lastClaim = new Date(user.last_claim_at);
      const diffSecs = (now.getTime() - lastClaim.getTime()) / 1000;
      
      const earned = Math.floor(diffSecs * user.multiplier);
      setAccumulated(earned);
      
      const remaining = Math.max(0, 14400 - (diffSecs % 14400));
      setTimeLeft(remaining);
    }, 1000);
    return () => clearInterval(interval);
  }, [user.last_claim_at, user.multiplier]);

  const handleTap = (e: React.MouseEvent | React.TouchEvent) => {
    if (user.energy <= 0) return;

    const x = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const y = 'touches' in e ? e.touches[0].clientY : e.clientY;
    
    // Calculate new values based on current state to avoid stale closure issues
    const newBalance = (user.balance || 0) + 1;
    const newEnergy = Math.max(0, user.energy - 1);

    setFloatingTexts(prev => [...prev, { id: Date.now(), x, y }]);
    
    // Update local state IMMEDIATELY
    setTapValue(newBalance);
    setUser({ ...user, balance: newBalance, energy: newEnergy });

    if (tapCooldownRef.current) clearTimeout(tapCooldownRef.current);
    tapCooldownRef.current = setTimeout(() => {
      syncBalance(newBalance, newEnergy);
    }, 1500);

    setTimeout(() => {
      setFloatingTexts(prev => prev.filter(t => t.id !== Date.now()));
    }, 800);
  };

  // Client-side visual energy refill (1 per sec)
  useEffect(() => {
    const energyInterval = setInterval(() => {
      if (user.energy < 1000) {
        setUser(prev => prev ? { ...prev, energy: Math.min(1000, prev.energy + 1) } : null);
      }
    }, 1000);
    return () => clearInterval(energyInterval);
  }, [user.energy < 1000]);

  // Sync tapValue if user.balance changes externally (e.g. claim)
  useEffect(() => {
    // Only update if the difference is significant (passive income vs tapping)
    // or if we are not actively tapping (cooldown is null)
    if (!tapCooldownRef.current) {
        setTapValue(user.balance);
    }
  }, [user.balance]);

  const handleClaim = async () => {
    try {
      if (accumulated <= 0) return alert("Nothing to claim yet!");
      
      const res = await fetch('/api/user/claim', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-telegram-init-data': window.Telegram?.WebApp?.initData || ''
        },
        body: JSON.stringify({ telegramId: user.id })
      });
      const data = await res.json();
      if (data.user) {
        setUser(data.user);
        setTapValue(data.user.balance);
        alert(`Claimed ${data.earned.toLocaleString()} GLDp!`);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const formatTime = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col items-center gap-10 pt-4 pb-24 px-6 relative overflow-hidden">
      {/* Floating Particles/Texts */}
      <AnimatePresence>
        {floatingTexts.map(t => (
          <motion.div
            key={t.id}
            initial={{ opacity: 1, y: t.y - 20, scale: 0.5 }}
            animate={{ opacity: 0, y: t.y - 150, scale: 2 }}
            exit={{ opacity: 0 }}
            className="fixed pointer-events-none text-3xl font-black gold-gradient z-50 select-none"
            style={{ left: t.x - 10 }}
          >
            +1
          </motion.div>
        ))}
      </AnimatePresence>

      {/* Balance Display */}
      <motion.div 
        key={Math.floor(tapValue ?? 0)}
        initial={{ scale: 0.95 }}
        animate={{ scale: 1 }}
        className="text-center"
      >
        <div className="flex items-center justify-center gap-3">
          <div className="w-14 h-14 bg-gradient-to-tr from-yellow-400 to-amber-600 rounded-full flex items-center justify-center shadow-[0_0_20px_rgba(234,179,8,0.5)] border-2 border-yellow-300">
             <Coins className="w-8 h-8 text-yellow-900" />
          </div>
          <h1 className="text-6xl font-black gold-gradient font-sans tracking-tight">
            {Math.floor(tapValue ?? 0).toLocaleString()}
          </h1>
        </div>
        <p className="text-[12px] text-yellow-500/80 mt-2 uppercase tracking-[0.3em] font-black">GLDp Balance</p>
      </motion.div>

      {/* Elegant Main Tap Sphere */}
      <div className="relative mt-4">
        <motion.button
          whileTap={{ scale: 0.92, rotate: 2 }}
          onClick={handleTap}
          onTouchStart={handleTap}
          className="relative w-64 h-64 rounded-full group outline-none"
        >
          {/* Animated Glow Layers */}
          <div className="absolute inset-0 rounded-full bg-yellow-500/20 blur-3xl group-active:bg-yellow-500/40 transition-all duration-500" />
          <div className="absolute inset-[-10px] rounded-full bg-gradient-to-tr from-yellow-600/10 to-amber-500/10 animate-pulse" />
          
          {/* The Sphere Body */}
          <div className="absolute inset-0 rounded-full bg-gradient-to-b from-[#fde047] via-[#eab308] to-[#854d0e] p-[4px] shadow-[0_0_50px_rgba(234,179,8,0.3)] border border-white/20">
            <div className="w-full h-full rounded-full bg-gradient-to-tr from-black/40 via-transparent to-white/30 flex items-center justify-center overflow-hidden">
               <div className="relative">
                 <div className="absolute inset-0 blur-md bg-yellow-400/50 scale-125" />
                 <Coins className="w-32 h-32 text-yellow-100 relative drop-shadow-[0_4px_10px_rgba(0,0,0,0.5)]" />
               </div>
            </div>
          </div>

          {/* Inner Reflection Overlay */}
          <div className="absolute inset-4 rounded-full bg-gradient-to-br from-white/10 to-transparent pointer-events-none" />
        </motion.button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-4 w-full max-w-sm">
        <div className="glass-card p-4 border-white/5 bg-[#1e293b]/50">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="w-4 h-4 text-yellow-400 fill-yellow-400" />
            <span className="text-[10px] uppercase font-black text-neutral-400 tracking-wider">Energy Supply</span>
          </div>
          <div className="flex items-end justify-between">
            <p className="text-xl font-black text-white">{user.energy}<span className="text-[10px] text-neutral-500 ml-1">/1000</span></p>
          </div>
          <div className="w-full h-1.5 bg-white/5 rounded-full mt-3 overflow-hidden border border-white/5">
            <motion.div 
              initial={{ width: 0 }}
              animate={{ width: `${(user.energy / 1000) * 100}%` }}
              className="h-full bg-gradient-to-r from-yellow-400 to-amber-600 shadow-[0_0_10px_rgba(234,179,8,0.4)]" 
            />
          </div>
        </div>

        <div className="glass-card p-4 border-white/5 bg-[#1e293b]/50">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="w-4 h-4 text-green-400" />
            <span className="text-[10px] uppercase font-black text-neutral-400 tracking-wider">Hourly Revenue</span>
          </div>
          <p className="text-xl font-black text-white">
            +{(user.multiplier * 3600).toLocaleString()}<span className="text-[10px] text-green-400 ml-1">/h</span>
          </p>
          <div className="text-[9px] text-neutral-500 mt-2 flex items-center justify-between">
            <span className="uppercase font-bold tracking-tighter">Current ROI</span>
            <span className="font-mono text-green-400/80">Active</span>
          </div>
        </div>
      </div>

      {/* Claimable Profits Section */}
      <div className="w-full max-w-sm">
        <button 
          onClick={handleClaim}
          className="w-full glass-card p-5 border-yellow-500/20 bg-gradient-to-tr from-[#1e293b]/80 to-[#0f172a]/80 group active:scale-[0.98] transition-all"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-yellow-500/10 rounded-lg group-hover:bg-yellow-500/20 transition-colors">
                <Clock className="w-5 h-5 text-yellow-500" />
              </div>
              <div className="text-left">
                <p className="text-[10px] text-neutral-500 uppercase font-black tracking-widest leading-none mb-1">Accumulated Profit</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-2xl font-black text-white">{accumulated.toLocaleString()}</span>
                  <span className="text-xs font-black text-yellow-500 uppercase">GLDp</span>
                </div>
              </div>
            </div>
            <div className="text-right">
              <p className="text-[8px] text-neutral-500 uppercase font-black mb-1">Next Cycle</p>
              <p className="text-xs font-mono font-black text-neutral-300">{formatTime(timeLeft)}</p>
            </div>
          </div>
          
          <div className="h-12 w-full rounded-xl bg-yellow-500 flex items-center justify-center font-black text-black text-sm shadow-lg shadow-yellow-500/20 group-hover:bg-yellow-400 transition-colors uppercase tracking-[0.2em]">
            CLAIM NOW
          </div>
        </button>
      </div>
    </div>
  );
};

const DevelopersTab = ({ user, setUser, syncBalance }: { user: UserProfile, setUser: (u: UserProfile) => void, syncBalance: (b: number, e: number) => Promise<void> }) => {
  const devIcons = [Cpu, Globe, Database, Terminal, Shield, Workflow, Layers, Server, Code, HardDrive];
  
  const devs: DeveloperCard[] = Array.from({ length: 30 }, (_, i) => ({
    id: `dev-${i+1}`,
    name: `Senior Dev #${i + 1}`,
    description: `Optimizes tapping throughput v${i + 1}`,
    base_cost: Math.floor(1000 * Math.pow(1.5, i)),
    base_boost: (i + 1) * 0.05,
    image_url: '' // We use Lucide icons instead
  }));

  const handleUpgrade = async (dev: DeveloperCard) => {
    try {
      if (user.balance < dev.base_cost) return alert("Insufficient GLDp!");
      
      // Force sync balance before upgrade to ensure DB is up to date
      await syncBalance(user.balance, user.energy);
      
      const res = await fetch('/api/user/upgrade', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-telegram-init-data': window.Telegram?.WebApp?.initData || ''
        },
        body: JSON.stringify({ 
          telegramId: user.id, 
          developerId: dev.id,
          cost: dev.base_cost,
          boost: dev.base_boost
        })
      });
      const data = await res.json();
      if (data.id) {
        setUser(data);
        alert(`Successfully hired ${dev.name}!`);
      } else {
        alert(data.error || 'Upgrade failed');
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="px-6 pb-24 grid grid-cols-1 gap-4">
      <div className="pt-6">
        <h2 className="text-3xl font-black gold-gradient uppercase tracking-tight">Building Roster</h2>
        <p className="text-[10px] text-neutral-500 uppercase font-black tracking-widest mt-1">Acquire top talent for hourly earnings</p>
      </div>
      
      {devs.map((dev, i) => {
        const Icon = devIcons[i % devIcons.length];
        return (
          <div key={dev.id} className="glass-card p-4 flex items-center justify-between group bg-[#1e293b]/50 border-white/5 active:bg-white/5">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center border border-white/10 shrink-0 group-hover:from-indigo-500/40 transition-all">
                 <Icon className="w-7 h-7 text-indigo-400" />
              </div>
              <div>
                <p className="font-black text-sm text-white">{dev.name}</p>
                <div className="flex items-center gap-2 mt-1">
                  <TrendingUp className="w-3 h-3 text-green-400" />
                  <span className="text-[11px] font-black text-green-400">+{dev.base_boost.toFixed(2)} /h</span>
                </div>
              </div>
            </div>
            <button 
              onClick={() => handleUpgrade(dev)}
              className="flex flex-col items-end gap-1"
            >
              <div className="px-4 py-2 rounded-xl bg-indigo-500 text-white font-black text-xs shadow-lg shadow-indigo-500/20 active:scale-90 transition-all">
                {dev.base_cost.toLocaleString()}
              </div>
              <span className="text-[8px] uppercase font-bold text-neutral-500">Buy</span>
            </button>
          </div>
        );
      })}
    </div>
  );
};

const MissionsTab = ({ user, referralCount, setUser }: { user: UserProfile, referralCount: number, setUser: (u: UserProfile) => void }) => {
  const [claiming, setClaiming] = useState<string | null>(null);
  const [adCooldown, setAdCooldown] = useState<number>(0);
  const [adCount, setAdCount] = useState(0);

  const missions: Mission[] = [
    { id: 'daily_login', title: 'Daily Login Reward', reward: 1000, points: 5, type: 'daily' },
    { id: 'tg_post', title: 'Check latest Telegram post', reward: 2000, points: 10, type: 'social', link: 'https://t.me/digitalgold2025' },
    { id: 'x_post', title: 'Check latest X post', reward: 2000, points: 10, type: 'social', link: 'https://x.com/DigitalGold2025' },
    { id: 'ig_post', title: 'Check latest Instagram post', reward: 2000, points: 10, type: 'social', link: 'https://instagram.com/digitalgold11' },
    { id: 'mining_gld', title: 'Mine Real GLD Network', reward: 5000, points: 25, type: 'social', link: 'https://digitalgold.com.ru' },
    { id: 'adsgram', title: 'Watch Ads for GLDp (10/10)', reward: 2500, points: 15, type: 'ads' },
  ];

  // Update ad state from user profile
  useEffect(() => {
    if (user.daily_quest_states?.adsgram) {
      const { count, last_ad_at } = user.daily_quest_states.adsgram;
      setAdCount(count || 0);
      const now = Date.now();
      const timeLeft = Math.max(0, (last_ad_at + 3600000) - now);
      setAdCooldown(Math.ceil(timeLeft / 1000));
    }
  }, [user.daily_quest_states]);

  // Cooldown timer
  useEffect(() => {
    if (adCooldown <= 0) return;
    const interval = setInterval(() => {
      setAdCooldown(prev => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [adCooldown]);

  const handleQuestAction = async (m: Mission) => {
    if (claiming) return;

    // Check if already done today
    const questState = user.daily_quest_states?.[m.id];
    if (questState && m.type !== 'ads') {
      const lastDone = new Date(questState);
      if (lastDone.toDateString() === new Date().toDateString()) {
        alert('You already completed this quest today! Come back tomorrow.');
        return;
      }
    }

    if (m.type === 'social') {
      // 1. Check if we're in "Verification" mode
      if (claiming === m.id) {
        // User clicked again to verify
        try {
          const res = await fetch('/api/user/complete-quest', {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'x-telegram-init-data': window.Telegram?.WebApp?.initData || ''
            },
            body: JSON.stringify({
              telegramId: user.id,
              questId: m.id,
              reward: m.reward,
              points: m.points
            })
          });
          const data = await res.json();
          if (data.id) {
            setUser(data);
            alert("Verification successful! Reward added.");
          } else {
            alert(data.error || "Please visit the link first.");
          }
        } catch (err) {
          console.error(err);
        } finally {
          setClaiming(null);
        }
        return;
      }

      // 2. Initial click: Open link and set claiming state
      window.open(m.link, '_blank');
      setClaiming(m.id);
      alert("Opening task... Please return and click the task again to VERIFY and CLAIM your reward.");
      
    } else if (m.type === 'daily') {
      setClaiming(m.id);
      try {
        const res = await fetch('/api/user/complete-quest', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-telegram-init-data': window.Telegram?.WebApp?.initData || ''
          },
          body: JSON.stringify({
            telegramId: user.id,
            questId: m.id,
            reward: m.reward,
            points: m.points
          })
        });
        const data = await res.json();
        if (data.id) setUser(data);
      } catch (err) {
        console.error(err);
      } finally {
        setClaiming(null);
      }
    } else if (m.type === 'ads') {
      if (adCount >= 10) return alert('Daily ads limit reached!');
      if (adCooldown > 0) return alert(`Please wait ${Math.floor(adCooldown/60)}m ${adCooldown%60}s for next ad`);

      // Adsgram logic
      // @ts-ignore
      const adsgram = (window as any).Adsgram;
      if (adsgram) {
        // @ts-ignore
        const AdController = adsgram.init({ blockId: "28171" });
        AdController.show().then(async () => {
          // Success
          alert('Ad watched successfully! Processing reward...');
          
          try {
            const res = await fetch('/api/user/ad-reward', {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                'x-telegram-init-data': window.Telegram?.WebApp?.initData || ''
              },
              body: JSON.stringify({ telegramId: user.id })
            });
            const data = await res.json();
            if (data.id) {
              setUser(data);
              alert('Balance updated! +2,500 GLDp');
            }
          } catch (err) {
            console.error("Reward error:", err);
          }
        }).catch((err: any) => {
          console.error("Ad error:", err);
          alert('Ad was skipped or failed to load. No reward given.');
        });
      } else {
        alert('Adsgram SDK is still loading or blocked. Please try again on Telegram Mobile and wait a few seconds.');
      }
    }
  };

  const shareLink = `https://t.me/GLDp_bot/app?startapp=${user.id}`;
  const telegramShare = `https://t.me/share/url?url=${encodeURIComponent(shareLink)}&text=${encodeURIComponent('Join me on GLD Tap and earn tokens! 🚀')}`;

  const isCompleted = (id: string) => {
    const state = user.daily_quest_states?.[id];
    if (!state) return false;
    return new Date(state).toDateString() === new Date().toDateString();
  };

  return (
    <div className="px-6 pb-24 space-y-4 pt-6">
      <div className="text-center mb-6">
        <h2 className="text-3xl font-black gold-gradient uppercase tracking-tighter">GLD Missions</h2>
        <p className="text-[10px] text-neutral-500 uppercase font-bold tracking-widest mt-1">Boost your Airdrop Eligibility</p>
      </div>
      
      {/* Referral Section */}
      <div className="glass-card p-5 border-indigo-500/30 bg-indigo-500/5 relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500/10 blur-[40px] pointer-events-none rounded-full"></div>
        <div className="flex flex-col gap-4 relative">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-indigo-500/10 rounded-lg">
                <Users className="w-5 h-5 text-indigo-400" />
              </div>
              <div>
                <p className="font-black text-sm text-white">Network Growth</p>
                <p className="text-[10px] text-indigo-400 font-mono">+50 Points / Invite</p>
              </div>
            </div>
            <div className="text-right">
               <p className="text-xl font-black text-white">{referralCount}</p>
               <p className="text-[8px] uppercase font-bold text-neutral-500">Recruits</p>
            </div>
          </div>
          
          <div className="flex gap-2">
            <a 
              href={telegramShare}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 py-3 bg-gradient-to-r from-blue-500 to-indigo-600 text-white rounded-xl text-xs font-black flex items-center justify-center gap-2 active:scale-95 transition-all shadow-xl shadow-blue-500/20 uppercase tracking-widest"
            >
              <Send className="w-4 h-4" />
              INVITE
            </a>
            <button 
              onClick={() => {
                navigator.clipboard.writeText(shareLink);
                alert('Copied link!');
              }}
              className="px-6 py-3 bg-[#1e293b] text-white rounded-xl text-xs font-black border border-white/5 active:scale-95 transition-all uppercase tracking-widest"
            >
              LINK
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {missions.map(m => {
          const done = m.type === 'ads' ? adCount >= 10 : isCompleted(m.id);
          const onCooldown = m.type === 'ads' && adCooldown > 0;

          return (
            <motion.div 
              key={m.id} 
              whileTap={{ scale: done ? 1 : 0.98 }}
              onClick={() => !done && !claiming && handleQuestAction(m)}
              className={cn(
                "glass-card p-5 flex items-center justify-between border-white/5 transition-all",
                done ? "opacity-50 grayscale bg-white/5" : "bg-white/5 hover:bg-white/10 active:border-yellow-500/30",
                claiming === m.id && "animate-pulse border-blue-500/50"
              )}
            >
              <div className="flex items-center gap-4">
                <div className={cn(
                  "p-3 rounded-xl",
                  m.type === 'daily' ? "bg-blue-500/10 text-blue-400" :
                  m.type === 'social' ? "bg-purple-500/10 text-purple-400" :
                  "bg-orange-500/10 text-orange-400"
                )}>
                   {m.type === 'daily' ? <Clock className="w-5 h-5" /> : 
                    m.type === 'social' ? <Target className="w-5 h-5" /> : 
                    <Cpu className="w-5 h-5" />}
                </div>
                <div>
                  <p className="text-xs font-black text-white uppercase tracking-tight">
                    {m.title}
                    {m.type === 'ads' && ` (${adCount}/10)`}
                  </p>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-[10px] font-mono text-yellow-500 font-bold">+{m.reward.toLocaleString()} GLDp</span>
                    <span className="text-[10px] font-mono text-indigo-400 font-bold">+{m.points} POINTS</span>
                  </div>
                </div>
              </div>
              
              {done ? (
                <div className="p-1 px-3 bg-white/10 rounded-full text-[8px] font-black uppercase text-neutral-400">Done</div>
              ) : onCooldown ? (
                <div className="text-[10px] font-mono text-neutral-500 font-bold">
                  {Math.floor(adCooldown/60)}m {adCooldown%60}s
                </div>
              ) : claiming === m.id ? (
                <div className="w-4 h-4 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin" />
              ) : (
                <ChevronRight className="w-5 h-5 opacity-20" />
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
};

const ProfilePage = ({ user, referralCount, setUser, errorDetails }: { user: UserProfile, referralCount: number, setUser: (u: UserProfile) => void, errorDetails: string | null }) => {
  const shareLink = `https://t.me/GLDp_bot/app?startapp=${user.id}`;
  const telegramShare = `https://t.me/share/url?url=${encodeURIComponent(shareLink)}&text=${encodeURIComponent('Join me on GLD Tap and earn tokens! 🚀')}`;
  const [isSyncing, setIsSyncing] = useState(false);

  const syncOldPoints = async () => {
    alert('Legacy data synchronization is currently in maintenance. Coming soon!');
  };

  return (
    <div className="px-6 space-y-6 pt-6 pb-24">
      {/* Profile Header */}
      <div className="flex flex-col items-center gap-4 py-8">
        <div className="w-28 h-28 rounded-full bg-gradient-to-tr from-indigo-500 via-purple-500 to-pink-500 p-1.5 shadow-[0_0_40px_rgba(139,92,246,0.3)]">
          <div className="w-full h-full rounded-full bg-[#0f172a] overflow-hidden border-2 border-[#1e293b]">
            {user.photo_url ? (
              <img src={user.photo_url} alt="Profile" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-4xl font-black text-white">{user.username?.[0]?.toUpperCase() || 'G'}</div>
            )}
          </div>
        </div>
        <div className="text-center">
          <h2 className="text-3xl font-black text-white tracking-tighter">{user.first_name || user.username}</h2>
          <div className="flex items-center justify-center gap-2 mt-1">
            <span className="text-blue-400 font-mono text-xs font-bold px-2 py-0.5 bg-blue-500/10 rounded-full border border-blue-500/20">@{user.username}</span>
            <span className="text-[#facc15] font-mono text-xs font-bold px-2 py-0.5 bg-[#facc15]/10 rounded-full border border-[#facc15]/20 font-black tracking-tighter uppercase">R# {user.airdropRank}</span>
          </div>
        </div>
      </div>

      {/* Fake Sync Button */}
      <button 
        disabled={true}
        className="w-full py-4 glass-card border-white/10 bg-white/5 text-neutral-500 font-black text-xs flex items-center justify-center gap-2 cursor-not-allowed opacity-50 transition-all"
      >
        <Lock className="w-4 h-4" />
        SYNC V1 ACTIVITY (COMING SOON)
      </button>

      {/* Sync Error Context (Only if sync failed) */}
      {errorDetails && (
        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-2xl">
          <div className="flex items-center gap-2 text-red-400 mb-1">
            <Shield className="w-4 h-4" />
            <p className="text-[10px] font-black uppercase tracking-widest">Database Status: Sync Warning</p>
          </div>
          <p className="text-xs text-[#94a3b8] leading-relaxed">{errorDetails}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="glass-card p-4 flex flex-col items-center text-center border-white/5 bg-[#1e293b]/30">
          <Coins className="w-5 h-5 text-yellow-500 mb-2" />
          <p className="text-[9px] uppercase font-bold text-neutral-500 tracking-widest">Total GLDp</p>
          <p className="text-xl font-black text-white mt-1">{Math.floor(user.balance).toLocaleString()}</p>
        </div>
        <div className="glass-card p-4 flex flex-col items-center text-center border-white/5 bg-[#1e293b]/30">
          <Users className="w-5 h-5 text-pink-400 mb-2" />
          <p className="text-[9px] uppercase font-bold text-neutral-500 tracking-widest">Referrals</p>
          <p className="text-xl font-black text-white mt-1">{referralCount}</p>
        </div>
        <div className="glass-card p-4 flex flex-col items-center text-center border-white/5 bg-[#1e293b]/30">
          <Zap className="w-5 h-5 text-indigo-400 mb-2" />
          <p className="text-[9px] uppercase font-bold text-neutral-500 tracking-widest">Hourly Profit</p>
          <p className="text-xl font-black text-white mt-1">+{Math.floor(user.multiplier * 3600)}</p>
        </div>
        <div className="glass-card p-4 flex flex-col items-center text-center border-white/5 bg-[#1e293b]/30">
          <Target className="w-5 h-5 text-emerald-400 mb-2" />
          <p className="text-[9px] uppercase font-bold text-neutral-500 tracking-widest">Daily Limit</p>
          <p className="text-xl font-black text-white mt-1">1,000</p>
        </div>
      </div>

      <div className="glass-card p-6 space-y-6 border-white/10 bg-indigo-500/5 relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/10 blur-[60px] pointer-events-none rounded-full -mr-16 -mt-16 group-hover:bg-indigo-500/20 transition-all duration-700"></div>
        <div className="relative">
          <h3 className="text-sm font-black text-white uppercase tracking-widest mb-3 flex items-center gap-2">
             <Send className="w-4 h-4 text-blue-400" />
             Referral Link
          </h3>
          <div className="bg-[#0f172a] p-4 rounded-xl border border-white/5 font-mono text-[10px] text-neutral-400 break-all select-all shadow-inner">
            {shareLink}
          </div>
        </div>
        <div className="flex gap-3 relative">
          <a 
            href={telegramShare}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-[2] py-4 bg-gradient-to-r from-blue-500 to-indigo-600 text-white rounded-2xl font-black text-[11px] flex items-center justify-center gap-2 shadow-xl shadow-blue-500/20 active:scale-95 transition-all uppercase tracking-widest"
          >
            <Send className="w-4 h-4" />
            SHARE ON TELEGRAM
          </a>
          <button 
            onClick={() => {
              navigator.clipboard.writeText(shareLink);
              alert('Copied to clipboard!');
            }}
            className="flex-1 py-4 bg-[#1e293b] text-white rounded-2xl font-black text-[11px] border border-white/10 active:scale-95 transition-all uppercase tracking-widest"
          >
            COPY
          </button>
          <div className="glass-card p-6 mt-6">
            <h3 className="text-[10px] uppercase font-black text-[#94a3b8] tracking-[0.2em] mb-4">Internal System Stats</h3>
            <div className="space-y-4">
              <div className="flex justify-between items-center pb-4 border-b border-white/5">
                <span className="text-xs text-[#94a3b8]">Build Version</span>
                <span className="text-xs font-mono text-blue-400">2026.04.19.1305</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-[#94a3b8]">Last Server Sync</span>
                <span className="text-xs font-mono text-green-400">{new Date(user.updated_at).toLocaleTimeString()}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
const RankingTab = ({ user }: { user: UserProfile }) => {
  const [leaders, setLeaders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState('airdropRank');

  useEffect(() => {
    setLoading(true);
    fetch(`/api/leaderboard?sortBy=${sortBy}`)
      .then(res => res.json())
      .then(data => {
        setLeaders(data || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [sortBy]);

  // Find current user position
  const userRank = leaders.findIndex(l => l.id === user.id) + 1;

  const top3 = leaders.slice(0, 3);
  const rest = leaders.slice(3, 100);

  const getMetric = (l: any) => {
    if (sortBy === 'multiplier') return `+${Math.floor(l.multiplier * 3600)}/h`;
    return l.airdropRank.toLocaleString();
  };

  return (
    <div className="px-4 pb-24 pt-6 space-y-6">
      {/* Announcement */}
      <div className="glass-card p-4 border-yellow-500/20 bg-yellow-500/5 relative overflow-hidden">
        <div className="flex items-start gap-3 relative">
          <div className="p-2 bg-yellow-500/10 rounded-lg">
             <Trophy className="w-5 h-5 text-yellow-500" />
          </div>
          <div>
            <p className="text-[10px] text-neutral-500 uppercase font-black tracking-widest mb-1">Growth Intelligence</p>
            <p className="text-xs text-white/80 leading-relaxed">
              Ascend ranks by completing <span className="text-yellow-500 font-bold">Quests</span>. Increase your hourly dividends by acquiring <span className="text-indigo-400 font-bold">Dev Personnel</span> in the roster.
            </p>
          </div>
        </div>
      </div>

      {/* Sorting Tabs */}
      <div className="flex p-1 bg-white/5 rounded-2xl border border-white/5">
        <button 
          onClick={() => setSortBy('airdropRank')}
          className={cn(
            "flex-1 py-3 px-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all",
            sortBy === 'airdropRank' ? "bg-white text-black shadow-lg" : "text-neutral-500"
          )}
        >
          Activity
        </button>
        <button 
          onClick={() => setSortBy('multiplier')}
          className={cn(
            "flex-1 py-3 px-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all",
            sortBy === 'multiplier' ? "bg-white text-black shadow-lg" : "text-neutral-500"
          )}
        >
          Earnings
        </button>
        <button 
          disabled
          className="flex-1 py-3 px-2 rounded-xl text-[10px] font-black uppercase tracking-widest text-neutral-700 cursor-not-allowed group relative"
        >
          Combat
          <span className="absolute -top-1 -right-1 bg-neutral-800 text-[6px] px-1 rounded border border-white/10">SOON</span>
        </button>
      </div>

      {loading ? (
        <div className="text-center py-20 animate-pulse text-yellow-500 font-black">CALCULATING NETWORK HIERARCHY...</div>
      ) : (
        <>
          {/* Podium */}
          <div className="relative flex items-end justify-center gap-2 h-60 px-2 pt-12">
            {/* 2nd Place */}
            {top3[1] && (
              <div className="flex flex-col items-center gap-2 flex-1 max-w-[100px]">
                <div className="relative">
                  <div className="w-16 h-16 rounded-full border-2 border-slate-300 overflow-hidden bg-[#1e293b] shadow-lg">
                    {top3[1].photo_url ? <img src={top3[1].photo_url} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center font-bold text-slate-300">{top3[1].username?.[0]?.toUpperCase()}</div>}
                  </div>
                  <div className="absolute -bottom-2 -right-1 bg-slate-300 text-slate-900 text-[10px] font-black w-6 h-6 rounded-full flex items-center justify-center border-2 border-[#0f172a]">2</div>
                </div>
                <div className="w-full bg-slate-800/20 rounded-t-xl h-24 flex flex-col items-center justify-center p-2 border-x border-t border-slate-300/20 text-center">
                  <p className="text-[10px] font-black truncate w-full text-white">@{top3[1].username}</p>
                  <p className="text-xs font-mono font-bold text-slate-300">{getMetric(top3[1])}</p>
                </div>
              </div>
            )}

            {/* 1st Place */}
            {top3[0] && (
              <div className="flex flex-col items-center gap-2 flex-1 max-w-[120px] -translate-y-4">
                <div className="relative">
                  <div className="absolute -top-6 left-1/2 -translate-x-1/2">
                    <Crown className="w-8 h-8 text-yellow-500 drop-shadow-[0_0_15px_rgba(234,179,8,0.5)]" />
                  </div>
                  <div className="w-20 h-20 rounded-full border-4 border-yellow-500 overflow-hidden bg-[#1e293b] shadow-[0_0_30px_rgba(234,179,8,0.2)]">
                    {top3[0].photo_url ? <img src={top3[0].photo_url} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center font-black text-2xl text-yellow-500">{top3[0].username?.[0]?.toUpperCase()}</div>}
                  </div>
                  <div className="absolute -bottom-2 -right-1 bg-yellow-500 text-yellow-900 text-xs font-black w-8 h-8 rounded-full flex items-center justify-center border-4 border-[#0f172a]">1</div>
                </div>
                <div className="w-full bg-yellow-500/10 rounded-t-2xl h-32 flex flex-col items-center justify-center p-2 border-x border-t border-yellow-500/30 text-center">
                  <p className="text-xs font-black truncate w-full text-yellow-500">@{top3[0].username}</p>
                  <p className="text-sm font-mono font-black text-white">{getMetric(top3[0])}</p>
                </div>
              </div>
            )}

            {/* 3rd Place */}
            {top3[2] && (
              <div className="flex flex-col items-center gap-2 flex-1 max-w-[100px]">
                <div className="relative">
                  <div className="w-16 h-16 rounded-full border-2 border-amber-600 overflow-hidden bg-[#1e293b] shadow-lg">
                    {top3[2].photo_url ? <img src={top3[2].photo_url} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center font-bold text-amber-600">{top3[2].username?.[0]?.toUpperCase()}</div>}
                  </div>
                  <div className="absolute -bottom-2 -right-1 bg-amber-600 text-amber-100 text-[10px] font-black w-6 h-6 rounded-full flex items-center justify-center border-2 border-[#0f172a]">3</div>
                </div>
                <div className="w-full bg-amber-900/10 rounded-t-xl h-20 flex flex-col items-center justify-center p-2 border-x border-t border-amber-600/20 text-center">
                  <p className="text-[10px] font-black truncate w-full text-white">@{top3[2].username}</p>
                  <p className="text-xs font-mono font-bold text-amber-600">{getMetric(top3[2])}</p>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            {rest.map((l, i) => (
              <motion.div 
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.02 }}
                key={l.id || l.username}
                className="glass-card p-4 flex items-center justify-between border-white/5 bg-white/5"
              >
                <div className="flex items-center gap-4">
                  <span className="text-[10px] font-black text-neutral-500 w-6">#{i + 4}</span>
                  <div className="w-10 h-10 rounded-full border border-white/10 overflow-hidden bg-neutral-900">
                    {l.photo_url ? <img src={l.photo_url} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-xs font-bold">{l.username?.[0]?.toUpperCase()}</div>}
                  </div>
                  <div>
                    <p className="font-bold text-sm text-white">@{l.username}</p>
                    <p className="text-[10px] text-neutral-500 lowercase">Verified Player</p>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-sm font-mono font-black text-white">{getMetric(l)}</span>
                </div>
              </motion.div>
            ))}
          </div>

          {/* Sticky User Rank */}
          {userRank > 0 && (
            <div className="fixed bottom-24 left-1/2 -translate-x-1/2 w-full max-w-sm px-4 pointer-events-none">
               <div className="glass-card p-4 bg-yellow-500 text-black border-none flex items-center justify-between shadow-2xl pointer-events-auto">
                 <div className="flex items-center gap-3">
                   <span className="text-xs font-black">#{userRank}</span>
                   <div className="w-8 h-8 rounded-full overflow-hidden border-2 border-black/20">
                     {user.photo_url ? <img src={user.photo_url} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center font-bold text-xs">{user.username?.[0]?.toUpperCase()}</div>}
                   </div>
                   <p className="font-black text-xs">@{user.username} (You)</p>
                 </div>
                 <span className="font-mono font-black text-xs">
                   {sortBy === 'multiplier' ? `+${Math.floor(user.multiplier * 3600)}/h` : user.airdropRank.toLocaleString()}
                 </span>
               </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const WalletTab = () => {
  return (
    <div className="px-6 flex flex-col items-center justify-center min-h-[60vh] text-center max-w-sm mx-auto">
      <div className="w-20 h-20 bg-blue-500/10 rounded-3xl flex items-center justify-center mb-6 border border-blue-500/20">
         <WalletIcon className="w-10 h-10 text-blue-500" />
      </div>
      <h2 className="text-3xl font-black leading-tight">Connect TON Wallet</h2>
      <p className="text-sm text-neutral-500 mt-4 mb-8">Secure your allocation for the upcoming GLD Airdrop by connecting your wallet.</p>
      
      <div className="w-full flex justify-center">
        <TonConnectButton />
      </div>
    </div>
  );
};

// --- Main App ---

export default function App() {
  const [activeTab, setActiveTab] = useState('home');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [referralCount, setReferralCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);

  const syncBalance = async (newBalance: number, newEnergy: number) => {
    try {
      await fetch('/api/user/sync-balance', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-telegram-init-data': window.Telegram?.WebApp?.initData || ''
        },
        body: JSON.stringify({ telegramId: user?.id, balance: newBalance, energy: newEnergy })
      });
    } catch (err) {
      console.error("Critical Sync Error:", err);
    }
  };

  useEffect(() => {
    // Initial Sync
    const sync = async () => {
      try {
        const tg = window.Telegram?.WebApp;
        if (tg) tg.ready();

        const tgUser = tg?.initDataUnsafe?.user;
        const telegramId = tgUser?.id?.toString() || '12345';
        const username = tgUser?.username || 'mockuser';
        const first_name = tgUser?.first_name || 'Mock';
        const photo_url = tgUser?.photo_url || null;
        
        const startParam = tg?.initDataUnsafe?.start_param; 
        
        const res = await fetch('/api/user/sync', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-telegram-init-data': tg?.initData || ''
          },
          body: JSON.stringify({
            telegramId,
            username,
            first_name,
            photo_url,
            referred_by: startParam 
          })
        });
        
        const data = await res.json();
        
        if (!data || data.error) {
          console.warn("Sync warning:", data?.error || "Empty data");
          // Fallback user to prevent app block
          const fallbackUser: UserProfile = {
            id: telegramId,
            username: username || 'Guest',
            first_name: first_name || 'Guest',
            photo_url: photo_url || null,
            airdropRank: 0,
            balance: 0,
            multiplier: 0.1,
            energy: 1000,
            v1_synced: false,
            last_claim_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            daily_quest_states: {}
          };
          setUser(fallbackUser);
          if (data?.error) {
            setErrorDetails(data.message || data.error);
          }
        } else if (data.id) {
          setUser(data);
        } else if (data.user) {
          setUser(data.user);
          setReferralCount(data.referralCount || 0);
        } else {
          setUser(data);
        }
      } catch (err: any) {
        console.error('Sync Fatal Error:', err.message);
        // Ensure user can still see the app if possible
        const localUser: UserProfile = {
          id: telegramId,
          username: username || 'Guest',
          first_name: first_name || 'Guest',
          photo_url: photo_url || null,
          airdropRank: 0,
          balance: 0,
          multiplier: 0.1,
          energy: 1000,
          v1_synced: false,
          last_claim_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          daily_quest_states: {}
        };
        setUser(localUser);
        setErrorDetails("Connection was interrupted, using local profile.");
      } finally {
        setLoading(false);
      }
    };

    sync();
  }, []);

  if (loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[#0f172a]">
        <div className="text-center space-y-4">
          <div className="w-16 h-16 border-4 border-[#facc15] border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs uppercase font-black tracking-[0.3em] font-mono gold-gradient">Sychronizing GLD Network...</p>
        </div>
      </div>
    );
  }

  return (
    <TonConnectUIProvider manifestUrl={`${window.location.origin}/tonconnect-manifest.json`}>
      <div className="min-h-screen bg-[#0f172a] pb-32">
        <Header user={user} setActiveTab={setActiveTab} />
        
        <main className="pt-24 min-h-screen max-w-lg mx-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              {activeTab === 'home' && user && <HomeTab user={user} setUser={setUser} syncBalance={syncBalance} />}
              {activeTab === 'developers' && user && <DevelopersTab user={user} setUser={setUser} syncBalance={syncBalance} />}
              {activeTab === 'missions' && user && <MissionsTab user={user} referralCount={referralCount} setUser={setUser} />}
              {activeTab === 'ranking' && user && <RankingTab user={user} />}
              {activeTab === 'wallet' && <WalletTab />}
              {activeTab === 'profile' && user && <ProfilePage user={user} referralCount={referralCount} setUser={setUser} errorDetails={errorDetails} />}
            </motion.div>
          </AnimatePresence>
        </main>

        <Navbar activeTab={activeTab} setActiveTab={setActiveTab} />
      </div>
    </TonConnectUIProvider>
  );
}
