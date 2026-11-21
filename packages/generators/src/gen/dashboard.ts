// `dashboard`: big figures from a named query, with an optional bar chart from the same rows.
// The figures show the LAST row (the latest period); the chart shows every row.
import type { RunGeneratorInput, SandboxCatalog } from "@rms/contracts";
import { jsx, lit } from "../app-files.js";
import { findColumn, findQuery, formatOf, periodCode } from "./named.js";
import type { Generated } from "./types.js";

type Input = Extract<RunGeneratorInput, { generator: "dashboard" }>;

export const dashboard = (input: Input, catalog: SandboxCatalog, component: string): Generated => {
  const q = findQuery(catalog, input.query);
  for (const s of input.stats) findColumn(q, s.column);
  const chartCategory = input.chart ? findColumn(q, input.chart.category) : null;
  if (input.chart) findColumn(q, input.chart.value);
  const period = periodCode(q);
  const [lead, ...others] = input.stats;

  const sdk = ["formatAs", "useNamedQuery", "useRms"];
  if (period.state.length > 0) sdk.push("dateFromToday");
  if (period.pager) sdk.push("addDays", "formatDate");
  const ui = ["Card", "Dashboard", "Skeleton", "StatLead"];
  if (others.length > 0) ui.push("Stat", "StatGroup");
  if (input.chart) ui.push("BarChart");
  if (period.pager) ui.push("Pager");
  const react = period.state.length > 0 ? ['import { useState } from "react";'] : [];
  const sorted = (names: string[]) => [...new Set(names)].sort((a, b) => a.localeCompare(b)).join(", ");

  const lines = [
    `// Made by \`rms gen dashboard\` for the report ${q.key}. Editable: change anything in this file.`,
    "// The figures show the latest row of the report. The chart shows every row.",
    `import { ${sorted(sdk)} } from "@rms/sdk";`,
    `import { ${sorted(ui)} } from "@rms/ui";`,
    ...react,
    'import { NoNumbers, Problem } from "../../rms/notices";',
    "",
    `const QUERY = ${lit(q.key)};`,
    ...(others.length > 0 ? [`const STATS = [${others.map((s) => `{ label: ${lit(s.label)}, column: ${lit(s.column)}, format: ${lit(s.format)} }`).join(", ")}] as const;`] : []),
    "",
    `export function ${component}() {`,
    "  const rms = useRms();",
    ...period.state,
    `  const report = useNamedQuery(QUERY, ${period.params});`,
    "  const latest = report.rows[report.rows.length - 1];",
    "",
    "  return (",
    `    <Dashboard title=${jsx(input.title)}${period.pager ? ` controls={${period.pager}}` : ""}>`,
    "      <Problem error={report.error} />",
    "      {report.loading && report.data === null ? (",
    `        <Skeleton shape="block" label="Loading the numbers" />`,
    "      ) : latest === undefined ? (",
    '        <NoNumbers what="numbers" />',
    "      ) : (",
    "        <>",
    "          <Card>",
    `            <StatLead label=${jsx(lead?.label ?? "")} value={formatAs(latest[${lit(lead?.column ?? "")}], ${lit(lead?.format ?? "text")}, rms)} />`,
    "          </Card>",
    ...(others.length > 0
      ? [
          "          <Card>",
          "            <StatGroup>",
          "              {STATS.map((s) => (",
          "                <Stat key={s.column} label={s.label} value={formatAs(latest[s.column], s.format, rms)} />",
          "              ))}",
          "            </StatGroup>",
          "          </Card>",
        ]
      : []),
    ...(input.chart && chartCategory
      ? [
          `          <Card title=${jsx(input.chart.label)}>`,
          "            <BarChart",
          `              label=${jsx(input.chart.label)}`,
          "              items={report.rows.map((row, i) => ({",
          "                id: String(i),",
          `                label: formatAs(row[${lit(chartCategory.key)}], ${lit(formatOf(chartCategory))}, rms),`,
          `                value: Number(row[${lit(input.chart.value)}]) || 0,`,
          `                display: formatAs(row[${lit(input.chart.value)}], ${lit(input.chart.format)}, rms),`,
          "              }))}",
          "            />",
          "          </Card>",
        ]
      : []),
    "        </>",
    "      )}",
    "    </Dashboard>",
    "  );",
    "}",
    "",
  ];
  return { code: lines.join("\n"), notes: [`The figures read the latest row of ${q.key}. If the owner means a total or another row, change how \`latest\` is chosen.`] };
};
