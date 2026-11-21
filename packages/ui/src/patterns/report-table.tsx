import type { ReactNode } from "react";
import { Card } from "../components/card";
import { DataTable, type DataTableProps } from "../components/data-table";
import { Heading } from "../components/text";

export type ReportTableProps = Omit<DataTableProps, "caption" | "density"> & {
  /** What the report is: "Sales by day". Also names the table for screen readers. */
  title: string;
  titleLevel?: 2 | 3;
  /** Controls for the period, such as a Pager. */
  controls?: ReactNode;
  /** Where the numbers came from and what was assumed, in one or two plain sentences. */
  source?: string;
};

/**
 * Pattern: report table. Always the compact density: 36px rows, 15px figures, figures
 * right-aligned in tabular numerals, the total under a heavy ink rule, and a line saying
 * where the numbers came from.
 */
export function ReportTable({ title, titleLevel = 2, controls, source, ...table }: ReportTableProps) {
  return (
    <Card density="compact" as="section">
      <header className="rms-report__head">
        <Heading level={titleLevel} size="card">
          {title}
        </Heading>
        {controls}
      </header>
      <DataTable {...table} caption={title} density="compact" />
      {source ? <p className="rms-report__source">{source}</p> : null}
    </Card>
  );
}
