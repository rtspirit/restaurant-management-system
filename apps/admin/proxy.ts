// Next.js 16 proxy (was middleware.ts). Keeps the maintainer's sign-in fresh and sends anyone
// signed out to /sign-in. Whether the person is a maintainer is checked by the API on every call.
import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
