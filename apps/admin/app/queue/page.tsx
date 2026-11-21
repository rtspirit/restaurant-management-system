"use client";
import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, FieldGroup, Heading, Notice, Row, Text, TextArea } from "@rms/ui";
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
    <>
      <Heading level={1} size="page">
        Review queue
      </Heading>
      <Text>Changes held until a maintainer approves them, oldest first.</Text>
      {status ? <Notice kind="status">{status}</Notice> : null}
      {error ? <Notice kind="problem">{error}</Notice> : null}
      {!error && !loading && items.length === 0 ? (
        <EmptyState title="The queue is empty">Nothing is waiting for review. A change that needs a maintainer shows here the moment it is held.</EmptyState>
      ) : null}
      {items.length > 0 ? (
        <ChangeTable
          items={items}
          caption="Waiting for a maintainer"
          actions={(item) => (
            <FieldGroup legend="Decide on this change" disabled={busy !== null}>
              <TextArea
                id={`note-${item.id}`}
                label="Note (optional)"
                maxLength={1000}
                value={notes[item.id] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [item.id]: e.target.value }))}
              />
              {item.mismatch ? <Text strong>This change does not match its rules, so it can only be rejected.</Text> : null}
              <Row>
                {item.mismatch ? null : (
                  <Button variant="primary" onClick={() => void decide(item, "approve")}>
                    Approve
                  </Button>
                )}
                <Button onClick={() => void decide(item, "reject")}>Reject</Button>
              </Row>
            </FieldGroup>
          )}
        />
      ) : null}
      {loading ? <Notice kind="status">Loading...</Notice> : null}
    </>
  );
}
