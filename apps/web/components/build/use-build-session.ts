"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { AgentApi } from "@/lib/agent/client";
import { createBuildSession, INITIAL_SNAPSHOT, type SessionActions, type SessionSnapshot } from "@/lib/agent/session";

export type BuildSessionState = SessionSnapshot & {
  actions: SessionActions;
  /** Try loading again after "unavailable". */
  reload: () => void;
};

/**
 * One build session on screen. All of the behaviour is in `lib/agent/session.ts`, where it is
 * tested: this only ties a component to it.
 */
export function useBuildSession(api: AgentApi, sessionId: string): BuildSessionState {
  const controller = useMemo(() => createBuildSession(api, sessionId), [api, sessionId]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => INITIAL_SNAPSHOT);

  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);

  return { ...snapshot, actions: controller.actions, reload: controller.start };
}
