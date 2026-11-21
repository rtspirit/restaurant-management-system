"use client";
import { useCallback, useEffect, useState } from "react";
import { ChangeTable } from "@/components/change-table";
import { ApiError, type FeedItem, apiFetch } from "@/lib/api";

export default function QueuePage() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems((await apiFetch<{ items: FeedItem[] }>("/admin/queue")).items);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (item: FeedItem, decision: "approve" | "reject") => {
    setBusy(item.id);
    setError(null);
    setStatus(null);
    try {
      const note = notes[item.id]?.trim();
      await apiFetch(`/admin/changes/${item.id}/decision`, { method: "POST", body: note ? { decision, note } : { decision } });
      setStatus(`${decision === "approve" ? "Approved" : "Rejected"}: ${item.restaurantName}, ${item.summary}`);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <main>
      <h1>Review queue</h1>
      <p>Changes held until a maintainer approves them, oldest first.</p>
      {status ? <p role="status">{status}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!error && !loading && items.length === 0 ? <p>Nothing is waiting for review.</p> : null}
      {items.length > 0 ? (
        <ChangeTable
          items={items}
          caption="Waiting for a maintainer"
          actions={(item) => (
            <fieldset disabled={busy !== null}>
              <legend>Decide on this change</legend>
              <label htmlFor={`note-${item.id}`}>Note (optional)</label>
              <br />
              <textarea
                id={`note-${item.id}`}
                maxLength={1000}
                value={notes[item.id] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [item.id]: e.target.value }))}
              />
              <br />
              {item.mismatch ? (
                <p>This change does not match its rules, so it can only be rejected.</p>
              ) : (
                <>
                  <button type="button" onClick={() => void decide(item, "approve")}>
                    Approve
                  </button>{" "}
                </>
              )}
              <button type="button" onClick={() => void decide(item, "reject")}>
                Reject
              </button>
            </fieldset>
          )}
        />
      ) : null}
      {loading ? <p aria-live="polite">Loading...</p> : null}
    </main>
  );
}
