export interface UserProfile {
  id: string; 
  username?: string;
  first_name?: string;
  photo_url?: string | null;
  airdropRank: number; // Activity PointsFoundation
  balance: number; 
  multiplier: number; // Passive income per second
  energy: number;
  referred_by?: string;
  last_claim_at: string;
  last_energy_reset_at?: string;
  daily_quest_states: Record<string, any>;
  code_task_states: Record<string, any>;
  v1_synced?: boolean;
  updated_at: string;
  created_at: string;
}

export interface DeveloperCard {
  id: string;
  name: string;
  description: string;
  base_cost: number;
  base_boost: number;
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
