"use client";
import { type FormEvent, useCallback, useEffect, useState } from "react";
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

  return (
    <main>
      <h1>Change feed</h1>
      <form onSubmit={onFilter} aria-label="Filter the feed">
        <label htmlFor="tier">Tier</label>{" "}
        <select id="tier" name="tier" defaultValue="">
          <option value="">All tiers</option>
          <option value="T0">T0 cosmetic</option>
          <option value="T1">T1 minor</option>
          <option value="T2">T2 major</option>
          <option value="T3">T3 platform</option>
        </select>{" "}
        <label htmlFor="decision">Status</label>{" "}
        <select id="decision" name="decision" defaultValue="">
          <option value="">Any status</option>
          <option value="applied">Applied</option>
          <option value="pending_owner">Waiting for owner</option>
          <option value="pending_maintainer">Waiting for us</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>{" "}
        <button type="submit">Apply filters</button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {!error && !loading && items.length === 0 ? <p>No changes match these filters.</p> : null}
      {items.length > 0 ? <ChangeTable items={items} caption="Changes, newest first" /> : null}
      {loading ? <p aria-live="polite">Loading...</p> : null}
      {next && !loading ? (
        <button type="button" onClick={() => void load(filters, next)}>
          Show older changes
        </button>
      ) : null}
    </main>
  );
}
