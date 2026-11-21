// Browser-side calls to the RMS API, with the signed-in user's access token.
import { apiUrl } from "./me";
import { createClient } from "./supabase/client";

export class SignedOutError extends Error {
  constructor() {
    super("signed_out");
  }
}

/** fetch() to the API as the signed-in user. Throws SignedOutError when there is no session. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await createClient().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new SignedOutError();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(`${apiUrl()}${path}`, { ...init, headers, cache: "no-store" });
  if (res.status === 401) throw new SignedOutError();
  return res;
}
