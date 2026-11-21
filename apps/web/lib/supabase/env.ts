// Browser-safe sign-in settings. NEXT_PUBLIC_ values are inlined at build time, so they must be
// read with these literal names. Read lazily so pages can be prerendered without them.
export const supabaseEnv = (): { url: string; key: string } => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Sign-in is not configured (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)");
  return { url, key };
};
