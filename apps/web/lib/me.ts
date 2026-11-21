// GET /auth/me. The shape is `MeResponse` from @rms/contracts, checked on arrival.
import { MeResponse } from "@rms/contracts";

/** The API's address. NEXT_PUBLIC_API_URL is inlined at build time, so read it by its literal name. */
export const apiUrl = (): string => {
  const url = process.env.NEXT_PUBLIC_API_URL;
  if (!url) throw new Error("NEXT_PUBLIC_API_URL is not set");
  return url.replace(/\/$/, "");
};

/** Parses a /auth/me response body. Throws if it is not the agreed shape. */
export const parseMe = (body: unknown): MeResponse => MeResponse.parse(body);

/** Calls GET /auth/me with a Supabase access token. Returns null when the token is refused. */
export async function fetchMe(accessToken: string): Promise<MeResponse | null> {
  const res = await fetch(`${apiUrl()}/auth/me`, { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Could not load the signed-in user (status ${res.status})`);
  return parseMe(await res.json());
}
