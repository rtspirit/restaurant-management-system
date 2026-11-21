"use client";
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AUTH_COOKIE_NAME, supabaseEnv } from "./config";

let client: SupabaseClient | undefined;

/** The browser sign-in client. Created on first use, never during server rendering. */
export const supabaseBrowser = (): SupabaseClient => {
  if (client) return client;
  const env = supabaseEnv();
  if (!env) throw new Error("The console is missing its sign-in settings.");
  client = createBrowserClient(env.url, env.key, { cookieOptions: { name: AUTH_COOKIE_NAME } });
  return client;
};
