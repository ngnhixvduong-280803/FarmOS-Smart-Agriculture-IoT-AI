import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

const supabaseUrl = env.SUPABASE_URL || process.env.SUPABASE_URL || "https://ackztgtklxztnpqpebzg.supabase.co";
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "";

export let supabase: SupabaseClient | null = null;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  console.log("⚡ [SUPABASE] Backend Supabase Client initialized successfully.");
} else {
  console.warn("⚠️ [SUPABASE] Missing SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY. Supabase verification will fallback to local JWT verification.");
}

/**
 * Kiểm tra xem một email có thuộc danh sách ADMIN mặc định không
 */
export function isDefaultAdmin(email?: string | null): boolean {
  if (!email) return false;
  const adminEmails = env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase());
  return adminEmails.includes(email.toLowerCase());
}
