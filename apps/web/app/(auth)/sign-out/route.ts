// POST /sign-out: ends the session and goes to sign-in. POST only, so a link or prefetch
// cannot sign someone out.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  // Local scope: clears this browser's session even when the sign-in service is unreachable.
  await supabase.auth.signOut({ scope: "local" });
  const res = NextResponse.redirect(new URL("/sign-in", request.url), 303);
  res.headers.set("cache-control", "private, no-store");
  return res;
}
