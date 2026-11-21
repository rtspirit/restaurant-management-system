// Supabase client for Client Components (pattern: vercel/next.js examples/with-supabase,
// lib/supabase/client.ts; docs/reference/verified-apis.md section 5).
import { createBrowserClient } from "@supabase/ssr";
import { supabaseEnv } from "./env";

export function createClient() {
  const { url, key } = supabaseEnv();
  return createBrowserClient(url, key);
}
