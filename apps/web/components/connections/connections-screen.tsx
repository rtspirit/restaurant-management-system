"use client";

// Connected systems: connect Demo POS, allow what RMS will read, bring in the sales.
// Plain words only. No addresses, no tool names, no tokens: tools are shown by their description.
// Everything a connected system says about itself (its descriptions) is shown as plain text, never as markup.
import { useCallback, useEffect, useState } from "react";
import { ApiError, CONNECTION_ROUTES, ConnectionView, McpCatalogEntry, SyncResult } from "@rms/contracts";
import { BulletList, Button, Card, EmptyState, Notice, Row, Skeleton, Stack, Tag, Text } from "@rms/ui";
import { SignedOutError, apiFetch, signOutAndGoToSignIn } from "@/lib/api";

const DEMO_POS_KEY = "demo_pos";
const SOMETHING_WRONG = "Something went wrong. Please try again.";

/**
 * A connection plus `toolsVersion`, the version of the tool list on screen. Allow sends it back,
 * so the owner can only ever allow the list they were shown. (Not yet in the shared contract.)
 */
type View = ConnectionView & { toolsVersion: string | null };
const parseView = (body: unknown): View => {
  const raw = (body ?? {}) as { toolsVersion?: unknown };
  return { ...ConnectionView.parse(body), toolsVersion: typeof raw.toolsVersion === "string" ? raw.toolsVersion : null };
};

type Loaded = { entries: McpCatalogEntry[]; connections: View[] };

const path = (route: string, connectionId: string) => route.replace(":connectionId", encodeURIComponent(connectionId));

/** Calls the API and returns the parsed body, or throws an Error whose message is plain words. */
async function send<T>(route: string, parse: (body: unknown) => T, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(route, init);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ApiError.safeParse(body);
    throw new Error(err.success ? err.data.error.message : SOMETHING_WRONG);
  }
  return parse(body);
}

const loadAll = async (): Promise<Loaded> => {
  const [catalog, list] = await Promise.all([
    send(CONNECTION_ROUTES.catalog, (b) => McpCatalogEntry.array().parse((b as { entries: unknown }).entries)),
    send(CONNECTION_ROUTES.list, (b) => {
      const list = (b as { connections: unknown }).connections;
      return (Array.isArray(list) ? list : []).map(parseView);
    }),
  ]);
  return { entries: catalog, connections: list };
};

export function ConnectionsScreen() {
  const [data, setData] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<"connect" | "allow" | "not_now" | "sync" | "disconnect" | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);

  const run = useCallback(async (what: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(what);
    setProblem(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof SignedOutError) {
        await signOutAndGoToSignIn();
        return;
      }
      setProblem(e instanceof Error && e.message ? e.message : SOMETHING_WRONG);
    } finally {
      setBusy(null);
    }
  }, []);

  const refresh = useCallback(async () => setData(await loadAll()), []);

  useEffect(() => {
    let live = true;
    loadAll()
      .then((d) => live && setData(d))
      .catch(async (e: unknown) => {
        if (e instanceof SignedOutError) return signOutAndGoToSignIn();
        if (live) setProblem(e instanceof Error && e.message ? e.message : SOMETHING_WRONG);
      });
    return () => {
      live = false;
    };
  }, []);

  if (!data) {
    return problem ? <Notice kind="problem">{problem}</Notice> : <Skeleton shape="block" label="Loading your connected systems" />;
  }

  const entry = data.entries.find((e) => e.key === DEMO_POS_KEY);
  const conn = data.connections.find((c) => c.catalogKey === DEMO_POS_KEY);
  if (!entry) return <EmptyState title="No systems to connect yet">When there is a system you can connect, it will show here.</EmptyState>;

  const connect = () =>
    run("connect", async () => {
      await send(CONNECTION_ROUTES.connect, ConnectionView.parse, { method: "POST", body: JSON.stringify({ kind: "catalog", key: DEMO_POS_KEY }) });
      setResult(null);
      await refresh();
    });
  const allow = (c: View) =>
    run("allow", async () => {
      await send(path(CONNECTION_ROUTES.approve, c.id), parseView, {
        method: "POST",
        body: JSON.stringify({ tools: c.tools.map((t) => t.name), toolsVersion: c.toolsVersion }),
      });
      await refresh();
    });
  const switchOff = (c: ConnectionView, what: "not_now" | "disconnect") =>
    run(what, async () => {
      await send(path(CONNECTION_ROUTES.disconnect, c.id), ConnectionView.parse, { method: "POST" });
      setResult(null);
      await refresh();
    });
  const bringIn = (c: ConnectionView) =>
    run("sync", async () => {
      setResult(null);
      setResult(await send(path(CONNECTION_ROUTES.sync, c.id), SyncResult.parse, { method: "POST", body: "{}" }));
      await refresh();
    });

  return (
    <Stack gap="l">
      {problem ? <Notice kind="problem">{problem}</Notice> : null}

      {!conn ? (
        <Card title={entry.name} titleLevel={2} as="article" action={<Tag>{entry.category}</Tag>}>
          <Stack gap="m">
            <Text tone="muted">{entry.description}</Text>
            <Row justify="end">
              <Button icon="plus" busy={busy === "connect"} onClick={connect}>
                Connect {entry.name}
              </Button>
            </Row>
          </Stack>
        </Card>
      ) : conn.status === "needs_approval" ? (
        <Card title={`${conn.name} wants to share`} titleLevel={2} as="article">
          <Stack gap="m">
            <Text>{conn.statusText}</Text>
            <Text strong>RMS will read:</Text>
            <BulletList items={conn.tools.filter((t) => t.readOnly).map((t) => t.description)} />
            {conn.tools.some((t) => !t.readOnly) ? <Text tone="muted">RMS will not use anything that changes your {conn.name}.</Text> : null}
            <Row justify="end">
              <Button variant="quiet" busy={busy === "not_now"} onClick={() => switchOff(conn, "not_now")}>
                Not now
              </Button>
              <Button busy={busy === "allow"} onClick={() => allow(conn)}>
                Allow
              </Button>
            </Row>
          </Stack>
        </Card>
      ) : conn.status === "error" ? (
        <Card title={conn.name} titleLevel={2} as="article" action={<Tag>Needs attention</Tag>}>
          <Stack gap="m">
            <Text>This connection needs attention. Connect it again to carry on.</Text>
            <Row justify="end">
              <Button busy={busy === "connect"} onClick={connect}>
                Connect again
              </Button>
            </Row>
          </Stack>
        </Card>
      ) : (
        <Card title={conn.name} titleLevel={2} as="article" action={<Tag weight="outline">Connected</Tag>}>
          <Stack gap="m">
            <Text tone="muted">{conn.statusText}</Text>
            {busy === "sync" ? <Notice kind="status">Bringing in your sales. This takes a few seconds.</Notice> : null}
            {result && busy !== "sync" ? <Notice kind={result.status === "failed" ? "problem" : "status"}>{result.message}</Notice> : null}
            <Row justify="between">
              <Button variant="quiet" busy={busy === "disconnect"} onClick={() => switchOff(conn, "disconnect")}>
                Disconnect
              </Button>
              {conn.canSync ? (
                <Button busy={busy === "sync"} onClick={() => bringIn(conn)}>
                  Bring in my sales
                </Button>
              ) : null}
            </Row>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
