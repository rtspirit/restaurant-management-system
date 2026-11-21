// The console keeps its own sign-in cookie, separate from the restaurant web app. Both apps may
// run on the same host (localhost) where cookies are shared across ports, so the name differs.
export const AUTH_COOKIE_NAME = "rms-admin-auth";

export const supabaseEnv = (): { url: string; key: string } | null => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return url && key ? { url, key } : null;
};
