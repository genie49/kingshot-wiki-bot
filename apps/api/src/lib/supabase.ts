import { createClient } from "@supabase/supabase-js";
import { config, requireConfig } from "../config.js";

function getSupabaseApiKey() {
  const key = config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_API_KEY;
  if (!key) {
    throw new Error("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY or SUPABASE_API_KEY");
  }
  return key;
}

export function createSupabaseServiceClient() {
  return createClient(
    requireConfig("SUPABASE_URL"),
    getSupabaseApiKey(),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );
}
