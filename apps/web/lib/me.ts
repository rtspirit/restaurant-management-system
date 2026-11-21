// What GET /auth/me returns. Mirrors `MeResponse` in apps/api/src/routes/auth.ts.
// TODO(lead): move this shape into @rms/contracts so both sides share one definition.
import type { Role } from "@rms/contracts";

export type MyRestaurant = {
  id: string;
  name: string;
  role: Role;
  brandColour: string | null;
  locations: { id: string; name: string }[];
  ready: boolean;
};

export type Me = {
  user: { id: string; email: string | null };
  restaurant: MyRestaurant | null;
};

/** The API's address. NEXT_PUBLIC_API_URL is inlined at build time, so read it by its literal name. */
export const apiUrl = (): string => {
  const url = process.env.NEXT_PUBLIC_API_URL;
  if (!url) throw new Error("NEXT_PUBLIC_API_URL is not set");
  return url.replace(/\/$/, "");
};

/** Calls GET /auth/me with a Supabase access token. Returns null when the token is refused. */
export async function fetchMe(accessToken: string): Promise<Me | null> {
  const res = await fetch(`${apiUrl()}/auth/me`, { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Could not load the signed-in user (status ${res.status})`);
  return (await res.json()) as Me;
}
