// What the RMS shell needs to draw itself.
//
// STUB: `loadShellData` returns seeded, fictional content. Task A's `GET /auth/me` replaces
// the body of this function (user, restaurant name, role, locations, brand colour). Nothing
// else in the shell needs to change when it does: keep the `ShellData` shape.

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
  userName: string;
  userInitials: string;
  role: "owner" | "staff";
  miniApps: MiniAppSummary[];
};

/** Seeded demo restaurant. Fictional. */
export const MARIGOLD_KITCHEN: ShellData = {
  restaurantName: "Marigold Kitchen",
  locations: [
    { id: "downtown", name: "Downtown" },
    { id: "riverside", name: "Riverside" },
  ],
  brandColour: null,
  userName: "Asha Verma",
  userInitials: "AV",
  role: "owner",
  miniApps: [],
};

/** Seeded demo restaurant. Fictional. Used in the gallery to show a second brand colour. */
export const SLICE_YARD: ShellData = {
  restaurantName: "Slice Yard",
  locations: [{ id: "main", name: "Main Street" }],
  brandColour: "#C8372D",
  userName: "Theo Marsh",
  userInitials: "TM",
  role: "owner",
  miniApps: [],
};

// STUB: replace with the signed-in user's data from `GET /auth/me` (task A).
export async function loadShellData(): Promise<ShellData> {
  return MARIGOLD_KITCHEN;
}
