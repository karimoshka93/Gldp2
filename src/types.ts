export interface UserProfile {
  id: string; 
  username?: string;
  first_name?: string;
  photo_url?: string | null;
  airdropRank: number; 
  balance: number; 
  multiplier: number; 
  energy: number;
  tap_value?: number;
  daily_taps?: number;
  referred_by?: string;
  last_claim_at: string;
  daily_quest_states: Record<string, any>;
  completed_missions: string[];
  upgrades: Record<string, any>;
  updated_at: string;
  created_at: string;
  
  // Combat System
  hero_class?: 'Warrior' | 'Archer' | 'Mage';
  hero_level: number;
  hero_attack: number;
  hero_defense: number;
  hero_health: number;
  arena_tier?: string;
  arena_tier_level?: number;
  arena_stars?: number;
  arena_wins?: number;
  arena_losses?: number;
  arena_score?: number;
  activity_points: number;
  combat_matches_free: number;
  combat_matches_ads: number;
  combat_daily_ads_watched?: number;
  combat_last_reset?: string;
}

export interface BattleRound {
  attacker_hp: number;
  defender_hp: number;
  attacker_damage: number;
  defender_damage: number;
  event_msg: string;
}

export interface BattleResult {
  winner_id: string;
  rounds: BattleRound[];
  reward_gldp: number;
  reward_points: number;
  star_change: number;
}

export interface DeveloperCard {
  id: string;
  name: string;
  description: string;
  base_cost: number;
  base_boost: number;
  multiplier_per_hour: number;
  image_url: string;
}

export interface Mission {
  id: string;
  title: string;
  reward: number;
  points: number;
  type: 'daily' | 'code' | 'social' | 'ads';
  link?: string;
}

declare global {
  interface Window {
    Telegram: {
      WebApp: any;
    };
  }
}
