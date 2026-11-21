import type { ReactNode } from "react";
import { Icon } from "../icons";

export type DataTableColumn = {
  key: string;
  label: string;
  /** end for money and counts, so figures line up on the right. */
  align?: "start" | "end";
  /** Heavy figures for the column that matters most. */
  strong?: boolean;
  /** Lets the owner sort by this column. Needs `onSort` on the table. */
  sortable?: boolean;
};

export type DataTableRow = {
  id: string;
  cells: Record<string, ReactNode>;
};

export type DataTableSort = { key: string; direction: "ascending" | "descending" };

export type DataTableProps = {
  /** Names the table for screen readers. Not shown. */
  caption: string;
  columns: DataTableColumn[];
  rows: DataTableRow[];
  /** A totals row under a heavy ink rule. Keys match the columns. */
  total?: Record<string, ReactNode>;
  /** compact is 36px rows for reports and feeds. comfortable is 52px. Inherits when left out. */
  density?: "comfortable" | "compact";
  sort?: DataTableSort;
  onSort?: (key: string) => void;
};

/**
 * Rows and columns. The first column names the row. Wide tables scroll sideways inside
 * their own box, so the page never does.
 */
export function DataTable({ caption, columns, rows, total, density, sort, onSort }: DataTableProps) {
  const [first, ...others] = columns;
  if (!first) return null;

  return (
    <div className="rms-table-wrap" data-density={density} role="region" aria-label={caption} tabIndex={0}>
      <table className="rms-table">
        <caption className="rms-sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const sorted = sort?.key === column.key ? sort.direction : undefined;
              return (
                <th key={column.key} scope="col" data-align={column.align ?? "start"} data-strong={column.strong || undefined} aria-sort={sorted}>
                  {column.sortable && onSort ? (
                    <button type="button" className="rms-table__sort" onClick={() => onSort(column.key)}>
                      {column.label}
                      <Icon name={sorted === "ascending" ? "sortUp" : sorted === "descending" ? "sortDown" : "sort"} size="s" />
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row" data-align={first.align ?? "start"}>
                {row.cells[first.key]}
              </th>
              {others.map((column) => (
                <td key={column.key} data-align={column.align ?? "start"} data-strong={column.strong || undefined}>
                  {row.cells[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {total ? (
          <tfoot>
            <tr>
              <th scope="row" data-align={first.align ?? "start"}>
                {total[first.key]}
              </th>
              {others.map((column) => (
                <td key={column.key} data-align={column.align ?? "start"} data-strong={column.strong || undefined}>
                  {total[column.key]}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
