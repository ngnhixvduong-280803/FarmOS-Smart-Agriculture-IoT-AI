/// <reference types="vite/client" />
import { createClient } from "@supabase/supabase-js";

// Browser code consumes only Vite's explicitly public allowlist. API calls,
// including firmware administration, stay same-origin under /api and never receive a
// server URL or signing secret.
const supabaseUrl = (import.meta as any).env?.VITE_SUPABASE_URL || "";
const supabaseAnonKey = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || "";

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        // FarmOS exchanges the temporary provider token immediately for its own
        // HttpOnly same-origin session. Supabase tokens must not persist in browser
        // storage where injected JavaScript could read them.
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: true,
      },
    })
  : null;
