// `report_table`: a ReportTable of a named query's rows, with totals of its money and count
// columns. No totals when the rows are already a mix of levels (a `line_kind` or `scope`
// column): adding those up would count things twice.
import type { RunGeneratorInput, SandboxCatalog } from "@rms/contracts";
import { jsx, lit } from "../app-files.js";
import { findColumn, findQuery, formatOf, periodCode } from "./named.js";
import type { Generated } from "./types.js";

type Input = Extract<RunGeneratorInput, { generator: "report_table" }>;

const HIDDEN = new Set(["sort_order", "line_kind", "scope"]);

export const reportTable = (input: Input, catalog: SandboxCatalog, component: string): Generated => {
  const q = findQuery(catalog, input.query);
  const columns = input.columns ? input.columns.map((k) => findColumn(q, k)) : q.columns.filter((c) => !c.key.endsWith("_id") && !HIDDEN.has(c.key)).slice(0, 12);
  const mixed = q.columns.some((c) => c.key === "line_kind" || c.key === "scope");
  const totals = mixed ? [] : columns.filter((c) => c.type === "money" || c.type === "integer");
  const first = columns[0];
  const period = periodCode(q);

  const sdk = ["formatAs", "useNamedQuery", "useRms"];
  if (period.state.length > 0) sdk.push("dateFromToday");
  if (period.pager) sdk.push("addDays", "formatDate");
  const ui = ["Page", "ReportTable", "Skeleton", "Stack"];
  if (period.pager) ui.push("Pager");
  const sorted = (names: string[]) => [...new Set(names)].sort((a, b) => a.localeCompare(b)).join(", ");
  const columnList = columns.map((c) => {
    const format = formatOf(c);
    return `{ key: ${lit(c.key)}, label: ${lit(c.label)}, format: ${lit(format)}, align: ${lit(format === "text" || format === "date" ? "start" : "end")} }`;
  });

  const lines = [
    `// Made by \`rms gen report_table\` for the report ${q.key}. Editable: change anything in this file.`,
    `import { ${sorted(sdk)} } from "@rms/sdk";`,
    `import { ${sorted(ui)} } from "@rms/ui";`,
    ...(period.state.length > 0 ? ['import { useState } from "react";'] : []),
    'import { NoNumbers, Problem } from "../../rms/notices";',
    "",
    `const QUERY = ${lit(q.key)};`,
    `const COLUMNS = [${columnList.join(", ")}] as const;`,
    ...(totals.length > 0
      ? [
          `const TOTALS = [${totals.map((c) => lit(c.key)).join(", ")}] as const;`,
          "",
          "const sum = (rows: Record<string, unknown>[], key: (typeof TOTALS)[number]): number =>",
          "  rows.reduce<number>((total, row) => {",
          "    const value = row[key];",
          '    return total + (typeof value === "number" ? value : 0);',
          "  }, 0);",
        ]
      : []),
    "",
    `export function ${component}() {`,
    "  const rms = useRms();",
    ...period.state,
    `  const report = useNamedQuery(QUERY, ${period.params});`,
    "",
    "  return (",
    `    <Page title=${jsx(input.title)}${period.pager ? ` actions={${period.pager}}` : ""}>`,
    '      <Stack gap="m">',
    "        <Problem error={report.error} />",
    "        {report.loading && report.data === null ? (",
    '          <Skeleton shape="block" label="Loading the report" />',
    "        ) : report.rows.length === 0 ? (",
    `          <NoNumbers what=${jsx(q.name.toLowerCase())} />`,
    "        ) : (",
    "          <ReportTable",
    `            title=${jsx(q.name)}`,
    `            source=${jsx(`From your books: ${q.name.toLowerCase()}.`)}`,
    "            columns={COLUMNS.map((c) => ({ key: c.key, label: c.label, align: c.align }))}",
    "            rows={report.rows.map((row, i) => ({ id: String(i), cells: Object.fromEntries(COLUMNS.map((c) => [c.key, formatAs(row[c.key], c.format, rms)])) }))}",
    ...(totals.length > 0 && first
      ? [
          `            total={{ ${lit(first.key)}: "Total", ...Object.fromEntries(TOTALS.map((key) => [key, formatAs(sum(report.rows, key), COLUMNS.find((c) => c.key === key)?.format ?? "number", rms)])) }}`,
        ]
      : []),
    "          />",
    "        )}",
    "      </Stack>",
    "    </Page>",
    "  );",
    "}",
    "",
  ];
  const notes = [`The table shows ${columns.length} columns of ${q.key}.`];
  if (mixed) notes.push("No total line: this report's rows are already a mix of lines and totals.");
  return { code: lines.join("\n"), notes };
};
