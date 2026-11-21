// Builds the platform parent rows for one demo restaurant. Pure apart from new ids.
import { newUuid } from "@rms/db";
import { addDays } from "./rng.js";
import { type DemoTemplate, templateSpec } from "./templates.js";

type Row = Record<string, unknown>;

/** Rows per platform source table, in insert order (parents before children). */
export type ParentRows = {
  locations: Row[];
  restaurant_profiles: Row[];
  parent_jobs: Row[];
  parent_staff: Row[];
  parent_menu_categories: Row[];
  parent_menu_items: Row[];
  parent_menu_modifiers: Row[];
  parent_tax_rates: Row[];
  parent_licences: Row[];
  parent_equipment: Row[];
};

export const PARENT_SOURCE_TABLES = [
  "locations",
  "restaurant_profiles",
  "parent_jobs",
  "parent_staff",
  "parent_menu_categories",
  "parent_menu_items",
  "parent_menu_modifiers",
  "parent_tax_rates",
  "parent_licences",
  "parent_equipment",
] as const satisfies readonly (keyof ParentRows)[];

const emailLocal = (fullName: string): string =>
  fullName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z\s-]/g, "")
    .trim()
    .split(/\s+/)
    .join(".");

/**
 * The parent rows for one demo restaurant. Names, prices and dates are fixed; ids are new each time.
 * `today` (YYYY-MM-DD) sets licence expiry dates, so one licence always expires within 30 days.
 */
export const buildParentRows = (template: DemoTemplate, opts: { orgUuid: string; today: string }): ParentRows => {
  const spec = templateSpec(template);
  const org_id = opts.orgUuid;
  const need = <T>(map: Map<string, T>, key: string, what: string): T => {
    const v = map.get(key);
    if (v === undefined) throw new Error(`Seed data refers to an unknown ${what}: ${key}`);
    return v;
  };

  const locationIds = new Map(spec.locations.map((l) => [l.key, newUuid()]));
  const locations = spec.locations.map((l) => ({
    id: need(locationIds, l.key, "location"),
    org_id,
    name: l.name,
    address: l.address,
    timezone: "America/New_York",
    currency: "USD",
    day_cutoff: "04:00",
    seats: l.seats,
    hours: l.hours,
    status: "open",
  }));

  const restaurant_profiles = [
    {
      org_id,
      id: newUuid(),
      name: spec.name,
      concept: spec.profile.concept,
      cuisine: spec.profile.cuisine,
      service_style: spec.profile.serviceStyle,
      seats: spec.locations.reduce((a, l) => a + l.seats, 0),
      price_band: spec.profile.priceBand,
      systems_used: spec.profile.systemsUsed,
    },
  ];

  const jobIds = new Map(spec.jobs.map((j) => [j.name, newUuid()]));
  const parent_jobs = spec.jobs.map((j) => ({ id: need(jobIds, j.name, "job"), org_id, name: j.name, house: j.house, tipped: j.tipped }));

  const parent_staff = spec.staff.map((s, i) => ({
    id: newUuid(),
    org_id,
    location_id: need(locationIds, s.location, "location"),
    full_name: s.name,
    job_id: need(jobIds, s.job, "job"),
    email: `${emailLocal(s.name)}@${spec.emailDomain}`,
    phone: `+1 202 555 01${String(i + (template === "marigold" ? 10 : 60)).padStart(2, "0")}`,
    hourly_rate_minor: s.rate,
    currency: "USD",
    started_on: s.startedOn,
    status: "active",
  }));

  const parent_menu_categories: Row[] = [];
  const parent_menu_items: Row[] = [];
  const itemIds = new Map<string, string>();
  spec.categories.forEach((c, position) => {
    const categoryId = newUuid();
    parent_menu_categories.push({ id: categoryId, org_id, name: c.name, sales_group: c.salesGroup, position });
    for (const [name, price, description] of c.items) {
      const id = newUuid();
      itemIds.set(name, id);
      parent_menu_items.push({ id, org_id, category_id: categoryId, name, description: description ?? null, price_minor: price, currency: "USD", active: true });
    }
  });

  const parent_menu_modifiers = spec.modifiers.map((m) => ({
    id: newUuid(),
    org_id,
    item_id: m.item === undefined ? null : need(itemIds, m.item, "menu item"),
    name: m.name,
    price_minor: m.priceMinor,
    currency: "USD",
  }));

  const parent_tax_rates = spec.locations.flatMap((l) => [
    {
      id: newUuid(),
      org_id,
      location_id: need(locationIds, l.key, "location"),
      name: "Sales tax",
      rate_bps: spec.salesTaxBps,
      applies_to: "all",
      remitted_by: "restaurant",
    },
    {
      id: newUuid(),
      org_id,
      location_id: need(locationIds, l.key, "location"),
      name: "Sales tax on delivery app orders",
      rate_bps: spec.salesTaxBps,
      applies_to: "delivery",
      remitted_by: "platform",
    },
  ]);

  const parent_licences = spec.licences.map((l) => ({
    id: newUuid(),
    org_id,
    location_id: l.location === null ? null : need(locationIds, l.location, "location"),
    name: l.name,
    issuer: l.issuer,
    number: l.number,
    expires_on: addDays(opts.today, l.expiresInDays),
  }));

  const parent_equipment = spec.equipment.map((e) => ({
    id: newUuid(),
    org_id,
    location_id: need(locationIds, e.location, "location"),
    name: e.name,
    kind: e.kind,
    make: e.make,
    installed_on: e.installedOn,
  }));

  return {
    locations,
    restaurant_profiles,
    parent_jobs,
    parent_staff,
    parent_menu_categories,
    parent_menu_items,
    parent_menu_modifiers,
    parent_tax_rates,
    parent_licences,
    parent_equipment,
  };
};
