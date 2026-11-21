// POST /sign-out: ends the session and goes to sign-in. POST only, so a link or prefetch
// cannot sign someone out.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST() {
  const supabase = await createClient();
  // Local scope: clears this browser's session even when the sign-in service is unreachable.
  await supabase.auth.signOut({ scope: "local" });
  // A relative address: the server's own idea of its URL is its bind address (0.0.0.0 or
  // localhost), which a phone cannot open (ADR 0010). The browser resolves this against the
  // address it is actually on.
  return new NextResponse(null, { status: 303, headers: { location: "/sign-in", "cache-control": "private, no-store" } });
}
