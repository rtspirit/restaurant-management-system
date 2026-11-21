// Server-side loader for the shell (task E replaces its stub with this).
// Use from Server Components only.
import { type Me, fetchMe } from "./me";
import { createClient } from "./supabase/server";

/**
 * The signed-in user and their restaurant, or null when signed out. The access token comes
 * from the session cookie and is verified by the API, which decides who this is.
 */
export async function getMe(): Promise<Me | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return fetchMe(token);
}
