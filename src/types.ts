export interface UserProfile {
  id: string; // telegram_id
  username?: string;
  first_name?: string;
  balance: number; // GLDp
  active_multiplier: number; // Passive income per second
  airdrop_rank: number; // Activity Points
  energy: number;
  game_tickets: number;
  extra_combat_matches: number;
  combat_matches_today: number;
  last_claim_at: string;
  photo_url?: string | null;
  created_at: string;
  code_task_states: Record<string, any>;
  daily_quest_states: Record<string, any>;
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
  type: 'daily' | 'code' | 'social';
}

declare global {
  interface Window {
    Telegram: {
      WebApp: any;
    };
  }
}
