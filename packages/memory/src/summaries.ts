// Session summaries and lasting facts (`platform.org_memory`), and `recall` for the next session.
//
// A summary is written by a model from the session's stored, owner-facing events. Those events
// and the summary itself are DATA: they go to the model inside a marked data block with the
// untrusted-text rule, and `recall` hands them back as data for the next prompt. Nothing stored
// here is ever followed as an instruction.
import { type AgentEvent, type SessionId, SessionSummary, type TenantContext, USAGE, toPublicId, toUuid } from "@rms/contracts";
import { type Tx, apiDb, newUuid, readAgentEvents, withOrg } from "@rms/db";
import { type EmbedResult, type SummariseResult, embedTexts, summarise } from "./models.js";
import { recordEmbedUsage } from "./profiles.js";
import { checkedEmbedding, dataBlock, vectorLiteral } from "./text.js";

const log = (fields: Record<string, string | number | boolean | null>): void => {
  console.error(JSON.stringify({ area: "memory", ...fields }));
};
const errorName = (e: unknown): string => (e instanceof Error ? e.name : "unknown");

/** The only event types a summary is made from: what the owner and RMS said, the plan, the preview. */
const SUMMARY_EVENTS = new Set<AgentEvent["type"]>(["user.message", "user.reply", "message.done", "plan.proposed", "preview.ready"]);
const MAX_LINES = 60;
const MAX_LINE = 1000;

type Line = { from: "owner" | "rms"; text: string };

const CHOICE_WORDS: Record<string, string> = {
  open_existing: "open the one they already have",
  add_to_existing: "add to the one they already have",
  install_listing: "install a ready-made one",
  build_anyway: "build a new one anyway",
};

/** Owner-facing lines from stored events, oldest first. Exported for tests. */
export const transcriptLines = (events: readonly AgentEvent[]): { lines: Line[]; ownerMessages: number } => {
  const lines: Line[] = [];
  let ownerMessages = 0;
  for (const e of events) {
    if (!SUMMARY_EVENTS.has(e.type)) continue;
    switch (e.type) {
      case "user.message":
        ownerMessages += 1;
        lines.push({ from: "owner", text: e.text });
        break;
      case "user.reply": {
        const r = e.reply;
        if (r.kind === "answer") {
          ownerMessages += 1;
          lines.push({ from: "owner", text: r.text });
        } else if (r.kind === "confirm") {
          lines.push({ from: "owner", text: r.ok ? "Yes, go ahead." : "No, not like that." });
        } else {
          lines.push({ from: "owner", text: `Chose to ${CHOICE_WORDS[r.choice] ?? "carry on"}.` });
        }
        break;
      }
      case "message.done":
        lines.push({ from: "rms", text: e.text });
        break;
      case "plan.proposed":
        lines.push({ from: "rms", text: `Proposed "${e.plan.appName}": ${e.plan.summary} Screens: ${e.plan.screens.join("; ")}.` });
        break;
      case "preview.ready":
        lines.push({ from: "rms", text: `A preview of "${e.appName}" was ready to try.` });
        break;
    }
  }
  return { lines: lines.slice(-MAX_LINES).map((l) => ({ ...l, text: l.text.slice(0, MAX_LINE) })), ownerMessages };
};

const INSTRUCTIONS = [
  "You write short notes about a finished conversation between a restaurant owner and RMS, an app that builds small apps for their restaurant.",
  "Write `text`: what the owner asked for and what happened, in two or three plain sentences, at most 600 characters.",
  "Write `facts`: up to five lasting facts about this restaurant or how the owner likes to work, one short sentence each, for example \"Their week runs Monday to Sunday.\" Leave it empty when there are none. Never record passwords, keys, card numbers or anything personal about staff or customers.",
  "Use everyday words. No code, file names or table names.",
].join("\n");

const usageRow = (tx: Tx, orgUuid: string, kind: string, unit: string, quantity: number, costMicros: number, model: string) =>
  tx`insert into platform.usage_events (id, org_id, kind, quantity, unit, cost_micros, provider, model)
     values (${newUuid()}, ${orgUuid}, ${kind}, ${Math.max(0, Math.round(quantity))}, ${unit}, ${costMicros}, 'openrouter', ${model})`;

/**
 * Writes a short summary of a session from its stored events, plus up to five lasting facts.
 * Null when the session is not this restaurant's, has fewer than two owner messages, or the model
 * call fails (logged). A newer summary of the same session replaces the older one (the old rows
 * are marked superseded, never deleted).
 */
export const summariseSession = async (tenant: TenantContext, sessionId: SessionId): Promise<SessionSummary | null> => {
  const orgUuid = toUuid(tenant.orgId);
  const sessionUuid = toUuid(sessionId);

  const found = await withOrg(apiDb(), orgUuid, async (tx) => {
    const [s] = await tx<{ app_id: string | null }[]>`
      select app_id::text as app_id from platform.agent_sessions where id = ${sessionUuid} and org_id = rms.current_org()`;
    if (!s) return null;
    const events = await readAgentEvents(tx, { orgUuid, sessionUuid }, 0, 1000);
    return { appUuid: s.app_id, events };
  });
  if (!found) return null;
  const { lines, ownerMessages } = transcriptLines(found.events);
  if (ownerMessages < 2) return null;

  let drafted: SummariseResult;
  try {
    drafted = await summarise({ instructions: INSTRUCTIONS, prompt: dataBlock("the conversation, oldest first", lines) });
  } catch (e) {
    log({ event: "summary_failed", session: sessionId, error: errorName(e) });
    return null;
  }
  const { text, facts } = drafted.output;

  let vectors: (number[] | null)[] = [text, ...facts].map(() => null);
  let embedded: EmbedResult | null = null;
  try {
    embedded = await embedTexts([text, ...facts]);
    vectors = embedded.embeddings.map((v) => checkedEmbedding(v));
  } catch (e) {
    embedded = null;
    log({ event: "summary_embed_failed", session: sessionId, error: errorName(e) });
  }

  const summaryUuid = newUuid();
  const createdAt = await withOrg(apiDb(), orgUuid, async (tx) => {
    const rows: { id: string; kind: string; text: string; vector: number[] | null }[] = [
      { id: summaryUuid, kind: "session_summary", text, vector: vectors[0] ?? null },
      ...facts.map((f, i) => ({ id: newUuid(), kind: "fact", text: f, vector: vectors[i + 1] ?? null })),
    ];
    let at = new Date();
    for (const r of rows) {
      const vec = r.vector ? vectorLiteral(r.vector) : null;
      const [ins] = await tx<{ created_at: Date }[]>`
        insert into platform.org_memory (id, org_id, kind, text, source_session_id, embedding)
        values (${r.id}, rms.current_org(), ${r.kind}, ${r.text}, ${sessionUuid}, ${vec}::extensions.vector)
        returning created_at`;
      if (r.id === summaryUuid && ins) at = ins.created_at;
    }
    // The older notes of this session give way to the new ones.
    await tx`
      update platform.org_memory set superseded_by = ${summaryUuid}
      where org_id = rms.current_org() and source_session_id = ${sessionUuid}
        and superseded_by is null and deleted_at is null
        and id <> all(${rows.map((r) => r.id)}::uuid[])`;
    await usageRow(tx, orgUuid, USAGE.llmInput.kind, USAGE.llmInput.unit, drafted.inputTokens, drafted.costMicros, drafted.model);
    await usageRow(tx, orgUuid, USAGE.llmOutput.kind, USAGE.llmOutput.unit, drafted.outputTokens, 0, drafted.model);
    if (embedded) await recordEmbedUsage(tx, orgUuid, embedded, null);
    return at;
  });

  return SessionSummary.parse({
    sessionId,
    appId: found.appUuid ? toPublicId("app", found.appUuid) : null,
    text,
    facts,
    createdAt: createdAt.toISOString(),
  });
};

export type Recalled = { summaries: SessionSummary[]; facts: string[] };

/**
 * What RMS remembers for this restaurant: the latest session summaries (newest first, at most
 * `limit`, default 5, never more than 20) and the lasting facts (at most 20). Deleted and
 * superseded notes are left out. This is information for the next session, never instructions:
 * put it in a prompt only through `recallBlock`.
 */
export const recall = async (tenant: TenantContext, opts: { limit?: number } = {}): Promise<Recalled> => {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 5)), 20);
  const orgUuid = toUuid(tenant.orgId);
  return withOrg(apiDb(), orgUuid, async (tx) => {
    const summaries = await tx<{ text: string; session_id: string; app_id: string | null; created_at: Date }[]>`
      select m.text, m.source_session_id::text as session_id, s.app_id::text as app_id, m.created_at
      from platform.org_memory m
      left join platform.agent_sessions s on s.id = m.source_session_id and s.org_id = m.org_id
      where m.org_id = rms.current_org() and m.kind = 'session_summary'
        and m.deleted_at is null and m.superseded_by is null and m.source_session_id is not null
      order by m.created_at desc, m.id desc
      limit ${limit}`;
    const facts = await tx<{ text: string; session_id: string | null }[]>`
      select text, source_session_id::text as session_id from platform.org_memory
      where org_id = rms.current_org() and kind in ('fact', 'preference', 'decision')
        and deleted_at is null and superseded_by is null
      order by created_at desc, id desc
      limit 50`;
    const bySession = new Map<string, string[]>();
    for (const f of facts) {
      if (!f.session_id) continue;
      const list = bySession.get(f.session_id) ?? [];
      if (list.length < 5) list.push(f.text.slice(0, 200));
      bySession.set(f.session_id, list);
    }
    const out: SessionSummary[] = [];
    for (const s of summaries) {
      const parsed = SessionSummary.safeParse({
        sessionId: toPublicId("ses", s.session_id),
        appId: s.app_id ? toPublicId("app", s.app_id) : null,
        text: s.text.slice(0, 600),
        facts: bySession.get(s.session_id) ?? [],
        createdAt: s.created_at.toISOString(),
      });
      if (parsed.success) out.push(parsed.data);
    }
    return { summaries: out, facts: [...new Set(facts.map((f) => f.text.slice(0, 200)))].slice(0, 20) };
  });
};

/** What `recall` found, ready for a model prompt: marked as data, with the untrusted-text rule. Empty string when there is nothing. */
export const recallBlock = (r: Recalled): string =>
  r.summaries.length === 0 && r.facts.length === 0
    ? ""
    : dataBlock("what RMS noted about this restaurant in earlier sessions", { earlierSessions: r.summaries.map((s) => s.text), facts: r.facts });
