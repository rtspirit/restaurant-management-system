// Each owner sees their own restaurant's locations, menu and staff, and never the other's.
// Figures are the run-book's (docs/runbook.md 3.2), worked out from the seed.
import { STATE, WEB } from "../helpers/env.js";
import { expectCleanScreen } from "../helpers/page-checks.js";
import { open } from "../helpers/session.js";
import { expect, test } from "../fixtures.js";

type Restaurant = {
  name: string;
  state: string;
  menu: { summary: string; groups: string[]; dishes: string[] };
  staff: { summary: string; people: string[] };
  places: { name: string; address: string; seats: string }[];
  /** Words that belong only to the OTHER restaurant. None may show anywhere here. */
  foreign: string[];
};

const MARIGOLD: Restaurant = {
  name: "Marigold Kitchen",
  state: STATE.marigoldOwner,
  menu: {
    summary: "40 items in 6 groups",
    groups: ["Starters", "Mains", "Sides", "Desserts", "Soft Drinks and Coffee", "Bar"],
    dishes: ["Hanger Steak Frites", "$36.00", "Marigold Burger", "$22.00", "Marigold Spritz", "$14.00"],
  },
  staff: { summary: "24 people at 2 locations", people: ["Priya Castellano", "Dario Lindqvist", "Owen Feldhaus"] },
  places: [
    { name: "Downtown", address: "118 Larkspur Street", seats: "110 seats" },
    { name: "Riverside", address: "42 Wharf Road", seats: "72 seats" },
  ],
  foreign: ["Slice Yard", "Mill Street", "Gianna Holloway", "Pizzas"],
};

const SLICE_YARD: Restaurant = {
  name: "Slice Yard",
  state: STATE.sliceYardOwner,
  menu: { summary: "20 items in 4 groups", groups: ["Pizzas", "Sides and Salads", "Drinks", "Desserts"], dishes: [] },
  staff: { summary: "9 people at 1 location", people: ["Gianna Holloway"] },
  places: [{ name: "Mill Street", address: "305 Mill Street", seats: "28 seats" }],
  foreign: ["Marigold", "Downtown", "Riverside", "Larkspur", "Wharf Road", "Priya Castellano", "Hanger Steak"],
};

for (const r of [MARIGOLD, SLICE_YARD]) {
  test.describe(`${r.name} owner`, () => {
    test.use({ storageState: r.state });

    const noForeign = (text: string) => {
      const seen = r.foreign.filter((w) => text.toLowerCase().includes(w.toLowerCase()));
      expect(seen, `${r.name}'s owner can see the other restaurant's words`).toEqual([]);
    };

    test("Home names the restaurant and nothing of the other one", async ({ page }) => {
      const text = await open(page, `${WEB}/`);
      expect(text).toContain("Hello");
      expect(text).toContain(r.name);
      noForeign(text);
      await expectCleanScreen(page);
    });

    test("Menu shows its own groups and prices", async ({ page }) => {
      const text = await open(page, `${WEB}/menu`);
      expect(text).toContain(r.menu.summary);
      for (const w of [...r.menu.groups, ...r.menu.dishes]) expect(text).toContain(w);
      noForeign(text);
      await expectCleanScreen(page);
    });

    test("Staff shows its own team with pay and contact details", async ({ page }) => {
      const text = await open(page, `${WEB}/staff`);
      expect(text).toContain(r.staff.summary);
      for (const p of r.staff.people) expect(text).toContain(p);
      expect(text).toContain("Hourly rate");
      expect(text).toContain("Email");
      noForeign(text);
      await expectCleanScreen(page);
    });

    test("Locations shows its own places, hours and when the day ends", async ({ page }) => {
      const text = await open(page, `${WEB}/locations`);
      for (const p of r.places) {
        expect(text).toContain(p.name);
        expect(text).toContain(p.address);
        expect(text).toContain(p.seats);
      }
      expect(text).toContain("Opening hours");
      expect(text).toContain("Day ends at");
      noForeign(text);
      await expectCleanScreen(page);
    });

    test("the location switcher lists only its own locations", async ({ page }) => {
      await open(page, `${WEB}/`);
      const switcher = page.getByLabel("Location").locator("visible=true");
      if (r.places.length > 1) {
        const options = await switcher.first().locator("option").allInnerTexts();
        expect(options).toEqual(["All locations", ...r.places.map((p) => p.name)]);
      } else {
        await expect(switcher).toHaveCount(0);
      }
    });
  });
}

test("the two restaurants have their own brand colours", async ({ browser }) => {
  const colour = async (state: string) => {
    const context = await browser.newContext({ storageState: state });
    const page = await context.newPage();
    await open(page, `${WEB}/`);
    const style = (await page.locator(".rms-theme").first().getAttribute("style")) ?? "";
    await context.close();
    return style;
  };
  const marigold = await colour(STATE.marigoldOwner);
  const sliceYard = await colour(STATE.sliceYardOwner);
  expect(marigold).not.toBe("");
  expect(sliceYard).not.toBe("");
  expect(marigold).not.toBe(sliceYard);
});
