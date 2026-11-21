// What the RMS shell needs to draw itself, and where it comes from.
//
// The signed-in user and their restaurant come from `GET /auth/me` (task A's `getMe()`),
// which decides who this is from the session. Nothing here is read from the address,
// a form or a header. Server only: import the types from client files, not the loader.
import { cache } from "react";
import { redirect } from "next/navigation";
import type { Role } from "@rms/contracts";
import { getMe } from "@/lib/me-server";

export type ShellLocation = { id: string; name: string };

export type MiniAppSummary = {
  id: string;
  name: string;
  /** One plain sentence on what it is for. */
  summary: string;
  href: string;
};

export type ShellData = {
  restaurantName: string;
  locations: ShellLocation[];
  /** #RRGGBB, or null when the restaurant has not picked one. Made safe by themeFromBrand. */
  brandColour: string | null;
  /** A name to show, worked out from the email. Empty when there is nothing to go on. */
  userName: string;
  userInitials: string;
  role: Role;
  miniApps: MiniAppSummary[];
};

/**
 * A name from an email address: "asha.verma@marigold.test" becomes "Asha Verma".
 * RMS does not hold people's names yet, so this is the best it can say.
 */
export function nameFromEmail(email: string | null | undefined): { name: string; initials: string } {
  const local = (email ?? "").split("@")[0] ?? "";
  const words = local
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  const first = words[0];
  if (!first) return { name: "", initials: "" };
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  return { name: words.join(" "), initials: (first.charAt(0) + (last ? last.charAt(0) : first.charAt(1))).toUpperCase() };
}

export type ShellLoad =
  | { status: "ready"; data: ShellData }
  /** There is a session cookie but the API refused it. */
  | { status: "signed-out" }
  /** The API did not answer. Nothing is known about the session either way. */
  | { status: "unavailable" };

/**
 * Who is signed in and what the shell should show, for this request. One call to the API
 * however many layouts and pages ask (React `cache`).
 *
 * - signed-out: render `SignOutNow`. Do not redirect to sign-in: the proxy would send the
 *   browser straight back, and it would loop.
 * - A signed-in user with no restaurant yet is sent to the onboarding questions.
 */
export const loadShell = cache(async (): Promise<ShellLoad> => {
  let me: Awaited<ReturnType<typeof getMe>>;
  try {
    me = await getMe();
  } catch {
    // The reason stays on the server. The owner is told RMS is not answering.
    return { status: "unavailable" };
  }
  if (!me) return { status: "signed-out" };
  if (!me.restaurant) redirect("/onboarding");

  const { name, initials } = nameFromEmail(me.user.email);
  return {
    status: "ready",
    data: {
      restaurantName: me.restaurant.name,
      locations: me.restaurant.locations,
      brandColour: me.restaurant.brandColour,
      userName: name,
      userInitials: initials,
      role: me.restaurant.role,
      // Mini-apps arrive in a later wave.
      miniApps: [],
    },
  };
});

/** For pages inside the shell: the data, or null when the layout is showing something else. */
export async function loadShellData(): Promise<ShellData | null> {
  const load = await loadShell();
  return load.status === "ready" ? load.data : null;
}
