import type { ReactNode } from "react";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { Icon } from "../icons";

export type ListDetailItem = {
  id: string;
  title: string;
  /** A second line: who, when, or what kind. */
  subtitle?: string;
  /** A figure on the right, already formatted: "$1,284.50". */
  meta?: string;
};

export type ListDetailProps = {
  /** Names the list for screen readers: "Bills". */
  label: string;
  items: ListDetailItem[];
  /** The row that is open. Leave empty to show only the list on a phone. */
  selectedId?: string;
  onSelect: (id: string) => void;
  /** On a phone the detail takes the whole screen. This is the way back. */
  onBack: () => void;
  backLabel?: string;
  /** What to show for the open row. Usually a Card with a DetailList. */
  detail: ReactNode;
  /** Shown in place of the list when there are no rows. Pass an EmptyState. */
  empty?: ReactNode;
};

/**
 * Pattern: list with detail. Rows on the left, the open row on the right. On a phone
 * the list and the detail are separate screens with a way back.
 */
export function ListDetail({ label, items, selectedId, onSelect, onBack, backLabel = "Back to the list", detail, empty }: ListDetailProps) {
  if (items.length === 0 && empty) return <>{empty}</>;

  return (
    <div className="rms-list-detail" data-view={selectedId ? "detail" : "list"}>
      <div className="rms-list-detail__list">
        <Card flush as="div">
          <ul className="rms-list" aria-label={label}>
            {items.map((item) => (
              <li key={item.id} className="rms-list__item">
                <button type="button" className="rms-list__row" aria-current={item.id === selectedId ? "true" : undefined} onClick={() => onSelect(item.id)}>
                  <span>
                    <span className="rms-list__title">{item.title}</span>
                    {item.subtitle ? <span className="rms-list__sub">{item.subtitle}</span> : null}
                  </span>
                  {item.meta ? <span className="rms-list__meta">{item.meta}</span> : <span />}
                  <Icon name="next" />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <div className="rms-list-detail__detail" aria-live="polite">
        <div className="rms-list-detail__back">
          <Button variant="quiet" icon="prev" onClick={onBack}>
            {backLabel}
          </Button>
        </div>
        {detail}
      </div>
    </div>
  );
}

export type DetailListProps = {
  rows: Array<{ label: string; value: ReactNode }>;
};

/** Facts about one thing: a name on the left, its value on the right. */
export function DetailList({ rows }: DetailListProps) {
  return (
    <dl className="rms-detail-list">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
