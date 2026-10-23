import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readPublicConfig } from "./config";

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  const config = readPublicConfig();
  if (config == null) return null;
  if (cached == null) {
    cached = createClient(config.url, config.anonKey);
  }
  return cached;
}
