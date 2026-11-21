// Loads a demo restaurant's eight weeks of sales, bills, staff cost and stock counts into its
// store and posts them to the books, so the accounts reports have real numbers to show.
//
// Everything goes through the Data API, the same door a mini-app or an import uses: rows are
// written with `upsert_by_source` (so loading twice changes nothing), and the ledger is written
// only by the library's named actions. Nothing here touches a table directly.
//
// `loadDemoBooks` is the one loader. Today the demo reset calls it. In Wave 2 the Demo POS
// connection becomes the thing that calls it, which is why the reset has a `withSales` switch.
import { type AppManifestInput, type TenantContext, toPublicId } from "@rms/contracts";
import { handleData } from "@rms/data";
import { type Sql, newUuid, withStore } from "@rms/db";
import { DEFAULT_POSTING_RULES, LIBRARY, ensureModels } from "@rms/models";
import { loadDeliveryStatements } from "./delivery.js";
import { addDays } from "./rng.js";
import { DEFAULT_SALES_END, type GenerateSalesOptions, type GeneratedSales, type LabourGroup, type PaymentType, generateSales } from "./sales.js";
import type { CostGroup, StockUnit } from "./stock.js";
import { type DemoTemplate, TEMPLATES, templateSpec } from "./templates.js";

export type BooksRoute = "query" | "batch" | "named" | "action";

/**
 * Sends one Data API request and returns the reply body. It MUST throw when the reply is an
 * error. Tests pass a client that goes through the HTTP routes with a real token. The reset
 * passes one that calls the same engine in-process.
 */
export type BooksClient = (route: BooksRoute, body: unknown) => Promise<unknown>;

export type LoadBooksOptions = GenerateSalesOptions & {
  template: DemoTemplate;
  /** Post every day, bill, staff-cost row and stock count to the ledger. Default true. */
  post?: boolean;
  /**
   * Where the rows say they came from: the first part of every row's source id. Default
   * "demo-pos" (the real numbers, which the Demo POS connection takes over). The draft store's
   * sample numbers use `SAMPLE_SOURCE`, so a sample row can always be told from a real one.
   */
  source?: string;
};

export type LoadBooksResult = {
  startsOn: string;
  endsOn: string;
  /** Rows sent, by model. Loading again sends the same rows and adds none. */
  rows: Record<string, number>;
  /** How many documents made a ledger entry in THIS run. All zero on a second run. */
  posted: { salesDays: number; vendorBills: number; labourDays: number; stockCounts: number };
  /** What the two set-up actions added in this run. Zero on a second run. */
  setUp: { accountsAndRules: number; calendar: number };
};

/** Where the rows say they came from. One prefix, so the Demo POS can take over the same rows. */
const SOURCE = "demo-pos";
/** Where the draft store's sample numbers say they came from. Every sample row's source id starts with this. */
export const SAMPLE_SOURCE = "sample";

const UNITS: Record<StockUnit, { name: string; kind: "count" | "weight" | "volume" }> = {
  kg: { name: "Kilogram", kind: "weight" },
  l: { name: "Litre", kind: "volume" },
  each: { name: "Each", kind: "count" },
  case: { name: "Case", kind: "count" },
  bottle: { name: "Bottle", kind: "count" },
};

const PAYMENT_KIND: Record<PaymentType, "cash" | "card" | "delivery_platform"> = {
  cash: "cash", visa: "card", mastercard: "card", amex: "card", discover: "card", delivery_platform: "delivery_platform",
};
const JOB_GROUP: Record<LabourGroup, "front_of_house" | "back_of_house" | "management"> = { front: "front_of_house", back: "back_of_house", management: "management" };
const PAYOUT_KIND = { sales: "sales", tips: "tip", commission: "commission", marketing_fee: "marketing_fee", error_charge: "error_charge" } as const;

/** The cost account a purchase of each stock group is coded to: the same account its stock count adjusts. */
const costAccountCode = (group: CostGroup): string => {
  const rule = DEFAULT_POSTING_RULES.find((r) => r.part === "stock_cost" && r.costGroup === group);
  if (!rule) throw new Error(`No cost account for stock group ${group}`);
  return rule.accountCode;
};

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
/** A count or weight as the wire format wants it: plain digits, at most three decimals. */
const amountText = (n: number): string => n.toFixed(3).replace(/\.?0+$/, "");

type Upsert = { sourceId: string; values: Record<string, unknown> };
const CHUNK = 200;

/**
 * The manifest of the hidden "demo data" mini-app the loader acts as: every library model, report
 * and action. A real mini-app lists only what it uses. This one stands in for an import.
 */
export const booksManifest = (): AppManifestInput => ({
  name: "Demo data",
  description: "Loads the demo restaurant's sales, bills, staff cost and stock counts. Not shown to owners.",
  slots: [],
  models: [...LIBRARY.models.map((m) => ({ use: m.key, access: "write" as const })), { use: "parent.locations", access: "read" as const }],
  namedQueries: LIBRARY.namedQueries.map((q) => q.key),
  actions: LIBRARY.namedActions.map((a) => a.key),
});

export type BooksApp = { appUuid: string; versionUuid: string };

/**
 * Makes sure the restaurant has the hidden, published "demo data" mini-app the loader writes
 * as. Kind `system`, so screens that list an owner's mini-apps can leave it out. Admin
 * connection only. Safe to run again.
 *
 * Call it ONLY while holding the restaurant's loader lock (`seedDemoBooks` and
 * `ensureDraftSamples` do). A loader that is on with no lock held is what a crash leaves
 * behind, so `sweepBooksLoader` (API start-up, every Demo POS sync) switches it off at once and
 * the Data API then refuses its token. Tests that need a published mini-app make their own.
 */
export const ensureBooksApp = async (adminSql: Sql, orgUuid: string): Promise<BooksApp> =>
  adminSql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`rms.books_app:${orgUuid}`}, 0))`;
    const manifest = JSON.stringify(booksManifest());
    const [existing] = await tx<{ id: string; version: string | null }[]>`
      select id, published_version_id as version from platform.apps where org_id = ${orgUuid} and slug = 'demo-data' and kind = 'system'`;
    if (existing?.version) {
      await tx`update platform.app_versions set manifest = ${manifest}::text::jsonb where id = ${existing.version} and org_id = ${orgUuid}`;
      // It is paused between loads (see `pauseBooksApp`). Switch it back on for this one.
      await tx`update platform.apps set status = 'published' where id = ${existing.id} and org_id = ${orgUuid}`;
      return { appUuid: existing.id, versionUuid: existing.version };
    }
    const appUuid = existing?.id ?? newUuid();
    const versionUuid = newUuid();
    if (!existing) {
      const [next] = await tx<{ n: number }[]>`select coalesce(max(number), 0) + 1 as n from platform.apps where org_id = ${orgUuid}`;
      await tx`insert into platform.apps (id, org_id, slug, number, name, kind, status) values (${appUuid}, ${orgUuid}, 'demo-data', ${next?.n ?? 1}, 'Demo data', 'system', 'published')`;
    }
    await tx`insert into platform.app_versions (id, app_id, org_id, number, manifest, status, summary)
             values (${versionUuid}, ${appUuid}, ${orgUuid}, 1, ${manifest}::text::jsonb, 'published', 'Loads the demo numbers')`;
    await tx`update platform.apps set current_version_id = ${versionUuid}, published_version_id = ${versionUuid}, status = 'published' where id = ${appUuid} and org_id = ${orgUuid}`;
    return { appUuid, versionUuid };
  }) as Promise<BooksApp>;

/**
 * Switches the hidden "demo data" mini-app off. It may write to every library model, so it is
 * only ever on while a load is running: the Data API refuses a paused mini-app outright.
 * Admin connection only. Safe to run again, and when there is no such mini-app.
 */
export const pauseBooksApp = async (adminSql: Sql, orgUuid: string): Promise<void> => {
  await adminSql`update platform.apps set status = 'paused' where org_id = ${orgUuid} and slug = 'demo-data' and kind = 'system' and status <> 'deleted'`;
};

/** The first and last day the numbers cover, without generating them. Same defaults as `generateSales`. */
const salesRange = (range: GenerateSalesOptions): { startsOn: string; endsOn: string } => {
  const endsOn = range.endingOn ?? DEFAULT_SALES_END;
  return { startsOn: addDays(endsOn, -(7 * (range.weeks ?? 8) - 1)), endsOn };
};

export type BooksSetUp = { accountsAndRules: number; calendar: number };

/**
 * What a restaurant's books need before any number arrives: the chart of accounts with its
 * posting rules, and a fiscal calendar for the weeks the demo numbers cover (one week early,
 * for the opening stock count). Both are library actions, safe to run again.
 */
export const setUpBooks = async (client: BooksClient, range: GenerateSalesOptions = {}): Promise<BooksSetUp> => {
  const act = async (action: string, params: Record<string, string>): Promise<number> => ((await client("action", { action, params })) as { affected: number }).affected;
  const { startsOn, endsOn } = salesRange(range);
  const accountsAndRules = await act("seed_chart_of_accounts", {});
  const calendar = await act("seed_fiscal_calendar", { from_date: addDays(startsOn, -7), to_date: endsOn });
  return { accountsAndRules, calendar };
};

/**
 * Loads `weeks` weeks of the template's generated numbers through `client` and posts them.
 * Repeatable: every row is keyed by where it came from, and every posting action skips what is
 * already in the books.
 */
export const loadDemoBooks = async (client: BooksClient, opts: LoadBooksOptions): Promise<LoadBooksResult> => {
  const { template, post = true, source = SOURCE, ...range } = opts;
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(source)) throw new Error("Loading the demo numbers: the source must be a short plain name");
  const sales: GeneratedSales = generateSales(template, range);
  const spec = templateSpec(template);
  const rows: Record<string, number> = {};

  /** Upserts rows of one model by source id, in order. Returns their ids, in the same order. */
  const upsert = async (model: string, items: readonly Upsert[]): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < items.length; i += CHUNK) {
      const ops = items.slice(i, i + CHUNK).map((r) => ({ op: "upsert_by_source", model, sourceId: `${source}/${model}/${r.sourceId}`, values: r.values }));
      const res = (await client("batch", { ops })) as { results: { id: string }[] };
      if (res.results.length !== ops.length) throw new Error(`Loading ${model}: the reply does not match what was sent`);
      ids.push(...res.results.map((r) => r.id));
    }
    rows[model] = (rows[model] ?? 0) + items.length;
    return ids;
  };
  /** Upserts and returns a lookup from each row's own key to its id. */
  const upsertKeyed = async (model: string, items: readonly (Upsert & { key: string })[]): Promise<Map<string, string>> => {
    const ids = await upsert(model, items);
    return new Map(items.map((r, i) => [r.key, ids[i] as string]));
  };
  const need = (map: ReadonlyMap<string, string>, key: string, what: string): string => {
    const id = map.get(key);
    if (!id) throw new Error(`Loading the demo numbers: no ${what} called "${key}"`);
    return id;
  };
  const act = async (action: string, params: Record<string, string>): Promise<number> => ((await client("action", { action, params })) as { affected: number }).affected;

  // ---- the restaurant's own locations (parent data, read-only)
  const places = (await client("query", { model: "parent.locations", limit: 100 })) as { rows: { id: string; name: string }[] };
  const locationByName = new Map(places.rows.map((r) => [r.name, r.id]));
  const locationId = new Map(sales.locations.map((l) => [l.key, need(locationByName, l.name, "location")]));
  const loc = (key: string) => need(locationId, key, "location");

  // ---- set-up: chart of accounts, posting rules, fiscal calendar
  const { accountsAndRules, calendar } = await setUpBooks(client, range);
  const accounts = (await client("query", { model: "account", fields: ["id", "code"], limit: 500 })) as { rows: { id: string; code: string }[] };
  const accountByCode = new Map(accounts.rows.map((r) => [r.code, r.id]));

  // ---- lists
  const unitId = await upsertKeyed("unit", (Object.keys(UNITS) as StockUnit[]).map((code) => ({ key: code, sourceId: code, values: { code, name: UNITS[code].name, kind: UNITS[code].kind, active: true } })));
  const categoryId = await upsertKeyed(
    "sales_category",
    spec.categories.map((c, i) => ({ key: c.name, sourceId: slug(c.name), values: { name: c.name, sales_group: c.salesGroup, position: i + 1, active: true } })),
  );
  const paymentTypes = new Map<string, { label: string; kind: string }>();
  for (const d of sales.days) for (const p of d.payments) paymentTypes.set(p.label, { label: p.label, kind: PAYMENT_KIND[p.type] });
  const paymentTypeId = await upsertKeyed("payment_type", [...paymentTypes.values()].map((p) => ({ key: p.label, sourceId: slug(p.label), values: { name: p.label, kind: p.kind, active: true } })));

  const reasons = new Map<string, { kind: "discount" | "comp" | "void"; name: string }>();
  for (const d of sales.days) {
    for (const r of d.discounts) reasons.set(`discount/${r.reason}`, { kind: "discount", name: r.reason });
    for (const r of d.comps) reasons.set(`comp/${r.reason}`, { kind: "comp", name: r.reason });
    for (const r of d.voids) reasons.set(`void/${r.reason}`, { kind: "void", name: r.reason });
  }
  const reasonId = await upsertKeyed("reason_code", [...reasons].map(([key, r]) => ({ key, sourceId: `${r.kind}/${slug(r.name)}`, values: { code: slug(r.name).slice(0, 32), name: r.name, kind: r.kind, active: true } })));

  const vendorNames = [...new Set([...sales.items.map((i) => i.vendor), ...sales.vendorBills.map((b) => b.vendor)])];
  const vendorId = await upsertKeyed("vendor", vendorNames.map((name) => ({ key: name, sourceId: slug(name), values: { name, terms_days: 14, active: true } })));
  const itemId = await upsertKeyed(
    "item",
    sales.items.map((i) => ({ key: i.key, sourceId: i.key, values: { name: i.name, cost_group: i.costGroup, base_unit: need(unitId, i.unit, "unit"), unit_cost: i.unitCostMinor, active: true } })),
  );

  // ---- one row per day and location, then its breakdown rows
  const dayKey = (d: { locationKey: string; businessDate: string }) => `${d.locationKey}/${d.businessDate}`;
  const salesDayId = await upsertKeyed(
    "sales_day",
    sales.days.map((d) => ({
      key: dayKey(d), sourceId: dayKey(d),
      values: {
        location_id: loc(d.locationKey), business_date: d.businessDate, channel: "all",
        gross_sales: d.grossSalesMinor, discounts: d.discountsMinor, comps: d.compsMinor, voids: d.voids.reduce((a, v) => a + v.amountMinor, 0),
        net_sales: d.netSalesMinor, sales_tax: d.salesTaxMinor, tax_remitted_by_platform: d.marketplaceTaxMinor, tips: d.tipsMinor, guests: d.guestCount,
      },
    })),
  );
  const categoryRows: Upsert[] = [];
  const paymentRows: Upsert[] = [];
  const adjustmentRows: Upsert[] = [];
  const giftCardRows: Upsert[] = [];
  const labourRows: (Upsert & { key: string })[] = [];
  for (const d of sales.days) {
    const day = need(salesDayId, dayKey(d), "day of sales");
    const base = { location_id: loc(d.locationKey), sales_day: day };
    for (const c of d.categories) {
      categoryRows.push({ sourceId: `${dayKey(d)}/${slug(c.category)}`, values: { ...base, sales_category: need(categoryId, c.category, "sales category"), gross_sales: c.grossMinor, discounts: c.discountsMinor, comps: c.compsMinor, net_sales: c.netMinor } });
    }
    for (const p of d.payments) {
      paymentRows.push({ sourceId: `${dayKey(d)}/${slug(p.label)}`, values: { ...base, payment_type: need(paymentTypeId, p.label, "payment type"), amount: p.amountMinor } });
    }
    for (const r of d.discounts) adjustmentRows.push({ sourceId: `${dayKey(d)}/discount/${slug(r.reason)}`, values: { ...base, kind: "discount", reason: need(reasonId, `discount/${r.reason}`, "reason"), amount: r.amountMinor } });
    for (const r of d.comps) adjustmentRows.push({ sourceId: `${dayKey(d)}/comp/${slug(r.reason)}`, values: { ...base, kind: "comp", reason: need(reasonId, `comp/${r.reason}`, "reason"), amount: r.amountMinor } });
    for (const r of d.voids) adjustmentRows.push({ sourceId: `${dayKey(d)}/void/${slug(r.reason)}`, values: { ...base, kind: "void", reason: need(reasonId, `void/${r.reason}`, "reason"), amount: r.amountMinor, item_count: r.count } });
    giftCardRows.push({ sourceId: dayKey(d), values: { ...base, sold_amount: d.giftCardsSoldMinor, redeemed_amount: d.giftCardsRedeemedMinor } });
    for (const l of d.labour) {
      const key = `${dayKey(d)}/${JOB_GROUP[l.group]}`;
      labourRows.push({ key, sourceId: key, values: { location_id: loc(d.locationKey), business_date: d.businessDate, job_group: JOB_GROUP[l.group], hours: l.hours.toFixed(2), labour_cost: l.costMinor } });
    }
  }
  await upsert("sales_category_day", categoryRows);
  await upsert("payment_day", paymentRows);
  await upsert("adjustment_day", adjustmentRows);
  await upsert("gift_card_activity", giftCardRows);
  const labourDayId = await upsertKeyed("labour_day", labourRows);

  // ---- purchases
  const billKey = (b: { locationKey: string; billNumber: string }) => `${b.locationKey}/${b.billNumber}`;
  const billId = await upsertKeyed(
    "vendor_bill",
    sales.vendorBills.map((b) => ({
      key: billKey(b), sourceId: billKey(b),
      values: { location_id: loc(b.locationKey), vendor: need(vendorId, b.vendor, "vendor"), bill_number: b.billNumber, business_date: b.billDate, due_date: b.dueDate, total_amount: b.totalMinor, status: "open" },
    })),
  );
  await upsert(
    "vendor_bill_line",
    sales.vendorBills.flatMap((b) =>
      b.lines.map((l, i) => ({
        sourceId: `${billKey(b)}/${i + 1}`,
        values: {
          location_id: loc(b.locationKey), vendor_bill: need(billId, billKey(b), "vendor bill"), line_number: i + 1, description: l.description,
          account: need(accountByCode, costAccountCode(l.costGroup), "account"), cost_group: l.costGroup,
          quantity: { value: amountText(l.quantity), unit: l.unit }, amount: l.amountMinor,
        },
      })),
    ),
  );

  // ---- stock counts: the opening count, then every Sunday at close
  const countKey = (c: { locationKey: string; countedOn: string }) => `${c.locationKey}/${c.countedOn}`;
  const counts = [...sales.stockCounts].sort((a, b) => a.countedOn.localeCompare(b.countedOn) || a.locationKey.localeCompare(b.locationKey));
  const countId = await upsertKeyed(
    "stock_count",
    counts.map((c) => ({ key: countKey(c), sourceId: countKey(c), values: { location_id: loc(c.locationKey), counted_on: c.countedOn, status: "final", note: c.kind === "opening" ? "Opening count" : "Week-end count" } })),
  );
  await upsert(
    "stock_count_line",
    counts.flatMap((c) =>
      c.lines.map((l) => ({
        sourceId: `${countKey(c)}/${l.itemKey}`,
        values: {
          location_id: loc(c.locationKey), stock_count: need(countId, countKey(c), "stock count"), item: need(itemId, l.itemKey, "stock item"),
          quantity: { value: amountText(l.quantity), unit: l.unit }, unit_cost: l.unitCostMinor, value: l.valueMinor,
        },
      })),
    ),
  );

  // ---- delivery platform payouts
  const payoutKey = (p: { locationKey: string; platform: string; periodStart: string }) => `${p.locationKey}/${p.platform}/${p.periodStart}`;
  const payoutId = await upsertKeyed(
    "delivery_payout",
    sales.deliveryPayouts.map((p) => ({
      key: payoutKey(p), sourceId: payoutKey(p),
      values: {
        location_id: loc(p.locationKey), platform: need(paymentTypeId, p.label, "payment type"), period_start: p.periodStart, period_end: p.periodEnd,
        business_date: p.payoutDate, net_amount: p.payoutMinor, status: p.status === "paid" ? "received" : "expected",
      },
    })),
  );
  await upsert(
    "delivery_payout_line",
    sales.deliveryPayouts.flatMap((p) =>
      p.lines.map((l, i) => ({
        sourceId: `${payoutKey(p)}/${i + 1}`,
        values: { location_id: loc(p.locationKey), payout: need(payoutId, payoutKey(p), "payout"), kind: PAYOUT_KIND[l.type], amount: l.amountMinor, description: l.description },
      })),
    ),
  );

  // ---- the books. Each action makes one balanced entry, or nothing if it is already there.
  const posted = { salesDays: 0, vendorBills: 0, labourDays: 0, stockCounts: 0 };
  if (post) {
    for (const id of salesDayId.values()) if ((await act("post_sales_day", { sales_day_id: id })) > 0) posted.salesDays++;
    for (const id of billId.values()) if ((await act("post_vendor_bill", { vendor_bill_id: id })) > 0) posted.vendorBills++;
    for (const id of labourDayId.values()) if ((await act("post_labour_day", { labour_day_id: id })) > 0) posted.labourDays++;
    // Oldest first: a count is compared with the one before it.
    for (const c of counts) if ((await act("post_stock_count", { stock_count_id: need(countId, countKey(c), "stock count") })) > 0) posted.stockCounts++;
  }
  await loadDeliveryStatements(sales, { upsert, upsertKeyed, act, loc, accountByCode, post, posted });

  return { startsOn: sales.startsOn, endsOn: sales.endsOn, rows, posted, setUp: { accountsAndRules, calendar } };
};

export type SeedBooksOptions = GenerateSalesOptions & {
  orgUuid: string;
  template: DemoTemplate;
  /** The owner the rows are recorded as written by. A real sign-in user of this restaurant. */
  ownerUserId: string;
  /**
   * Load and post the sales, bills, staff cost and stock counts. Without it the restaurant gets
   * its tables, its chart of accounts and its fiscal calendar, and no numbers.
   */
  withSales: boolean;
  /**
   * Also fill the DRAFT store (what a mini-app's preview reads during a build) with sample
   * numbers: the template's own eight weeks, every row marked with `SAMPLE_SOURCE`. Default
   * FALSE: it takes about ten seconds, so sign-up never waits for it. The reset passes true; a
   * build calls `ensureDraftSamples` when it starts. The live store is never touched by this.
   */
  draftSamples?: boolean;
};

export type WeekFigures = { weekStart: string; netSalesMinor: number; primeCostPct: string; stockCounted: boolean };

/** What was loaded, the last week as the prime cost report now shows it, and every week the numbers cover. */
export type SeededBooks = LoadBooksResult & { lastWeek: WeekFigures; weeks: WeekFigures[] };

/** The sample numbers put in the draft store. */
export type DraftSamples = {
  startsOn: string;
  endsOn: string;
  rows: Record<string, number>;
  /** Documents posted in THIS run. Zero on a second run. */
  posted: number;
  /** The last week as the prime cost report shows it IN THE DRAFT STORE: what a preview sees. */
  lastWeek: WeekFigures | null;
};

export type SeedBooksResult = {
  /** What the two set-up actions added in this run. Zero when they had been run before. */
  setUp: BooksSetUp;
  /** Null without `withSales`. */
  books: SeededBooks | null;
  /** Null when `draftSamples` is false. */
  draft: DraftSamples | null;
};

/** A Data API client for one context. Throws on any refusal, with the code and message only. */
const dataClient = (tenant: TenantContext): BooksClient => async (route, body) => {
  const reply = await handleData(route, tenant, body, newUuid());
  if (reply.status !== 200) {
    const error = (reply.body as { error?: { code?: string; message?: string } }).error;
    throw new Error(`Setting up the books failed (${route}: ${error?.code ?? "unknown"}). ${error?.message ?? ""}`.trim());
  }
  return reply.body;
};

/** Every week of the prime cost report, all locations together, oldest first. */
const readWeeks = async (client: BooksClient, from: string, to: string): Promise<WeekFigures[]> => {
  const report = (await client("named", { query: "prime_cost_by_week", params: { from_date: from, to_date: to } })) as { rows: Record<string, unknown>[] };
  return report.rows
    .filter((r) => r.scope === "all_locations")
    .map((r) => ({ weekStart: String(r.week_start), netSalesMinor: Number(r.net_sales), primeCostPct: String(r.prime_cost_pct), stockCounted: r.stock_counted === true }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
};


// ------------------------------------------------------------------ the loader lock and the sweep
//
// The hidden "demo data" mini-app may write to every library model, so it must never stay
// switched on. Every load holds a per-restaurant lock for its whole length: a transaction-scoped
// advisory lock, so it goes away by itself if the process dies. `sweepBooksLoader` switches off
// any loader app (and removes any sample-numbers build) whose restaurant has no load holding the
// lock: what a crash left behind. Run it at start-up; the Demo POS sync also runs it first.

const loaderLockKey = (orgUuid: string) => `rms.books_loader:${orgUuid}`;

/** Runs `fn` while this restaurant's loader lock is held. One load per restaurant at a time. */
const withLoaderLock = async <T>(adminSql: Sql, orgUuid: string, fn: () => Promise<T>): Promise<T> => {
  let out: { value: T } | null = null;
  await adminSql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${loaderLockKey(orgUuid)}, 0))`;
    out = { value: await fn() };
  });
  if (!out) throw new Error("The loader lock ended without a result");
  return (out as { value: T }).value;
};

/** Switches off loader apps and removes sample-numbers builds that no running load owns. Admin connection. Safe to run any time. */
export const sweepBooksLoader = async (adminSql: Sql): Promise<{ paused: number; buildsRemoved: number }> => {
  const apps = await adminSql<{ id: string; org_id: string }[]>`
    select a.id, a.org_id from platform.apps a
     where a.slug = 'demo-data' and a.kind = 'system'
       and (a.status = 'published' or exists (select 1 from platform.agent_sessions s where s.app_id = a.id and s.org_id = a.org_id))`;
  const result = { paused: 0, buildsRemoved: 0 };
  for (const app of apps) {
    await adminSql.begin(async (tx) => {
      const [lock] = await tx<{ got: boolean }[]>`select pg_try_advisory_xact_lock(hashtextextended(${loaderLockKey(app.org_id)}, 0)) as got`;
      if (!lock?.got) return; // a load is running right now
      const paused = await tx`update platform.apps set status = 'paused' where id = ${app.id} and org_id = ${app.org_id} and status = 'published'`;
      await tx`delete from platform.agent_runs r using platform.agent_sessions s
                where r.session_id = s.id and s.app_id = ${app.id} and s.org_id = ${app.org_id}`;
      const removed = await tx`delete from platform.agent_sessions where app_id = ${app.id} and org_id = ${app.org_id}`;
      result.paused += paused.count;
      result.buildsRemoved += removed.count;
    });
  }
  return result;
};

// ------------------------------------------------------------------ which restaurants are demo restaurants

/**
 * The demo template a restaurant was made from, decided by its restaurant profile: parent data
 * that only the platform writes (restaurant logins cannot change it, unlike the restaurant's own
 * name). Name, concept and cuisine must all be the template's. Null for any other restaurant.
 * Interim: an explicit demo flag on the restaurant needs a schema change (asked of the lead).
 */
export const templateForProfile = (profile: { name: string; concept: string; cuisine: string } | null | undefined): DemoTemplate | null => {
  if (!profile) return null;
  for (const t of Object.keys(TEMPLATES) as DemoTemplate[]) {
    const spec = TEMPLATES[t];
    if (spec.name === profile.name && spec.profile.concept === profile.concept && spec.profile.cuisine === profile.cuisine) return t;
  }
  return null;
};

/** `templateForProfile` for one restaurant, read on the admin connection. */
export const demoTemplateOf = async (adminSql: Sql, orgUuid: string): Promise<DemoTemplate | null> => {
  const [p] = await adminSql<{ name: string; concept: string; cuisine: string }[]>`
    select name, concept, cuisine from platform.restaurant_profiles where org_id = ${orgUuid}`;
  return templateForProfile(p);
};

// ------------------------------------------------------------------ sample numbers in the draft store

/**
 * Loads the sample numbers into the draft store, through the Data API like everything else.
 *
 * The Data API lets a mini-app into a draft store only while one of its builds is running. So
 * the hidden "demo data" mini-app gets a build of its own for the length of the load: a closed
 * session with one run, removed again straight after in a `finally` (and by `sweepBooksLoader`
 * if the process died). Nobody sees it: it belongs to the hidden mini-app and holds no events.
 * The caller holds the loader lock and has switched the loader app on.
 */
const loadDraftSamples = async (
  adminSql: Sql,
  ctx: { orgUuid: string; prefix: string; ownerUserId: string; app: BooksApp; template: DemoTemplate; range: GenerateSalesOptions },
): Promise<DraftSamples> => {
  const sessionUuid = newUuid();
  const runUuid = newUuid();
  try {
    await adminSql.begin(async (tx) => {
      await tx`insert into platform.agent_sessions (id, org_id, user_id, app_id, mode, model, title, status)
               values (${sessionUuid}, ${ctx.orgUuid}, ${ctx.ownerUserId}, ${ctx.app.appUuid}, 'build', 'none', 'Sample numbers', 'closed')`;
      await tx`insert into platform.agent_runs (id, session_id, org_id, status) values (${runUuid}, ${sessionUuid}, ${ctx.orgUuid}, 'running')`;
    });
    const client = dataClient({
      orgId: toPublicId("org", ctx.orgUuid),
      storePrefix: ctx.prefix,
      actor: { type: "user", id: toPublicId("usr", ctx.ownerUserId) },
      role: "owner",
      locations: "all",
      env: "draft",
      appId: toPublicId("app", ctx.app.appUuid),
      runId: toPublicId("run", runUuid),
    });
    const loaded = await loadDemoBooks(client, { template: ctx.template, ...ctx.range, source: SAMPLE_SOURCE });
    const posted = loaded.posted.salesDays + loaded.posted.vendorBills + loaded.posted.labourDays + loaded.posted.stockCounts;
    // Read back the way a preview reads it: the prime cost report, in the draft store.
    const weeks = await readWeeks(client, loaded.startsOn, loaded.endsOn);
    return { startsOn: loaded.startsOn, endsOn: loaded.endsOn, rows: loaded.rows, posted, lastWeek: weeks.at(-1) ?? null };
  } finally {
    await adminSql.begin(async (tx) => {
      await tx`delete from platform.agent_runs where id = ${runUuid} and org_id = ${ctx.orgUuid}`;
      await tx`delete from platform.agent_sessions where id = ${sessionUuid} and org_id = ${ctx.orgUuid}`;
    });
  }
};

/** True when the draft store already has sample numbers. One indexed lookup, no load. */
const hasDraftSamples = async (adminSql: Sql, orgUuid: string, prefix: string): Promise<boolean> => {
  const ctx: TenantContext = {
    orgId: toPublicId("org", orgUuid), storePrefix: prefix, actor: { type: "system", id: "books-loader" }, role: "owner", locations: "all", env: "draft",
  };
  return withStore(adminSql, ctx, async (tx, store) => {
    const rows = await tx.unsafe(`select 1 from ${store.table("sales_day")} where source_id like $1 limit 1`, [`${SAMPLE_SOURCE}/%`]);
    return rows.length > 0;
  });
};

export type EnsureDraftSamplesResult = { status: "filled"; draft: DraftSamples } | { status: "already" } | { status: "not_demo" };

/**
 * Makes sure a demo restaurant's draft store has its sample numbers. Call it when a build
 * starts: cheap when they are there already (one lookup), about ten seconds when they are not.
 * The template comes from the restaurant's profile, the owner from its members. A restaurant
 * that is not a demo restaurant gets nothing. The library tables must exist (sign-up and the
 * reset make them). Admin connection. Throws on a real failure: a build should carry on without
 * sample numbers rather than stop.
 */
export const ensureDraftSamples = async (adminSql: Sql, orgUuid: string): Promise<EnsureDraftSamplesResult> => {
  const template = await demoTemplateOf(adminSql, orgUuid);
  if (!template) return { status: "not_demo" };
  const [org] = await adminSql<{ prefix: string }[]>`select store_prefix as prefix from platform.organizations where id = ${orgUuid}`;
  if (!org) throw new Error("Unknown restaurant");
  if (await hasDraftSamples(adminSql, orgUuid, org.prefix)) return { status: "already" };
  const [owner] = await adminSql<{ user_id: string }[]>`
    select user_id from platform.members where org_id = ${orgUuid} and role = 'owner' and status = 'active' order by created_at limit 1`;
  if (!owner) throw new Error("The restaurant has no owner to record the sample numbers under");
  return withLoaderLock(adminSql, orgUuid, async () => {
    if (await hasDraftSamples(adminSql, orgUuid, org.prefix)) return { status: "already" } as const;
    const app = await ensureBooksApp(adminSql, orgUuid);
    try {
      const draft = await loadDraftSamples(adminSql, { orgUuid, prefix: org.prefix, ownerUserId: owner.user_id, app, template, range: {} });
      return { status: "filled", draft } as const;
    } finally {
      await pauseBooksApp(adminSql, orgUuid);
    }
  });
};

// ------------------------------------------------------------------ the one entry point

/**
 * Gives one demo restaurant its books. Used by the reset, by onboarding, and by the Demo POS
 * sync: make the library tables, add the chart of accounts and the fiscal calendar, and, with
 * `withSales`, load and post the demo numbers into the live store. With `draftSamples` the
 * draft store gets the same template's numbers as clearly marked sample numbers.
 *
 * Everything after the tables goes through the Data API as the hidden "demo data" mini-app,
 * which is switched on for the load and ALWAYS switched off again, whether the load worked or
 * not, under the restaurant's loader lock. The library must be installed first
 * (`installPlatformLibrary`). Admin connection only, and only for seeded demo restaurants.
 */
export const seedDemoBooks = async (adminSql: Sql, opts: SeedBooksOptions): Promise<SeedBooksResult> => {
  const { orgUuid, template, ownerUserId, withSales, draftSamples = false, ...range } = opts;
  await ensureModels(adminSql, orgUuid, LIBRARY.models.map((m) => m.key));

  const [org] = await adminSql<{ prefix: string }[]>`select store_prefix as prefix from platform.organizations where id = ${orgUuid}`;
  if (!org) throw new Error("Unknown restaurant");
  return withLoaderLock(adminSql, orgUuid, async () => {
    const app = await ensureBooksApp(adminSql, orgUuid);
    try {
      // The same context a signed app token would give: this restaurant, its owner, live data.
      const client = dataClient({
        orgId: toPublicId("org", orgUuid),
        storePrefix: org.prefix,
        actor: { type: "user", id: toPublicId("usr", ownerUserId) },
        role: "owner",
        locations: "all",
        env: "live",
        appId: toPublicId("app", app.appUuid),
        appVersionId: toPublicId("ver", app.versionUuid),
      });

      let setUp: BooksSetUp;
      let books: SeededBooks | null = null;
      if (!withSales) {
        setUp = await setUpBooks(client, range);
      } else {
        const loaded = await loadDemoBooks(client, { template, ...range });
        // Read the weeks back through the prime cost report, so callers can show (and the Demo
        // POS sync can check) that the reports work on what was just loaded.
        const weeks = await readWeeks(client, loaded.startsOn, loaded.endsOn);
        const weekStart = addDays(loaded.endsOn, -6);
        const lastWeek = weeks.find((w) => w.weekStart === weekStart);
        if (!lastWeek) throw new Error("Loading the demo numbers: the prime cost report has no row for the last week");
        setUp = loaded.setUp;
        books = { ...loaded, lastWeek, weeks };
      }

      const draft = draftSamples ? await loadDraftSamples(adminSql, { orgUuid, prefix: org.prefix, ownerUserId, app, template, range }) : null;
      return { setUp, books, draft };
    } finally {
      await pauseBooksApp(adminSql, orgUuid);
    }
  });
};
