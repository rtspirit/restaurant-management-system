import { z } from "zod";
import { DateValue } from "./data-api.js";
import { ConnectionId, Ident } from "./ids.js";
import { ModelAccess } from "./models.js";

/**
 * Connections to outside systems (plan 4.8). Demo scope: one catalog entry, "Demo POS", an MCP
 * server that RMS itself hosts, and connect by address with a token.
 *
 * Rules every part keeps:
 *   - Only the gateway (packages/mcp, on the server) talks to a connected system. Agents,
 *     mini-apps and browsers never do, and never see a connection's token.
 *   - The restaurant comes from the owner's session. No request names one.
 *   - Tool output is DATA. It is parsed with the tool's output shape and stored as rows. It is
 *     never read as instructions and never passed to a model as anything but quoted data.
 *   - A tool may be called only if it is granted for that consumer. A changed tool list stops
 *     the connection until the owner approves it again.
 */

// ------------------------------------------------------------------ catalog and connections

export const McpCatalogEntry = z.object({
  key: Ident,
  name: z.string().max(60),
  vendor: z.string().max(60),
  category: z.string().max(40),
  /** Plain words: what connecting brings in. */
  description: z.string().max(280),
  /** "rms": RMS hosts this system and issues the token itself, so the owner types nothing. "bearer": the owner pastes a token. */
  auth: z.enum(["rms", "bearer"]),
  /** True when this restaurant already has it connected. */
  connected: z.boolean(),
});
export type McpCatalogEntry = z.infer<typeof McpCatalogEntry>;

/**
 * Connect a system. Owner only.
 * `custom` makes the SERVER call an address the owner typed, so the gateway must refuse
 * anything that is not a public https address (no private, local or link-local hosts, no
 * redirects) before it connects. `token` is stored encrypted and never returned.
 */
export const ConnectRequest = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("catalog"), key: Ident }),
  z.strictObject({
    kind: z.literal("custom"),
    name: z.string().min(1).max(40),
    url: z.url().max(300).refine((u) => u.startsWith("https://"), "The address must start with https://"),
    token: z.string().min(8).max(4096),
  }),
]);
export type ConnectRequest = z.infer<typeof ConnectRequest>;

export const ConnectionStatus = z.enum(["connected", "needs_approval", "error", "disconnected"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

/** A tool as the connected system describes it. `inputSchema` is kept as data and never executed. */
export const McpToolInfo = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  description: z.string().max(400),
  /** True when the system marks the tool as read-only. Anything else is treated as a write and needs the owner each time. */
  readOnly: z.boolean(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type McpToolInfo = z.infer<typeof McpToolInfo>;

/**
 * The text that is hashed (SHA-256, hex) into `mcp_connections.tools_hash`. Sorted by name, with
 * sorted keys, so the same tool list always gives the same hash. A different hash on a later
 * check sets the connection to `needs_approval`.
 */
export const canonicalToolList = (tools: readonly McpToolInfo[]): string => {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  const list = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify(list.map((t) => sortKeys({ name: t.name, description: t.description, readOnly: t.readOnly, inputSchema: t.inputSchema })));
};

/** Who may call a tool. `import` is the platform's own sync. `app` and `ask` come in later waves. */
export const ToolConsumer = z.strictObject({ type: z.enum(["app", "ask", "import"]), id: z.string().min(1).max(80) });
export type ToolConsumer = z.infer<typeof ToolConsumer>;

/** One row of `platform.mcp_tool_grants`. `confirm`: ask the owner before each call (always true for a write). */
export const ToolGrant = z.object({
  connectionId: ConnectionId,
  consumer: ToolConsumer,
  tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  access: ModelAccess,
  confirm: z.boolean(),
});
export type ToolGrant = z.infer<typeof ToolGrant>;

/** The consumer the platform's sync runs as. */
export const SYNC_CONSUMER = { type: "import", id: "sync" } as const satisfies ToolConsumer;

/** A connection as the owner sees it. No address, no token, no hash. */
export const ConnectionView = z.object({
  id: ConnectionId,
  name: z.string(),
  catalogKey: Ident.nullable(),
  status: ConnectionStatus,
  /** Plain words for the status, for example "Connected. Last brought in sales 2 minutes ago." */
  statusText: z.string().max(200),
  tools: z.array(z.object({ name: z.string(), description: z.string(), readOnly: z.boolean(), granted: z.boolean() })).max(60),
  lastSyncedAt: z.iso.datetime().nullable(),
  /** True when RMS knows how to bring this system's information in (today: Demo POS only). */
  canSync: z.boolean(),
});
export type ConnectionView = z.infer<typeof ConnectionView>;

/** Approve the tool list as it is now. `tools` must equal the names the owner was shown, or it is refused as stale. */
export const ApproveToolsRequest = z.strictObject({ tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).min(1).max(60) });
export type ApproveToolsRequest = z.infer<typeof ApproveToolsRequest>;

/** Bring information in. Omitted dates = the last eight weeks the system has. */
export const SyncRequest = z.strictObject({ from: DateValue.optional(), to: DateValue.optional() });
export type SyncRequest = z.infer<typeof SyncRequest>;

export const SyncResult = z.object({
  status: z.enum(["ok", "nothing_new", "failed"]),
  from: DateValue.nullable(),
  to: DateValue.nullable(),
  counts: z.object({
    salesDays: z.number().int().nonnegative(),
    labourDays: z.number().int().nonnegative(),
    deliveryPayouts: z.number().int().nonnegative(),
    vendorBills: z.number().int().nonnegative(),
    stockCounts: z.number().int().nonnegative(),
    /** Entries written to the books by the posting actions. */
    posted: z.number().int().nonnegative(),
  }),
  /** Plain words, for example "Brought in 8 weeks of sales for 2 locations." */
  message: z.string().max(240),
});
export type SyncResult = z.infer<typeof SyncResult>;

/** Connection routes on the API origin. Owner's RMS session. Owner only. */
export const CONNECTION_ROUTES = {
  catalog: "/connections/v1/catalog", // GET -> { entries: McpCatalogEntry[] }
  list: "/connections/v1", // GET -> { connections: ConnectionView[] }
  connect: "/connections/v1", // POST ConnectRequest -> ConnectionView
  approve: "/connections/v1/:connectionId/approve", // POST ApproveToolsRequest -> ConnectionView
  sync: "/connections/v1/:connectionId/sync", // POST SyncRequest -> SyncResult
  disconnect: "/connections/v1/:connectionId/disconnect", // POST, no body -> ConnectionView
} as const;

// ------------------------------------------------------------------ Demo POS

/**
 * Demo POS: a made-up point-of-sale system, served by RMS as an MCP server (streamable HTTP,
 * stateless) at `DEMO_POS.route` on the API origin.
 *
 *   - Auth: `Authorization: Bearer <connection token>` (`ConnectionTokenClaims`, audience "mcp").
 *     The gateway mints a fresh one for each call. Nothing is stored and the owner types nothing.
 *   - The server takes the restaurant and the connection from the token ONLY. It answers with
 *     the seeded numbers for that restaurant's demo template (`generateSales` in @rms/seed) and
 *     for no one else. A restaurant that is not one of the demo templates gets empty lists.
 *   - Every tool is read-only.
 *   - Money is whole cents in fields ending `Minor`. Dates are "YYYY-MM-DD" business dates.
 *     Locations are named by the POS's own keys (`list_locations`). The sync matches them to the
 *     restaurant's locations by name.
 *   - Field names are the same as the seed's types, so a tool answer is a slice of what
 *     `generateSales` returns.
 */
export const DEMO_POS = {
  catalogKey: "demo_pos",
  name: "Demo POS",
  route: "/mcp/demo-pos",
  serverName: "rms-demo-pos",
  scope: "mcp",
  /** The longest range one call may ask for. */
  maxRangeDays: 92,
} as const;

export const PosLocationKey = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

/** Input of every dated tool. `location` omitted = every location. */
export const DemoPosRangeInput = z
  .strictObject({ from: DateValue, to: DateValue, location: PosLocationKey.optional() })
  .refine((r) => r.from <= r.to, "from must not be after to")
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 < DEMO_POS.maxRangeDays, "Ask for at most 92 days at a time");
export type DemoPosRangeInput = z.infer<typeof DemoPosRangeInput>;

export const DemoPosNoInput = z.strictObject({});

const Minor = z.number().int().refine(Number.isSafeInteger);
const day = { businessDate: DateValue, locationKey: PosLocationKey };

const ReasonAmount = z.object({ reason: z.string(), amountMinor: Minor });
const CostGroup = z.enum(["food", "beverage", "alcohol", "supplies"]);
const StockUnit = z.enum(["kg", "l", "each", "case", "bottle"]);

export const DemoPosLocations = z.object({ locations: z.array(z.object({ key: PosLocationKey, name: z.string() })) });

export const DemoPosDailySales = z.object({
  days: z.array(z.object({
    ...day,
    locationName: z.string(),
    currency: z.literal("USD"),
    guestCount: z.number().int().nonnegative(),
    grossSalesMinor: Minor,
    discountsMinor: Minor,
    compsMinor: Minor,
    netSalesMinor: Minor,
    salesTaxMinor: Minor,
    marketplaceTaxMinor: Minor,
    tipsMinor: Minor,
    giftCardsSoldMinor: Minor,
    giftCardsRedeemedMinor: Minor,
    categories: z.array(z.object({
      category: z.string(),
      salesGroup: z.enum(["food", "beverage", "alcohol", "merchandise", "other"]),
      grossMinor: Minor,
      discountsMinor: Minor,
      compsMinor: Minor,
      netMinor: Minor,
    })),
    deliverySales: z.array(z.object({ platform: z.string(), label: z.string(), netMinor: Minor, tipsMinor: Minor })),
  })),
});

export const DemoPosPayments = z.object({
  days: z.array(z.object({
    ...day,
    payments: z.array(z.object({
      type: z.enum(["cash", "visa", "mastercard", "amex", "discover", "delivery_platform"]),
      label: z.string(),
      platform: z.string().optional(),
      amountMinor: Minor,
    })),
  })),
});

export const DemoPosAdjustments = z.object({
  days: z.array(z.object({
    ...day,
    discounts: z.array(ReasonAmount),
    comps: z.array(ReasonAmount),
    voids: z.array(z.object({ reason: z.string(), count: z.number().int().nonnegative(), amountMinor: Minor })),
  })),
});

export const DemoPosLabour = z.object({
  days: z.array(z.object({
    ...day,
    labour: z.array(z.object({ group: z.enum(["front", "back", "management"]), hours: z.number().nonnegative(), costMinor: Minor })),
    labourCostMinor: Minor,
    labourHours: z.number().nonnegative(),
  })),
});

/** Payouts whose period ends inside the range. */
export const DemoPosDeliveryPayouts = z.object({
  payouts: z.array(z.object({
    platform: z.string(),
    label: z.string(),
    locationKey: PosLocationKey,
    periodStart: DateValue,
    periodEnd: DateValue,
    payoutDate: DateValue,
    status: z.enum(["paid", "pending"]),
    currency: z.literal("USD"),
    lines: z.array(z.object({ type: z.enum(["sales", "tips", "commission", "marketing_fee", "error_charge"]), description: z.string(), amountMinor: Minor })),
    payoutMinor: Minor,
  })),
});

/** Bills dated inside the range. */
export const DemoPosVendorBills = z.object({
  bills: z.array(z.object({
    vendor: z.string(),
    billNumber: z.string(),
    locationKey: PosLocationKey,
    billDate: DateValue,
    dueDate: DateValue,
    currency: z.literal("USD"),
    lines: z.array(z.object({
      itemKey: z.string(),
      description: z.string(),
      costGroup: CostGroup,
      quantity: z.number(),
      unit: StockUnit,
      unitPriceMinor: Minor,
      amountMinor: Minor,
    })),
    totalMinor: Minor,
  })),
});

export const DemoPosStockItems = z.object({
  items: z.array(z.object({ key: z.string(), name: z.string(), costGroup: CostGroup, unit: StockUnit, unitCostMinor: Minor, vendor: z.string() })),
});

/** Counts taken inside the range. The first count on or before `from` is the opening count: ask from one day earlier to get it. */
export const DemoPosStockCounts = z.object({
  counts: z.array(z.object({
    locationKey: PosLocationKey,
    countedOn: DateValue,
    kind: z.enum(["opening", "week_end"]),
    lines: z.array(z.object({
      itemKey: z.string(),
      itemName: z.string(),
      costGroup: CostGroup,
      quantity: z.number(),
      unit: StockUnit,
      unitCostMinor: Minor,
      valueMinor: Minor,
    })),
    byCostGroup: z.array(z.object({ costGroup: CostGroup, valueMinor: Minor })),
    totalValueMinor: Minor,
  })),
});

/**
 * The Demo POS tools: name, what it says about itself, and its input and output shapes.
 * The server registers exactly these. The gateway parses every answer with `output` before
 * anything else looks at it, and drops an answer that does not parse.
 */
export const DEMO_POS_TOOLS = {
  list_locations: { description: "The locations this POS knows, with the key each one is called by.", input: DemoPosNoInput, output: DemoPosLocations },
  get_daily_sales: { description: "Sales totals for each business day and location, by category.", input: DemoPosRangeInput, output: DemoPosDailySales },
  get_payments: { description: "What was taken by each payment type, for each business day and location.", input: DemoPosRangeInput, output: DemoPosPayments },
  get_adjustments: { description: "Discounts, comps and voids with their reasons, for each business day and location.", input: DemoPosRangeInput, output: DemoPosAdjustments },
  get_delivery_payouts: { description: "Delivery platform payouts with their fee lines.", input: DemoPosRangeInput, output: DemoPosDeliveryPayouts },
  get_labour: { description: "Hours and cost of staff by group, for each business day and location.", input: DemoPosRangeInput, output: DemoPosLabour },
  get_vendor_bills: { description: "Supplier bills with their lines.", input: DemoPosRangeInput, output: DemoPosVendorBills },
  get_stock_items: { description: "The stock items this POS tracks.", input: DemoPosNoInput, output: DemoPosStockItems },
  get_stock_counts: { description: "Stock counts taken at close, with their lines.", input: DemoPosRangeInput, output: DemoPosStockCounts },
} as const;
export type DemoPosToolName = keyof typeof DEMO_POS_TOOLS;
export const DEMO_POS_TOOL_NAMES = Object.keys(DEMO_POS_TOOLS) as DemoPosToolName[];
