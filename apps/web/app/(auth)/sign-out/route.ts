// POST /sign-out: ends the session and goes to sign-in. POST only, so a link or prefetch
// cannot sign someone out.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const res = NextResponse.redirect(new URL("/sign-in", request.url), 303);
  res.headers.set("cache-control", "private, no-store");
  return res;
}
