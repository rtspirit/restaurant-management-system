"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AgentEvent, RunReply } from "@rms/contracts";
import { AgentApiError, type AgentApi } from "@/lib/agent/client";
import { afterReconnect, applyEvent, CHOICE_WORDS, EMPTY_VIEW, type BuildView } from "@/lib/agent/reducer";
import { followSession, type Following, type StreamStatus } from "@/lib/agent/stream";
import type { BuildActions } from "./build-workbench";

type Action = { type: "event"; event: AgentEvent } | { type: "reconnected" } | { type: "reset" };

function screenReducer(view: BuildView, action: Action): BuildView {
  if (action.type === "event") return applyEvent(view, action.event).view;
  if (action.type === "reconnected") return afterReconnect(view);
  return EMPTY_VIEW;
}

export type SessionLoad =
  | "loading"
  | "ready"
  /** No such build, or it belongs to someone else. The same answer either way. */
  | "not-found"
  | "signed-out"
  /** RMS did not answer. */
  | "unavailable";

export type BuildSessionState = {
  load: SessionLoad;
  view: BuildView;
  connection: StreamStatus;
  problem: string | null;
  sending: string | null;
  busy: boolean;
  stopping: boolean;
  /** The stored conversation has been replayed in full. */
  settled: boolean;
  actions: Omit<BuildActions, "changePlan">;
  /** Try loading again after "unavailable". */
  reload: () => void;
};

const SOMETHING_WRONG = "RMS could not do that just now. Try again in a moment.";
const isWorkingStatus = (status: string | undefined): boolean => status === "running" || status === "paused";

/**
 * One build session on screen: loads it, replays its conversation from the first event, follows
 * the live stream, reconnects when it drops, and sends what the owner says.
 */
export function useBuildSession(api: AgentApi, sessionId: string): BuildSessionState {
  const [view, dispatch] = useReducer(screenReducer, EMPTY_VIEW);
  const [load, setLoad] = useState<SessionLoad>("loading");
  const [connection, setConnection] = useState<StreamStatus>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [target, setTarget] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const following = useRef<Following | null>(null);
  const seq = useRef(0);
  const inFlight = useRef(false);

  const follow = useCallback(
    (working: boolean) => {
      following.current?.stop();
      const mine: { handle: Following | null } = { handle: null };
      const current = () => following.current !== null && following.current === mine.handle;
      mine.handle = followSession({
        open: (after, signal) => api.events(sessionId, after, signal),
        after: seq.current,
        working,
        onEvent: (event) => {
          if (event.seq > seq.current && event.type !== "message.delta" && event.type !== "run.paused") seq.current = event.seq;
          if (event.type === "user.message" || event.type === "user.reply") setSending(null);
          if (event.type === "run.cancelled" || event.type === "run.started") setStopping(false);
          dispatch({ type: "event", event });
        },
        onStatus: (status) => {
          if (!current()) return;
          setConnection(status);
          if (status === "reconnecting") dispatch({ type: "reconnected" });
        },
        stillWorking: async () => isWorkingStatus((await api.session(sessionId)).run?.status),
      });
      following.current = mine.handle;
      void mine.handle.ended.then((end) => {
        if (!current()) return;
        if (end === "signed-out") setLoad("signed-out");
        if (end === "not-found") setLoad("not-found");
        if (end === "refused") setProblem(SOMETHING_WRONG);
        if (end === "finished") setTarget(0);
      });
    },
    [api, sessionId],
  );

  useEffect(() => {
    let gone = false;
    seq.current = 0;
    dispatch({ type: "reset" });
    setLoad("loading");
    setTarget(null);
    setProblem(null);
    setSending(null);
    void (async () => {
      try {
        const session = await api.session(sessionId);
        if (gone) return;
        setTarget(session.lastSeq);
        setLoad("ready");
        follow(isWorkingStatus(session.run?.status));
      } catch (error) {
        if (gone) return;
        const code = error instanceof AgentApiError ? error.code : "unavailable";
        setLoad(code === "not_found" || code === "forbidden" ? "not-found" : code === "unauthenticated" ? "signed-out" : "unavailable");
      }
    })();
    return () => {
      gone = true;
      following.current?.stop();
      following.current = null;
    };
  }, [api, sessionId, follow, attempt]);

  const send = useCallback(
    async (request: { text: string } | { reply: RunReply }, echo: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setProblem(null);
      setSending(echo);
      try {
        await api.start({ sessionId: sessionId as `ses_${string}`, mode: "build", ...request });
        follow(true);
      } catch (error) {
        setSending(null);
        setProblem(error instanceof AgentApiError ? error.message : SOMETHING_WRONG);
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [api, sessionId, follow],
  );

  const runId = view.runId;
  const actions = useMemo<BuildSessionState["actions"]>(
    () => ({
      say: (text) => void send({ text }, text),
      answer: (to, text) => void send({ reply: { kind: "answer", to, text } }, text),
      choose: (to, choice, ref) => void send({ reply: { kind: "choose", to, choice, ...(ref ? { ref } : {}) } }, CHOICE_WORDS[choice]),
      buildPlan: (to) => void send({ reply: { kind: "confirm", to, ok: true } }, "Build it"),
      confirm: (to, ok) => void send({ reply: { kind: "confirm", to, ok } }, ok ? "Yes, go ahead" : "No, leave it"),
      retry: () => void send({ text: "Try again" }, "Try again"),
      undo: () => void send({ text: "Undo that last change" }, "Undo that last change"),
      stop: () => {
        if (!runId) return;
        setStopping(true);
        setProblem(null);
        api.cancel(runId).catch((error: unknown) => {
          setStopping(false);
          setProblem(error instanceof AgentApiError ? error.message : SOMETHING_WRONG);
        });
      },
    }),
    [api, runId, send],
  );

  return {
    load,
    view,
    connection,
    problem,
    sending,
    busy,
    stopping,
    settled: target !== null && view.lastSeq >= target,
    actions,
    reload: () => setAttempt((n) => n + 1),
  };
}
