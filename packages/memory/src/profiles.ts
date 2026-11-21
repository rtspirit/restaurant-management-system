// Mini-app profiles and the duplicate check ("you already have this").
//
// Walls, all of them on every call:
//   1. the restaurant comes from the tenant context (a verified session), never from the caller's input
//   2. every read and write runs inside `withOrg(apiDb(), ...)`: row-level security limits the
//      `rms_api` login to that restaurant's rows
//   3. every query also says `org_id = rms.current_org()`
//   4. hidden `system` mini-apps and deleted ones are left out of every comparison, and a
//      `system` mini-app cannot be given a profile
// A similarity score never leaves this file.
import {
  type AppProfileDraft as AppProfileDraftT,
  AppProfileDraft,
  DUPLICATE_THRESHOLDS,
  type DuplicateCheckResult,
  JUDGEMENT_VERDICT,
  type TenantContext,
  USAGE,
  normaliseRequest,
  toPublicId,
  toUuid,
} from "@rms/contracts";
import { type Tx, apiDb, newUuid, withOrg } from "@rms/db";
import { type EmbedResult, type JudgeAnswer, type JudgeResult, embedTexts, embedWithCache, judgeDuplicates } from "./models.js";
import { WORD_OVERLAP_SIMILAR, checkedEmbedding, cosine, dataBlock, mergeRequests, profileText, reasonFor, vectorLiteral, wordOverlap } from "./text.js";

const orgUuidOf = (tenant: TenantContext): string => toUuid(tenant.orgId);

/** One line for the server log. Never a request text, a key or a vector. */
const log = (fields: Record<string, string | number | boolean | null>): void => {
  console.error(JSON.stringify({ area: "memory", ...fields }));
};

const errorName = (e: unknown): string => (e instanceof Error ? e.name : "unknown");

/** Records model use for the restaurant. Inside the same fenced transaction as the write it belongs to. */
export const recordEmbedUsage = async (tx: Tx, orgUuid: string, r: EmbedResult, appUuid: string | null): Promise<void> => {
  await tx`insert into platform.usage_events (id, org_id, kind, quantity, unit, cost_micros, provider, model, app_id)
           values (${newUuid()}, ${orgUuid}, ${USAGE.embedInput.kind}, ${Math.max(0, Math.round(r.tokens))}, ${USAGE.embedInput.unit},
                   ${r.costMicros}, 'openrouter', ${r.model}, ${appUuid})`;
};

type LockedApp = { id: string; kind: string; status: string };
type StoredProfile = { purpose: string; capabilities: string[]; requests: string[] };

/**
 * Makes or refreshes a mini-app's profile. `purpose` and `capabilities` replace what is stored;
 * `requests` are appended (see `mergeRequests`). Then the embedding is made and stored.
 *
 * Two saves at the same moment lose nothing: the first transaction locks the mini-app's row, so
 * the second waits and merges into what the first wrote. The embedding is written afterwards
 * only if the profile text is still the one it was made from, so a slow embedding never
 * overwrites a newer one.
 *
 * Throws for a mini-app that is not this restaurant's, a deleted one, or a `system` one, and
 * for an embedding of the wrong length. If the embedding call itself fails, the text is kept
 * (the word-for-word check still works) and the failure is logged, not thrown: a build is never
 * blocked by memory.
 */
export const saveAppProfile = async (tenant: TenantContext, input: AppProfileDraftT): Promise<void> => {
  const draft = AppProfileDraft.parse(input);
  const orgUuid = orgUuidOf(tenant);
  const appUuid = toUuid(draft.appId);

  const saved = await withOrg(apiDb(), orgUuid, async (tx) => {
    const [app] = await tx<LockedApp[]>`
      select id::text, kind, status from platform.apps
      where id = ${appUuid} and org_id = rms.current_org()
      for update`;
    if (!app) throw new Error("Unknown mini-app");
    if (app.kind === "system") throw new Error("A hidden system mini-app has no profile");
    if (app.status === "deleted") throw new Error("A deleted mini-app has no profile");

    const [stored] = await tx<StoredProfile[]>`
      select purpose, capabilities, requests from platform.app_profiles
      where app_id = ${appUuid} and org_id = rms.current_org()`;
    const requests = mergeRequests(stored?.requests ?? [], draft.requests);
    const next: StoredProfile = { purpose: draft.purpose, capabilities: draft.capabilities, requests };
    await tx`
      insert into platform.app_profiles (app_id, org_id, purpose, capabilities, requests, updated_at)
      values (${appUuid}, rms.current_org(), ${next.purpose}, ${next.capabilities}::text[], ${next.requests}::text[], now())
      on conflict (app_id) do update
        set purpose = excluded.purpose, capabilities = excluded.capabilities, requests = excluded.requests, updated_at = now()`;
    return next;
  });

  let result: EmbedResult;
  try {
    result = await embedTexts([profileText(saved)]);
  } catch (e) {
    log({ event: "profile_embed_failed", app: draft.appId, error: errorName(e) });
    return;
  }
  // Wrong length or not numbers: refused, nothing stored.
  const vector = checkedEmbedding(result.embeddings[0]);

  await withOrg(apiDb(), orgUuid, async (tx) => {
    await tx`
      update platform.app_profiles set embedding = ${vectorLiteral(vector)}::extensions.vector
      where app_id = ${appUuid} and org_id = rms.current_org()
        and purpose = ${saved.purpose} and capabilities = ${saved.capabilities}::text[] and requests = ${saved.requests}::text[]`;
    await recordEmbedUsage(tx, orgUuid, result, appUuid);
  });
};

type Candidate = { app_id: string; name: string; published: boolean; purpose: string; capabilities: string[]; requests: string[]; has_embedding: boolean };
type Match = DuplicateCheckResult["matches"][number];

const toMatch = (c: Candidate): Match => ({
  appId: toPublicId("app", c.app_id),
  appName: c.name.slice(0, 40),
  reason: reasonFor(c.purpose),
  published: c.published,
});

/** This restaurant's own mini-apps that can be compared: not deleted, not `system`, with a profile. */
const candidates = (tx: Tx) => tx<Candidate[]>`
  select p.app_id::text as app_id, a.name, (a.published_version_id is not null or a.status = 'published') as published,
         p.purpose, p.capabilities, p.requests, (p.embedding is not null) as has_embedding
  from platform.app_profiles p
  join platform.apps a on a.id = p.app_id and a.org_id = p.org_id
  where p.org_id = rms.current_org() and a.org_id = rms.current_org()
    and a.kind <> 'system' and a.status <> 'deleted'
  order by a.created_at, a.id`;

const fallbackMatches = (text: string, list: readonly Candidate[]): Candidate[] =>
  list
    .map((c) => ({ c, score: wordOverlap(text, [c.name, profileText(c)].join("\n")) }))
    .filter((x) => x.score >= WORD_OVERLAP_SIMILAR)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);

/** The lines of a profile compared one by one with a request: purpose, each capability, each earlier request. */
const linesOf = (c: Candidate): string[] =>
  [...new Set([c.purpose, ...c.capabilities, ...c.requests].map((s) => s.trim()).filter((s) => s !== ""))];

export type DuplicateThresholds = { readonly shortlistFloor: number; readonly same: number; readonly similar: number; readonly maxMatches: number };
type Scored = { c: Candidate; similarity: number };

/**
 * How close `text` is to each candidate, 0 to 1: the higher of
 *   - the whole profile: cosine with the stored profile embedding, worked out in the database,
 *     inside `withOrg` and with `org_id = rms.current_org()` (two walls), and
 *   - its best single line: cosine with the purpose, a capability or an earlier request.
 * A short request is much closer to one short line than to a whole profile (measured: see
 * docs/briefs/wave2-task-m-notes.md), so the best line is what usually decides. The lines come
 * from the same fenced read as the candidates.
 * Throws when the embedding call fails; the caller falls back to words.
 */
const scoreProfiles = async (orgUuid: string, text: string, list: readonly Candidate[]): Promise<Scored[]> => {
  const lines = [...new Set(list.flatMap(linesOf))];
  const { result, vectors } = await embedWithCache(text, lines);
  const request = vectors.get(text) as number[];

  const whole = await withOrg(apiDb(), orgUuid, async (tx) => {
    const rows = await tx<{ app_id: string; similarity: number }[]>`
      select p.app_id::text as app_id,
             1 - (p.embedding operator(extensions.<=>) ${vectorLiteral(request)}::extensions.vector) as similarity
      from platform.app_profiles p
      join platform.apps a on a.id = p.app_id and a.org_id = p.org_id
      where p.org_id = rms.current_org() and a.org_id = rms.current_org()
        and a.kind <> 'system' and a.status <> 'deleted' and p.embedding is not null`;
    await recordEmbedUsage(tx, orgUuid, result, null);
    return new Map(rows.map((r) => [r.app_id, Number(r.similarity)]));
  });

  return list
    .map((c) => {
      const best = Math.max(-1, ...linesOf(c).map((l) => cosine(request, vectors.get(l) as number[])));
      return { c, similarity: Math.max(best, whole.get(c.app_id) ?? -1) };
    })
    .sort((a, b) => b.similarity - a.similarity);
};

const JUDGE_INSTRUCTIONS = [
  "You decide whether a restaurant owner's new request for a small app is already covered by mini-apps they already have.",
  "For every mini-app in the data, answer with its `ref` and a `verdict`:",
  "- `same`: it already does what the owner is asking for.",
  "- `overlaps`: it does part of it, so the owner could add to it instead of building a new one.",
  "- `different`: it is for something else.",
  "Judge only by what the request asks for and what each mini-app's purpose and capabilities say it does.",
  "Give `reason`: one short sentence in everyday words for the owner, about that mini-app, for example \"It already shows your weekly sales, costs and profit.\" No numbers, scores, code or table names.",
].join("\n");

/** A reason from the model is shown to the owner only if it is plain words. Otherwise the purpose speaks. */
const ownerReason = (reason: string, purpose: string): string => {
  const r = reason.trim().replace(/\s+/gu, " ");
  return r === "" || r.length > 200 || /[\d%{}<>`$]|\bscore\b|\bsimilar(ity)?\b/iu.test(r) ? reasonFor(purpose) : r;
};

type Shortlisted = { c: Candidate; similarity: number | null };

/** Embedding score alone, with the conservative fallback thresholds. A word-overlap pick is "similar" at most. */
const byScore = (list: readonly Shortlisted[], t: DuplicateThresholds): DuplicateCheckResult => {
  const over = list.filter((s) => s.similarity === null || s.similarity >= t.similar);
  if (over.length === 0) return { verdict: "none", matches: [] };
  const top = over[0]?.similarity;
  return { verdict: top !== null && top !== undefined && top >= t.same ? "same" : "similar", matches: over.map((s) => toMatch(s.c)) };
};

const llmUsage = (tx: Tx, orgUuid: string, kind: string, unit: string, quantity: number, costMicros: number, model: string) =>
  tx`insert into platform.usage_events (id, org_id, kind, quantity, unit, cost_micros, provider, model)
     values (${newUuid()}, ${orgUuid}, ${kind}, ${Math.max(0, Math.round(quantity))}, ${unit}, ${costMicros}, 'openrouter', ${model})`;

/** The check itself, with the thresholds given. `checkDuplicate` passes the contract's. */
export const checkDuplicateWithThresholds = async (tenant: TenantContext, text: string, t: DuplicateThresholds): Promise<DuplicateCheckResult> => {
  const orgUuid = orgUuidOf(tenant);
  const wanted = normaliseRequest(text);
  const list = await withOrg(apiDb(), orgUuid, candidates);
  if (list.length === 0 || wanted === "") return { verdict: "none", matches: [] };

  // 1. Asked again word for word: no model call at all.
  const exact = list.filter((c) => c.requests.some((r) => normaliseRequest(r) === wanted));
  if (exact.length > 0) return { verdict: "same", matches: exact.slice(0, t.maxMatches).map(toMatch) };

  // 2. Shortlist: embeddings above the floor, plus what the word check finds.
  const words = fallbackMatches(text, list);
  let shortlist: Shortlisted[];
  try {
    const scored = await scoreProfiles(orgUuid, text, list);
    const picked = scored.filter((s) => s.similarity >= t.shortlistFloor || words.includes(s.c));
    shortlist = picked.slice(0, t.maxMatches);
  } catch (e) {
    log({ event: "duplicate_embed_failed", error: errorName(e) });
    shortlist = words.slice(0, t.maxMatches).map((c) => ({ c, similarity: null }));
  }
  if (shortlist.length === 0) return { verdict: "none", matches: [] };

  // 3. Confirm with one short chat-model call. The request and the profiles are data.
  const refs = shortlist.map((s, i) => ({ ref: `m${i + 1}`, s }));
  let judged: JudgeResult;
  try {
    judged = await judgeDuplicates({
      instructions: JUDGE_INSTRUCTIONS,
      prompt: dataBlock("the owner's new request and the mini-apps they already have", {
        ownerRequest: text,
        miniApps: refs.map(({ ref, s }) => ({ ref, name: s.c.name, purpose: s.c.purpose, capabilities: s.c.capabilities })),
      }),
    });
    const answered = new Map(judged.output.verdicts.map((v) => [v.ref, v]));
    if (refs.some(({ ref }) => !answered.has(ref))) throw new Error("A shortlisted mini-app has no judgement");
  } catch (e) {
    // 4. Any failure: the embedding score alone, conservative thresholds. Never blocks the build.
    log({ event: "duplicate_confirm_failed", error: errorName(e) });
    return byScore(shortlist, t);
  }
  await withOrg(apiDb(), orgUuid, async (tx) => {
    await llmUsage(tx, orgUuid, USAGE.llmInput.kind, USAGE.llmInput.unit, judged.inputTokens, judged.costMicros, judged.model);
    await llmUsage(tx, orgUuid, USAGE.llmOutput.kind, USAGE.llmOutput.unit, judged.outputTokens, 0, judged.model);
  }).catch((e: unknown) => log({ event: "duplicate_usage_failed", error: errorName(e) }));

  const answered = new Map(judged.output.verdicts.map((v) => [v.ref, v]));
  const rank = { same: 0, overlaps: 1, different: 2 } as const;
  const kept = refs
    .map(({ ref, s }, order) => ({ s, order, v: answered.get(ref) as JudgeAnswer["verdicts"][number] }))
    .filter((x) => x.v.verdict !== "different")
    .sort((a, b) => rank[a.v.verdict] - rank[b.v.verdict] || a.order - b.order);
  if (kept.length === 0) return { verdict: "none", matches: [] };
  return {
    verdict: JUDGEMENT_VERDICT[kept[0]?.v.verdict ?? "different"],
    matches: kept.map((x) => ({ ...toMatch(x.s.c), reason: ownerReason(x.v.reason, x.s.c.purpose) })),
  };
};

/**
 * Does this restaurant already have a mini-app that does what `text` asks for?
 *   1. word for word: the request equals a stored request after `normaliseRequest`: "same", no model call
 *   2. shortlist: up to three of its own mini-apps at or above `shortlistFloor` (see `scoreProfiles`),
 *      plus word-overlap picks; word overlap alone if the embedding call fails
 *   3. confirm: one chat-model call (RMS_ASK_MODEL) judges each as same / overlaps / different,
 *      with the request and profiles passed as marked data; 5 second limit
 *   4. if the confirm call fails in any way: the embedding score with the conservative thresholds
 * Compares only with this restaurant's own mini-apps that are not deleted and not `system`.
 * Never throws because of a model. Never returns a score.
 */
export const checkDuplicate = (tenant: TenantContext, text: string): Promise<DuplicateCheckResult> =>
  checkDuplicateWithThresholds(tenant, text, DUPLICATE_THRESHOLDS);

/**
 * For the threshold measurement only (`*.live.test.ts`): the similarity of `text` to each of the
 * restaurant's comparable mini-apps. Same walls and same scoring. Never exposed by a route.
 */
export const similaritiesForMeasurement = async (tenant: TenantContext, text: string): Promise<{ appName: string; similarity: number }[]> => {
  const orgUuid = orgUuidOf(tenant);
  const list = await withOrg(apiDb(), orgUuid, candidates);
  const scored = await scoreProfiles(orgUuid, text, list);
  return scored.map((s) => ({ appName: s.c.name, similarity: s.similarity }));
};

