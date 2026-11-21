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
  /**
   * A phone has room for the row's name and one or two short columns. under-name moves
   * this column's value to a labelled line under the row's name there ("Started: 17 Mar 2025"),
   * so it is read in full instead of scrolled to. under-name-bare does the same and leaves the
   * label to screen readers, for a value that says what it is by itself (an email, a phone number).
   * column, the default, keeps it a column.
   */
  onPhone?: "column" | "under-name" | "under-name-bare";
};

export type DataTableRow = {
  id: string;
  cells: Record<string, ReactNode>;
  /** A quieter second line under the row's name: what kind of thing it is, or who. */
  subtitle?: ReactNode;
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

const filled = (value: ReactNode): boolean => value !== undefined && value !== null && value !== "" && value !== false;

/** Marks a cell whose column sits under the row's name on a phone, so the stylesheet can take the column away there. */
const phoneAttr = (column: DataTableColumn) => (column.onPhone === "under-name" || column.onPhone === "under-name-bare" ? "under-name" : undefined);

/**
 * Rows and columns. The first column names the row. Wide tables scroll sideways inside
 * their own box, so the page never does.
 */
export function DataTable({ caption, columns, rows, total, density, sort, onSort }: DataTableProps) {
  const [first, ...others] = columns;
  if (!first) return null;
  const underName = others.filter((column) => phoneAttr(column) !== undefined);

  return (
    <div className="rms-table-wrap" data-density={density} role="region" aria-label={caption} tabIndex={0}>
      <table className="rms-table">
        <caption className="rms-sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const sorted = sort?.key === column.key ? sort.direction : undefined;
              return (
                <th
                  key={column.key}
                  scope="col"
                  data-align={column.align ?? "start"}
                  data-strong={column.strong || undefined}
                  data-phone={phoneAttr(column)}
                  aria-sort={sorted}
                >
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
                {filled(row.subtitle) ? <span className="rms-table__sub">{row.subtitle}</span> : null}
                {underName.map((column) =>
                  filled(row.cells[column.key]) ? (
                    <span key={column.key} className="rms-table__sub rms-table__sub--phone">
                      <span className={column.onPhone === "under-name-bare" ? "rms-sr-only" : undefined}>{column.label}: </span>
                      {row.cells[column.key]}
                    </span>
                  ) : null,
                )}
              </th>
              {others.map((column) => (
                <td key={column.key} data-align={column.align ?? "start"} data-strong={column.strong || undefined} data-phone={phoneAttr(column)}>
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
                <td key={column.key} data-align={column.align ?? "start"} data-strong={column.strong || undefined} data-phone={phoneAttr(column)}>
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
