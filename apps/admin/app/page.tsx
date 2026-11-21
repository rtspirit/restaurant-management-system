"use client";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Heading, Notice, Row, Select } from "@rms/ui";
import { ChangeTable } from "@/components/change-table";
import { ApiError, type FeedItem, apiFetch } from "@/lib/api";

type Page = { items: FeedItem[]; nextBefore: string | null };
type Filters = { tier: string; decision: string };

const query = (f: Filters, before?: string) => {
  const p = new URLSearchParams({ limit: "50" });
  if (f.tier) p.set("tier", f.tier);
  if (f.decision) p.set("decision", f.decision);
  if (before) p.set("before", before);
  return `/admin/feed?${p.toString()}`;
};

export default function FeedPage() {
  const [filters, setFilters] = useState<Filters>({ tier: "", decision: "" });
  const [items, setItems] = useState<FeedItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (f: Filters, before?: string) => {
    setLoading(true);
    setError(null);
    try {
      const page = await apiFetch<Page>(query(f, before));
      setItems((prev) => (before ? [...prev, ...page.items] : page.items));
      setNext(page.nextBefore);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filters);
  }, [load, filters]);

  const onFilter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setFilters({ tier: String(form.get("tier") ?? ""), decision: String(form.get("decision") ?? "") });
  };

  const filtered = filters.tier !== "" || filters.decision !== "";

  return (
    <>
      <Heading level={1} size="page">
        Change feed
      </Heading>
      <form onSubmit={onFilter} aria-label="Filter the feed">
        <Row align="bottom">
          <Select
            id="tier"
            name="tier"
            label="Tier"
            defaultValue=""
            options={[
              { value: "", label: "All tiers" },
              { value: "T0", label: "T0 cosmetic" },
              { value: "T1", label: "T1 minor" },
              { value: "T2", label: "T2 major" },
              { value: "T3", label: "T3 platform" },
            ]}
          />
          <Select
            id="decision"
            name="decision"
            label="Status"
            defaultValue=""
            options={[
              { value: "", label: "Any status" },
              { value: "applied", label: "Applied" },
              { value: "pending_owner", label: "Waiting for owner" },
              { value: "pending_maintainer", label: "Waiting for us" },
              { value: "approved", label: "Approved" },
              { value: "rejected", label: "Rejected" },
            ]}
          />
          <Button type="submit">Apply filters</Button>
        </Row>
      </form>
      {error ? <Notice kind="problem">{error}</Notice> : null}
      {!error && !loading && items.length === 0 ? (
        filtered ? (
          <EmptyState title="Nothing to show">No changes match these filters. Pick another tier or status, or go back to all tiers and any status.</EmptyState>
        ) : (
          <EmptyState title="No changes yet">Every change a restaurant or RMS makes shows here, newest first.</EmptyState>
        )
      ) : null}
      {items.length > 0 ? <ChangeTable items={items} caption="Changes, newest first" /> : null}
      {loading ? <Notice kind="status">Loading...</Notice> : null}
      {next && !loading ? (
        <div>
          <Button onClick={() => void load(filters, next)}>Show older changes</Button>
        </div>
      ) : null}
    </>
  );
}
