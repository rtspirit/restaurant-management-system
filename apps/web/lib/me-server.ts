// Server-side loader for the shell (task E replaces its stub with this).
// Use from Server Components only.
import type { MeResponse } from "@rms/contracts";
import { fetchMe } from "./me";
import { createClient } from "./supabase/server";

/**
 * The signed-in user and their restaurant, or null when signed out. The access token comes
 * from the session cookie and is verified by the API, which decides who this is.
 * Null on a page behind sign-in means the API refused the session: render `SignOutNow` from
 * `@/lib/sign-out` rather than redirecting to /sign-in (the proxy would send the user back).
 */
export async function getMe(): Promise<MeResponse | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return fetchMe(token);
}
