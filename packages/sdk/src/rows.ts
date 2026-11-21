// Picking rows out of a report, for figures that must not mix levels or count a week that has
// not finished yet.

type ReportRow = Record<string, unknown>;

/**
 * Rows that cover every location together. A report with a `scope` column (such as
 * `prime_cost_by_week`) has one row per location AND one for all locations: adding or charting
 * both counts things twice. Rows without a `scope` are kept as they are.
 */
export const allLocationsRows = <R extends ReportRow>(rows: R[]): R[] =>
  rows.some((r) => "scope" in r) ? rows.filter((r) => r.scope === "all_locations") : rows;

/**
 * The last row whose week ended before `today` ("YYYY-MM-DD"), so a headline is never the
 * unfinished current week. Without a `week_end` column, the last row.
 */
export const lastFinishedRow = <R extends ReportRow>(rows: R[], today: string): R | undefined => {
  if (!rows.some((r) => typeof r.week_end === "string")) return rows[rows.length - 1];
  let best: R | undefined;
  for (const r of rows) {
    const end = r.week_end;
    if (typeof end === "string" && end < today && (best === undefined || end >= String(best.week_end))) best = r;
  }
  return best;
};
