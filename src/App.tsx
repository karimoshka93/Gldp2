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
  Plus
} from 'lucide-react';
import { cn } from './lib/utils';
import { UserProfile, DeveloperCard, Mission } from './types';

// --- Components ---

const Navbar = ({ activeTab, setActiveTab }: { activeTab: string, setActiveTab: (t: string) => void }) => {
  const tabs = [
    { id: 'home', icon: HomeIcon, label: 'Home' },
    { id: 'developers', icon: Users, label: 'Devs' },
    { id: 'games', icon: Gamepad2, label: 'Soon', disabled: true },
    { id: 'combat', icon: Sword, label: 'Soon', disabled: true },
    { id: 'missions', icon: Target, label: 'Quests' },
    { id: 'wallet', icon: WalletIcon, label: 'Wallet' },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 h-20 bg-[#1e293b]/90 backdrop-blur-2xl border-t border-[#334155] flex items-center justify-around px-2 z-50">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => !tab.disabled && setActiveTab(tab.id)}
          className={cn(
            "tab-item group relative",
            activeTab === tab.id ? "text-[#facc15]" : "text-[#94a3b8]",
            tab.disabled && "opacity-30 cursor-not-allowed"
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

const Header = ({ user }: { user: UserProfile | null }) => (
  <header className="fixed top-0 left-0 right-0 px-6 pt-10 pb-4 bg-[#0f172a]/80 backdrop-blur-md z-40 flex items-center justify-between border-b border-[#334155]">
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-full bg-[#8b5cf6] flex items-center justify-center font-bold text-white shadow-lg border border-[#334155]">
        {user?.username?.[0]?.toUpperCase() || 'G'}
      </div>
      <div>
        <p className="text-[10px] text-[#94a3b8] uppercase font-bold tracking-[0.2em]">Collector</p>
        <p className="text-sm font-bold">@{user?.username || 'Guest'}</p>
      </div>
    </div>
    <div className="flex items-center gap-2 px-3 py-1.5 glass-card">
      <Trophy className="w-3.5 h-3.5 text-[#facc15]" />
      <span className="text-xs font-mono font-bold tracking-tight">{(user?.airdrop_rank ?? 0).toLocaleString()}</span>
    </div>
  </header>
);

const HomeTab = ({ user, setUser }: { user: UserProfile, setUser: (u: UserProfile) => void }) => {
  const [tapValue, setTapValue] = useState(user.balance);
  const [floatingTexts, setFloatingTexts] = useState<{ id: number, x: number, y: number }[]>([]);
  const tapRef = useRef<number>(0);
  
  // Real-time counter for passive income
  useEffect(() => {
    const interval = setInterval(() => {
      setTapValue(prev => prev + (user.active_multiplier / 10));
    }, 100);
    return () => clearInterval(interval);
  }, [user.active_multiplier]);

  const handleTap = (e: React.MouseEvent | React.TouchEvent) => {
    const x = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const y = 'touches' in e ? e.touches[0].clientY : e.clientY;
    
    setTapValue(prev => prev + 1);
    setFloatingTexts(prev => [...prev, { id: Date.now(), x, y }]);
    
    // Simulate energy drain
    if (user.energy > 0) {
      setUser({ ...user, balance: user.balance + 1, energy: user.energy - 1 });
    }
    
    // Cleanup floating texts
    setTimeout(() => {
      setFloatingTexts(prev => prev.filter(t => t.id !== Date.now()));
    }, 1000);
  };

  const handleClaim = async () => {
    try {
      const res = await fetch('/api/user/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramId: user.id })
      });
      const data = await res.json();
      if (data.user) {
        setUser(data.user);
        setTapValue(data.user.balance);
        alert(`Claimed ${data.earned} GLDp!`);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const nextClaimTime = new Date(new Date(user.last_claim_at).getTime() + 4 * 60 * 60 * 1000);
  const isClaimReady = new Date() >= nextClaimTime;

  return (
    <div className="flex flex-col items-center gap-8 pt-6">
      {/* Balance Display */}
      <motion.div 
        key={Math.floor(tapValue ?? 0)}
        initial={{ scale: 0.95 }}
        animate={{ scale: 1 }}
        className="text-center"
      >
        <div className="flex items-center justify-center gap-3">
          <img src="https://picsum.photos/seed/gold/100/100" className="w-12 h-12 rounded-full border-2 border-yellow-500/30" alt="GLD" referrerPolicy="no-referrer" />
          <h1 className="text-5xl font-black gold-gradient font-sans tracking-tight">
            {Math.floor(tapValue ?? 0).toLocaleString()}
          </h1>
        </div>
        <p className="text-[11px] text-[#94a3b8] mt-2 uppercase tracking-[0.2em] font-bold">GLD Points Balance</p>
      </motion.div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-3 w-full max-w-sm px-6">
        <div className="glass-card p-4 flex flex-col gap-1">
          <div className="flex items-center gap-2 opacity-100">
            <TrendingUp className="w-3 h-3 text-[#94a3b8]" />
            <span className="text-[10px] uppercase font-bold text-[#94a3b8]">Passive Income</span>
          </div>
          <p className="text-base font-bold text-[#facc15]">+{Math.floor(user.active_multiplier * 3600)} / hr</p>
        </div>
        <div className="glass-card p-4 flex flex-col gap-1">
          <div className="flex items-center gap-2 opacity-100">
            <Plus className="w-3 h-3 text-[#94a3b8]" />
            <span className="text-[10px] uppercase font-bold text-[#94a3b8]">Per Tap</span>
          </div>
          <p className="text-base font-bold text-[#facc15]">x1.0</p>
        </div>
      </div>

      {/* Main Tap Button */}
      <div className="relative mt-8">
        <AnimatePresence>
          {floatingTexts.map(text => (
            <motion.div
              key={text.id}
              initial={{ y: text.y - 120, x: text.x - 20, opacity: 1, scale: 1 }}
              animate={{ y: text.y - 200, opacity: 0, scale: 1.5 }}
              exit={{ opacity: 0 }}
              className="fixed pointer-events-none text-2xl font-black text-[#facc15] z-50 select-none drop-shadow-[0_0_10px_rgba(250,204,21,0.5)]"
            >
              +1
            </motion.div>
          ))}
        </AnimatePresence>
        
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={handleTap}
          onTouchStart={handleTap}
          className="w-64 h-64 rounded-full relative group cursor-pointer accent-glow"
        >
          {/* Outer Ring */}
          <div className="absolute inset-0 rounded-full border-[10px] border-[#a16207] transition-colors" />
          {/* Inner Circle */}
          <div className="absolute inset-3 rounded-full bg-[radial-gradient(circle,_#fde047_0%,_#ca8a04_100%)] flex items-center justify-center overflow-hidden shadow-[inset_0_0_20px_rgba(255,255,255,0.5)]">
             <span className="text-[100px] font-black text-[#713f12] select-none drop-shadow-[0_2px_0_rgba(255,255,255,0.3)]">G</span>
             <div className="absolute inset-0 bg-white/5 opacity-0 group-active:opacity-100 transition-opacity" />
          </div>
        </motion.button>
      </div>

      {/* Energy Display from Design */}
      <div className="w-full max-w-sm px-6">
        <div className="w-full h-3 bg-[#1e293b] rounded-full overflow-hidden">
          <motion.div 
            initial={{ width: 0 }}
            animate={{ width: `${(user.energy / 1000) * 100}%` }}
            className="h-full bg-gradient-to-r from-[#facc15] to-[#fbbf24]" 
          />
        </div>
        <div className="flex justify-between mt-2 font-bold uppercase tracking-wider">
          <span className="text-[10px] text-[#94a3b8] flex items-center gap-1">
            <Zap className="w-2.5 h-2.5 text-[#facc15]" />
            Energy
          </span>
          <span className="text-[11px]">{user.energy} / 1000</span>
        </div>
      </div>

      {/* Passive Income Claim */}
      <div className="w-full max-w-sm px-6 mt-2">
        <button 
          onClick={handleClaim}
          disabled={!isClaimReady}
          className={cn(
            "w-full py-4 rounded-xl flex items-center justify-between px-6 transition-all border",
            isClaimReady 
              ? "gold-bg text-[#713f12] font-black accent-glow scale-105" 
              : "bg-[#1e293b] text-[#94a3b8] border-[#334155]"
          )}
        >
          <div className="flex items-center gap-3">
            <Clock className="w-5 h-5 text-[#94a3b8]" />
            <div className="text-left">
              <p className="text-[11px] uppercase tracking-wider font-bold">Accumulated Income</p>
              <p className="text-[10px] opacity-70">Next claim in: {isClaimReady ? 'READY' : '03h 42m'}</p>
            </div>
          </div>
          <span className="text-lg font-bold">
             {isClaimReady ? 'CLAIM' : <ChevronRight className="w-5 h-5 opacity-30" />}
          </span>
        </button>
      </div>
    </div>
  );
};

const DevelopersTab = ({ user, setUser }: { user: UserProfile, setUser: (u: UserProfile) => void }) => {
  const devs: DeveloperCard[] = Array.from({ length: 30 }, (_, i) => ({
    id: `dev-${i+1}`,
    name: `Senior Dev #${i + 1}`,
    description: `Optimizes neural tap algorithm level ${i + 1}`,
    base_cost: (i + 1) * 1000,
    base_boost: (i + 1) * 0.05,
    image_url: `https://picsum.photos/seed/dev${i}/200/200`
  }));

  const handleUpgrade = async (dev: DeveloperCard) => {
    try {
      const res = await fetch('/api/user/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        alert(`Upgraded ${dev.name}! New rate: +${data.active_multiplier.toFixed(2)}/s`);
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
        <h2 className="text-2xl font-black gold-gradient uppercase">The Dev Dungeon</h2>
        <p className="text-xs text-neutral-500 uppercase font-bold tracking-widest mt-1">Hire specialists to increase passive profit</p>
      </div>
      
      {devs.map((dev) => (
        <div key={dev.id} className="glass-card p-4 flex items-center justify-between group hov:bg-white/[0.05] transition-colors">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl overflow-hidden border border-white/10 shrink-0">
               <img src={dev.image_url} className="w-full h-full object-cover" alt={dev.name} referrerPolicy="no-referrer" />
            </div>
            <div>
              <p className="font-bold text-sm">{dev.name}</p>
              <p className="text-[10px] text-neutral-500 line-clamp-1">{dev.description}</p>
              <div className="flex items-center gap-2 mt-1">
                <TrendingUp className="w-3 h-3 text-green-500" />
                <span className="text-[10px] font-mono text-green-500">+{dev.base_boost}/s</span>
              </div>
            </div>
          </div>
          <button 
            onClick={() => handleUpgrade(dev)}
            className="flex flex-col items-center gap-1 group/btn"
          >
            <div className="px-3 py-1.5 rounded-lg border border-yellow-500/30 group-hover/btn:bg-yellow-500 group-hover/btn:text-black transition-all">
              <span className="text-xs font-mono font-bold">{dev.base_cost.toLocaleString()}</span>
            </div>
            <span className="text-[8px] uppercase font-black text-neutral-500">Upgrade</span>
          </button>
        </div>
      ))}
    </div>
  );
};

const MissionsTab = ({ user }: { user: UserProfile }) => {
  const missions: Mission[] = [
    { id: '1', title: 'Join our Telegram Channel', reward: 5000, points: 10, type: 'social' },
    { id: '2', title: 'Follow us on X', reward: 5000, points: 10, type: 'social' },
    { id: '3', title: 'Daily Login Reward', reward: 1000, points: 5, type: 'daily' },
    { id: '4', title: 'Watch Ads (5/5)', reward: 2500, points: 15, type: 'daily' },
  ];

  return (
    <div className="px-6 pb-24 space-y-4 pt-6">
      <h2 className="text-2xl font-black gold-gradient uppercase">GLD Quests</h2>
      <p className="text-xs text-neutral-500 uppercase font-bold tracking-widest">Complete tasks to climb the Airdrop Rank</p>
      
      <div className="space-y-3">
        {missions.map(m => (
          <div key={m.id} className="glass-card p-5 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-neutral-900 rounded-xl">
                 {m.type === 'daily' ? <Clock className="w-5 h-5 text-blue-400" /> : <Target className="w-5 h-5 text-purple-400" />}
              </div>
              <div>
                <p className="text-sm font-bold">{m.title}</p>
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-[10px] font-mono text-yellow-500">+{m.reward.toLocaleString()} GLDp</span>
                  <span className="text-[10px] font-mono text-purple-400">+{m.points} Points</span>
                </div>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 opacity-20" />
          </div>
        ))}
      </div>
    </div>
  );
};

const LeaderboardTab = () => {
  const [leaders, setLeaders] = useState<any[]>([]);

  useEffect(() => {
    fetch('/api/leaderboard').then(r => r.json()).then(setLeaders);
  }, []);

  return (
    <div className="px-6 pb-24 pt-6">
      <h2 className="text-2xl font-black gold-gradient uppercase">World Elite</h2>
      <p className="text-xs text-neutral-500 uppercase font-bold tracking-widest mt-1">Top 200 ranking by activity points</p>
      
      <div className="mt-6 space-y-2">
        {leaders.map((l, i) => (
          <div key={l.id} className={cn(
            "p-4 rounded-xl flex items-center justify-between border",
            i < 3 ? "bg-yellow-500/5 border-yellow-500/20" : "glass-card border-transparent"
          )}>
            <div className="flex items-center gap-4">
              <span className={cn(
                "w-6 text-xs font-mono font-bold text-center",
                i === 0 && "text-yellow-400",
                i === 1 && "text-neutral-300",
                i === 2 && "text-orange-400"
              )}>{i + 1}</span>
              <div className="w-8 h-8 rounded-full bg-neutral-800 flex items-center justify-center text-[10px] font-bold">
                {l.username?.[0]?.toUpperCase() || 'U'}
              </div>
              <p className="text-sm font-medium">@{l.username || 'Anonymous'}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold">{(l.airdrop_rank ?? 0).toLocaleString()}</span>
              <Trophy className="w-3 h-3 text-yellow-500/50" />
            </div>
          </div>
        ))}
        {leaders.length === 0 && <p className="text-center py-10 opacity-30 italic">No data yet...</p>}
      </div>
    </div>
  );
};

const WalletTab = () => {
  return (
    <div className="px-6 flex flex-col items-center justify-center min-h-[60vh] text-center max-w-sm mx-auto">
      <div className="w-20 h-20 bg-blue-500/10 rounded-3xl flex items-center justify-center mb-6 border border-blue-500/20">
         <WalletIcon className="w-10 h-10 text-blue-500" />
      </div>
      <h2 className="text-3xl font-black leading-tight">TON Integration Coming Soon</h2>
      <p className="text-sm text-neutral-500 mt-4">Connect your TON Wallet to secure your allocation and participate in the upcoming GLD Airdrop event.</p>
      
      <button className="mt-10 px-8 py-4 bg-white text-black font-black rounded-2xl w-full flex items-center justify-center gap-3 active:scale-95 transition-all">
         TON CONNECT
         <ExternalLink className="w-4 h-4" />
      </button>
    </div>
  );
};

// --- Main App ---

export default function App() {
  const [activeTab, setActiveTab] = useState('home');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);

  useEffect(() => {
    // Initial Sync
    const sync = async () => {
      try {
        const tg = window.Telegram?.WebApp;
        if (tg) tg.ready();

        const tgUser = tg?.initDataUnsafe?.user;
        const telegramId = tgUser?.id?.toString() || '12345'; // Fallback for safety
        const username = tgUser?.username || 'mockuser';
        const first_name = tgUser?.first_name || 'Mock';

        const res = await fetch('/api/user/sync', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-telegram-init-data': tg?.initData || ''
          },
          body: JSON.stringify({
            telegramId,
            username,
            first_name
          })
        });
        
        const data = await res.json();
        
        if (data.error) {
          if (data.error === 'MISSING_TABLE') {
            setErrorDetails(data.message);
          } else {
            setErrorDetails(data.message || data.error);
          }
          throw new Error(data.message || data.error);
        }
        
        setUser(data);
      } catch (err: any) {
        const errorMsg = err.message || JSON.stringify(err);
        console.error('Sync Error:', errorMsg);
        if (!errorDetails) setErrorDetails(errorMsg);
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

  if (!user) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[#0f172a] px-10 text-center">
        <div className="space-y-6 max-w-sm">
          <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mx-auto border border-red-500/20">
             <Target className="w-10 h-10 text-red-500" />
          </div>
          <h2 className="text-2xl font-black">Sync Required</h2>
          <p className="text-sm text-[#94a3b8]">{errorDetails || "We couldn't synchronize your profile. Please check your Supabase configuration."}</p>
          <button 
            onClick={() => window.location.reload()}
            className="w-full py-4 bg-white text-black font-black rounded-xl active:scale-95 transition-all"
          >
            RETRY SYNC
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0f172a] pb-32">
      <Header user={user} />
      
      <main className="pt-24 min-h-screen max-w-lg mx-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            {activeTab === 'home' && user && <HomeTab user={user} setUser={setUser} />}
            {activeTab === 'developers' && user && <DevelopersTab user={user} setUser={setUser} />}
            {activeTab === 'missions' && user && <MissionsTab user={user} />}
            {activeTab === 'leaderboard' && <LeaderboardTab />}
            {activeTab === 'wallet' && <WalletTab />}
          </motion.div>
        </AnimatePresence>
      </main>

      <Navbar activeTab={activeTab} setActiveTab={setActiveTab} />
    </div>
  );
}
