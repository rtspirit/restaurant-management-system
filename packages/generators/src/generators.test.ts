import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunGeneratorInput } from "@rms/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./cli.js";
import { lookupCatalog, runGenerator, uiCatalog } from "./index.js";
import { readScreens } from "./screens-list.js";
import { catalogFor, demoCatalog, writeCatalog } from "./testing/fixtures.js";

const WELCOME_LIST = `import type { ComponentType } from "react";
import { Welcome } from "./welcome";

export type Screen = { name: string; title: string; component: ComponentType };

export const screens: Screen[] = [{ name: "welcome", title: "Welcome", component: Welcome }];
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "h-gen-"));
  mkdirSync(join(dir, "src/screens/welcome"), { recursive: true });
  writeFileSync(join(dir, "src/screens/index.ts"), WELCOME_LIST);
  writeCatalog(dir, demoCatalog());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const golden = (name: string) => join(import.meta.dirname, "..", "golden", `${name}.tsx.golden`);
const read = (rel: string) => readFileSync(join(dir, rel), "utf8");

const CASES: Array<[string, RunGeneratorInput]> = [
  ["list_detail-vendor-form", { generator: "list_detail", screen: "vendors", title: "Vendors", model: "vendor", form: true }],
  ["list_detail-vendor-read", { generator: "list_detail", screen: "vendors", title: "Vendors", model: "vendor", fields: ["name", "phone", "terms_days"], form: false }],
  ["list_detail-bills-read", { generator: "list_detail", screen: "bills", title: "Bills", model: "vendor_bill", form: false }],
  ["form-vendor", { generator: "form", screen: "add-vendor", title: "Add a vendor", model: "vendor", fields: ["name", "phone", "terms_days", "active"] }],
  [
    "dashboard-prime-cost",
    {
      generator: "dashboard",
      screen: "money",
      title: "Money",
      query: "prime_cost_by_week",
      stats: [
        { label: "Prime cost", column: "prime_cost_pct", format: "percent" },
        { label: "Net sales", column: "net_sales", format: "money" },
        { label: "Staff cost", column: "labour", format: "money" },
      ],
      chart: { label: "Net sales by week", category: "week_start", value: "net_sales", format: "money" },
    },
  ],
  ["dashboard-weekly-pnl", { generator: "dashboard", screen: "week", title: "This week", query: "weekly_pnl", stats: [{ label: "Amount", column: "amount", format: "money" }] }],
  ["report_table-sales-by-day", { generator: "report_table", screen: "sales", title: "Sales", query: "sales_by_day" }],
  ["report_table-weekly-pnl", { generator: "report_table", screen: "pnl", title: "Profit and loss", query: "weekly_pnl" }],
  ["report_table-prime-cost", { generator: "report_table", screen: "prime-cost", title: "Prime cost", query: "prime_cost_by_week", columns: ["week_start", "location_name", "net_sales", "prime_cost", "prime_cost_pct"] }],
];

describe("generators: golden files against the real library", () => {
  it.each(CASES)("%s", async (name, input) => {
    const out = await runGenerator(dir, input);
    expect(out.ok, out.notes.join(" ")).toBe(true);
    expect(out.route).toBe(`/${input.screen}`);
    expect(out.files.map((f) => f.path)).toEqual([`src/screens/${input.screen}/index.tsx`, "src/screens/index.ts"]);
    await expect(read(`src/screens/${input.screen}/index.tsx`)).toMatchFileSnapshot(golden(name));
  });
});

describe("the screen list", () => {
  it("adds the screen, drops the starter screen, and keeps order on the next run", async () => {
    await runGenerator(dir, CASES[0]![1]);
    await runGenerator(dir, CASES[6]![1]);
    expect((await readScreens(dir)).map((s) => [s.name, s.title, s.component, s.from])).toEqual([
      ["vendors", "Vendors", "VendorsScreen", "./vendors"],
      ["sales", "Sales", "SalesScreen", "./sales"],
    ]);
    const again = await runGenerator(dir, { ...CASES[0]![1], title: "Suppliers" } as RunGeneratorInput);
    expect(again.files[0]?.change).toBe("update");
    expect((await readScreens(dir)).map((s) => s.title)).toEqual(["Suppliers", "Sales"]);
    await expect(read("src/screens/index.ts")).toMatchFileSnapshot(golden("screens-index"));
  });

  it("refuses a screen list it cannot read, and writes nothing", async () => {
    writeFileSync(join(dir, "src/screens/index.ts"), "export const screens = makeScreens();\n");
    const out = await runGenerator(dir, CASES[0]![1]);
    expect(out.ok).toBe(false);
    expect(out.notes[0]).toMatch(/screen list/);
  });

  it("puts titles into code as data", async () => {
    const out = await runGenerator(dir, { generator: "list_detail", screen: "x", title: 'A"}); fetch("//evil', model: "vendor", form: false });
    expect(out.ok).toBe(true);
    expect(read("src/screens/x/index.tsx")).toContain(String.raw`title={"A\"}); fetch(\"//evil"}`);
    expect(read("src/screens/x/index.tsx")).not.toMatch(/title="A/);
    expect(read("src/screens/index.ts")).toContain(String.raw`title: "A\"}); fetch(\"//evil"`);
  });
});

describe("refusals", () => {
  const refuse: Array<[string, RunGeneratorInput, RegExp]> = [
    ["a model not in the catalog", { generator: "list_detail", screen: "staff", title: "Staff", model: "staff_shift", form: false }, /not in this mini-app's catalog/],
    ["a field the model does not have", { generator: "list_detail", screen: "v", title: "V", model: "vendor", fields: ["password"], form: false }, /no field "password"/],
    ["a form without write access", { generator: "list_detail", screen: "b", title: "Bills", model: "vendor_bill", form: true }, /may only read/],
    ["an add form without write access", { generator: "form", screen: "b", title: "Bills", model: "vendor_bill" }, /may only read/],
    ["a report not in the catalog", { generator: "report_table", screen: "r", title: "R", query: "stock_on_hand" }, /not a report this mini-app can use/],
    ["a column the report does not have", { generator: "dashboard", screen: "d", title: "D", query: "sales_by_day", stats: [{ label: "X", column: "profit", format: "money" }] }, /no column "profit"/],
  ];
  it.each(refuse)("refuses %s, and writes nothing", async (_n, input, why) => {
    const out = await runGenerator(dir, input);
    expect(out.ok).toBe(false);
    expect(out.files).toEqual([]);
    expect(out.notes.join(" ")).toMatch(why);
    expect(existsSync(join(dir, `src/screens/${input.screen}`))).toBe(false);
    expect(read("src/screens/index.ts")).toBe(WELCOME_LIST);
  });

  it("refuses a report that needs a value it cannot choose", async () => {
    writeCatalog(dir, catalogFor({ extraQueries: [{ kind: "named_query", key: "by_vendor", name: "By vendor", description: "x", params: [{ key: "vendor_id", type: "uuid", required: true }], columns: [{ key: "n", label: "N", type: "integer" }] }] }));
    const out = await runGenerator(dir, { generator: "report_table", screen: "r", title: "R", query: "by_vendor" });
    expect(out.ok).toBe(false);
    expect(out.notes[0]).toMatch(/needs "vendor_id"/);
  });

  it("refuses when there is no catalog file", async () => {
    rmSync(join(dir, ".rms"), { recursive: true });
    const out = await runGenerator(dir, CASES[0]![1]);
    expect(out.ok).toBe(false);
    expect(out.notes[0]).toMatch(/no catalog file/);
  });

  it("never writes through a link out of the screens folder", async () => {
    mkdirSync(join(dir, "src/rms"), { recursive: true });
    symlinkSync(join(dir, "src/rms"), join(dir, "src/screens/vendors"));
    const out = await runGenerator(dir, CASES[0]![1]);
    expect(out.ok).toBe(false);
    expect(existsSync(join(dir, "src/rms/index.tsx"))).toBe(false);
  });
});

describe("the rms command", () => {
  it("runs the short form of gen and prints one JSON object", async () => {
    const out = await main(["gen", "list_detail", "--model", "vendor", "--screen", "vendors", "--title", "Vendors", "--form"], dir);
    expect(out.code).toBe(0);
    expect(out.body).toMatchObject({ ok: true, route: "/vendors" });
  });

  it("answers 1 when the tool says no and 2 when the input does not parse", async () => {
    expect((await main(["gen", "list_detail", "--model", "nope", "--screen", "x", "--title", "X"], dir)).code).toBe(1);
    expect((await main(["gen", "--json", "{not json"], dir)).code).toBe(2);
    expect((await main(["gen", "--json", JSON.stringify({ generator: "list_detail", screen: "Bad Name", title: "X", model: "vendor" })], dir)).code).toBe(2);
    expect((await main(["gen", "--json", JSON.stringify({ generator: "list_detail", screen: "x", title: "X", model: "vendor", extra: 1 })], dir)).code).toBe(2);
    expect((await main(["catalog", "everything"], dir)).code).toBe(2);
    expect((await main(["explode"], dir)).code).toBe(2);
  });

  it("looks things up", async () => {
    const models = await lookupCatalog(dir, { kind: "models", search: "buys from" });
    expect(models.entries.map((e) => ("ref" in e ? e.ref : ""))).toEqual(["vendor"]);
    const one = await lookupCatalog(dir, { kind: "named_queries", name: "prime_cost_by_week" });
    expect(one.entries).toHaveLength(1);
    expect((await main(["catalog", "patterns"], dir)).body).toMatchObject({ ok: true, kind: "patterns" });
    const gens = await lookupCatalog(dir, { kind: "generators" });
    expect(gens.entries.map((e) => ("name" in e ? e.name : ""))).toEqual(["list_detail", "form", "dashboard", "report_table"]);
  });

  it("describes the four patterns and every generator with an example input that parses", async () => {
    const { RunGeneratorInput } = await import("@rms/contracts");
    const ui = uiCatalog();
    expect(ui.patterns.map((p) => p.name).sort()).toEqual(["Dashboard", "FormLayout", "ListDetail", "ReportTable"]);
    for (const g of ui.generators) expect(RunGeneratorInput.safeParse(JSON.parse(g.example)).success, g.name).toBe(true);
  });
});
