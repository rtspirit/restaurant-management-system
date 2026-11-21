// React hooks for screens. The template's frame (src/rms/) puts an <RmsProvider> around every
// screen once it is connected, so screens only call the hooks.
import type { FrameContext, Row } from "@rms/contracts";
import { type ReactNode, createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { BatchInput, BatchResult, DataClient, NamedQueryResult, QueryInput, QueryResult } from "./client";
import { RmsDataError } from "./client";

type RmsValue = { context: FrameContext; client: DataClient; version: number; changed: () => void };

const RmsContext = createContext<RmsValue | null>(null);

export type RmsProviderProps = { context: FrameContext; client: DataClient; children: ReactNode };

/** Used by the template's frame. Screens never need it. */
export function RmsProvider({ context, client, children }: RmsProviderProps) {
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => setVersion((v) => v + 1), []);
  const value = useMemo(() => ({ context, client, version, changed }), [context, client, version, changed]);
  return createElement(RmsContext.Provider, { value }, children);
}

const useRmsValue = (): RmsValue => {
  const value = useContext(RmsContext);
  if (value === null) throw new Error("RMS hooks only work inside the mini-app's frame.");
  return value;
};

/** Where the mini-app is running: the restaurant, the user, the locations, the currency, and whether this is a preview ("draft"). */
export const useRms = (): FrameContext => useRmsValue().context;

/** The data client itself, for anything the hooks below do not cover. */
export const useRmsClient = (): DataClient => useRmsValue().client;

const plainError = (error: unknown): RmsDataError =>
  error instanceof RmsDataError ? error : new RmsDataError("internal", "Something went wrong. Try again.");

type Loadable<T> = { data: T | null; loading: boolean; error: RmsDataError | null; reload: () => void };

const useLoad = <T,>(key: string, load: (client: DataClient) => Promise<T>): Loadable<T> => {
  const { client, version } = useRmsValue();
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: RmsDataError | null }>({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    loadRef.current(client).then(
      (data) => live && setState({ data, loading: false, error: null }),
      (error: unknown) => live && setState({ data: null, loading: false, error: plainError(error) }),
    );
    return () => {
      live = false;
    };
  }, [client, key, version, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
};

export type UseQueryResult = Loadable<QueryResult> & { rows: Row[] };

/** Rows of one model. Loads again after any change made through `useMutation`. */
export const useQuery = (request: QueryInput): UseQueryResult => {
  const result = useLoad(JSON.stringify(request), (client) => client.query(request));
  return { ...result, rows: result.data?.rows ?? [] };
};

export type UseNamedQueryResult = Loadable<NamedQueryResult> & { rows: Row[]; columns: NamedQueryResult["columns"] };

/** The rows of one named query from the manifest, such as `weekly_pnl`. */
export const useNamedQuery = (query: string, params: Record<string, string | number | boolean | null> = {}): UseNamedQueryResult => {
  const result = useLoad(JSON.stringify([query, params]), (client) => client.named({ query, params }));
  return { ...result, rows: result.data?.rows ?? [], columns: result.data?.columns ?? [] };
};

export type UseMutationResult = {
  /** Runs the writes in one go: all of them or none. */
  run: (request: BatchInput) => Promise<BatchResult>;
  insert: (model: string, values: Record<string, unknown>) => Promise<BatchResult>;
  update: (model: string, id: string, values: Record<string, unknown>) => Promise<BatchResult>;
  remove: (model: string, id: string) => Promise<BatchResult>;
  busy: boolean;
  /** The last refusal, in plain words. Cleared by the next call. */
  error: RmsDataError | null;
};

/** Writes. Every successful write makes the screen's queries load again. */
export const useMutation = (): UseMutationResult => {
  const { client, changed } = useRmsValue();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RmsDataError | null>(null);

  const run = useCallback(
    async (request: BatchInput) => {
      setBusy(true);
      setError(null);
      try {
        const result = await client.batch(request);
        changed();
        return result;
      } catch (e) {
        const plain = plainError(e);
        setError(plain);
        throw plain;
      } finally {
        setBusy(false);
      }
    },
    [client, changed],
  );

  return useMemo(
    () => ({
      run,
      insert: (model, values) => run({ ops: [{ op: "insert", model, values }] }),
      update: (model, id, values) => run({ ops: [{ op: "update", model, id, values }] }),
      remove: (model, id) => run({ ops: [{ op: "delete", model, id }] }),
      busy,
      error,
    }),
    [run, busy, error],
  );
};
