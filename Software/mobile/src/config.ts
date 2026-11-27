import { publicConfig } from "./generated/config";

// Generated only from FARMOS_API_URL, FARMOS_WEB_URL, SUPABASE_URL, and
// SUPABASE_ANON_KEY in the repository-root .env. No server secret is exposed.
export const config = publicConfig;

export const isSupabaseConfigured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
