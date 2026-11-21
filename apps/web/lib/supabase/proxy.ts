// Session refresh for proxy.ts (pattern: vercel/next.js examples/with-supabase,
// lib/supabase/proxy.ts; verified-apis.md section 5). Also sends signed-out visitors to sign-in.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseEnv } from "./env";

/** Pages anyone may open without signing in. */
const PUBLIC_PATHS = ["/sign-in", "/sign-up", "/gallery"];
/** Pages a signed-in person has no reason to see. */
const SIGNED_OUT_ONLY = ["/sign-in", "/sign-up"];

const matches = (path: string, list: string[]) => list.some((p) => path === p || path.startsWith(`${p}/`));

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });
  let cacheHeaders: Record<string, string> = {};
  const { url, key } = supabaseEnv();

  // A new client per request (Fluid compute): never keep it in a global.
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => supabaseResponse.cookies.set(name, value, options));
        // Responses that set auth cookies must never be cached for another person. A later
        // call may pass no headers, so merge rather than replace, and apply all of them to
        // the new response.
        cacheHeaders = { ...cacheHeaders, ...headers };
        Object.entries(cacheHeaders).forEach(([k, v]) => supabaseResponse.headers.set(k, v));
      },
    },
  });

  // Do not run code between createServerClient and getClaims() (Supabase guidance).
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims);
  const path = request.nextUrl.pathname;

  const redirect = (to: string) => {
    const target = request.nextUrl.clone();
    target.pathname = to;
    target.search = "";
    const res = NextResponse.redirect(target);
    // Keep any refreshed session cookies, or the browser and server fall out of sync.
    supabaseResponse.cookies.getAll().forEach((c) => res.cookies.set(c));
    Object.entries(cacheHeaders).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  };

  if (!signedIn && !matches(path, PUBLIC_PATHS)) return redirect("/sign-in");
  if (signedIn && matches(path, SIGNED_OUT_ONLY)) return redirect("/");

  return supabaseResponse;
}
