// The data client. Each call posts ONE `rms.data` message naming one of the five routes (never
// an address) and waits for the `rms.data.result` with the same id. At most
// `FRAME_LIMITS.maxInFlight` at once, the rest queued (up to `maxQueued`), each with a time
// limit, and a body over `maxBodyBytes` is refused before it is sent.
import {
  BatchRequest,
  BatchResponse,
  CatalogResponse,
  DataError,
  type DataErrorCode,
  FRAME_LIMITS,
  FRAME_PROTOCOL,
  type FrameDataRoute,
  type FrameToShell,
  NamedActionRequest,
  NamedActionResponse,
  NamedQueryRequest,
  NamedQueryResponse,
  QueryRequest,
  QueryResponse,
} from "@rms/contracts";

/** A schema from @rms/contracts, typed by shape so the SDK needs no zod of its own. */
type Shape<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
type In<S> = S extends { _zod: { input: infer I } } ? I : never;
type Out<S> = S extends { _zod: { output: infer O } } ? O : never;

/** A Data API refusal, or a problem on the way. `message` is plain words, safe to show the owner. */
export class RmsDataError extends Error {
  readonly code: DataErrorCode | "timeout" | "closed";
  readonly status: number;
  constructor(code: DataErrorCode | "timeout" | "closed", message: string, status = 0) {
    super(message);
    this.name = "RmsDataError";
    this.code = code;
    this.status = status;
  }
}

const PLAIN = {
  tooBig: "That is too much to send at once. Try fewer rows.",
  busy: "RMS is busy. Try again in a moment.",
  timeout: "RMS took too long to answer. Try again.",
  closed: "This screen was closed before RMS answered.",
  unreadable: "Something went wrong reading the answer. Try again.",
  invalid: "That request was not understood.",
  failed: "Something went wrong. Try again.",
} as const;

type Pending = { resolve: (value: { status: number; body: unknown }) => void; reject: (error: RmsDataError) => void; timer: unknown };
type Queued = { message: Extract<FrameToShell, { type: "rms.data" }>; pending: Omit<Pending, "timer"> };

export type ClientPorts = {
  post(message: FrameToShell): void;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const newId = (): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += ID_CHARS[b & 63];
  return id;
};

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export type QueryInput = In<typeof QueryRequest>;
export type BatchInput = In<typeof BatchRequest>;
export type NamedQueryInput = In<typeof NamedQueryRequest>;
export type NamedActionInput = In<typeof NamedActionRequest>;
export type QueryResult = Out<typeof QueryResponse>;
export type BatchResult = Out<typeof BatchResponse>;
export type NamedQueryResult = Out<typeof NamedQueryResponse>;
export type NamedActionResult = Out<typeof NamedActionResponse>;
export type CatalogResult = Out<typeof CatalogResponse>;

export class DataClient {
  private readonly ports: ClientPorts;
  private readonly pending = new Map<string, Pending>();
  private readonly queue: Queued[] = [];
  private closed = false;

  constructor(ports: ClientPorts) {
    this.ports = ports;
  }

  query(request: QueryInput): Promise<QueryResult> {
    return this.call("query", QueryRequest, request, QueryResponse);
  }

  batch(request: BatchInput): Promise<BatchResult> {
    return this.call("batch", BatchRequest, request, BatchResponse);
  }

  named(request: NamedQueryInput): Promise<NamedQueryResult> {
    return this.call("named", NamedQueryRequest, request, NamedQueryResponse);
  }

  action(request: NamedActionInput): Promise<NamedActionResult> {
    return this.call("action", NamedActionRequest, request, NamedActionResponse);
  }

  catalog(): Promise<CatalogResult> {
    return this.call("catalog", null, {}, CatalogResponse);
  }

  /** How many requests are waiting for an answer, and how many are queued behind them. */
  get load(): { inFlight: number; queued: number } {
    return { inFlight: this.pending.size, queued: this.queue.length };
  }

  /** Called by the frame for each `rms.data.result` that passed the origin and shape checks. */
  settle(id: string, status: number, body: unknown): void {
    const p = this.pending.get(id);
    if (!p) return; // not ours, or already timed out: dropped
    this.pending.delete(id);
    this.ports.clearTimeout(p.timer);
    p.resolve({ status, body });
    this.pump();
  }

  closeAll(): void {
    this.closed = true;
    for (const [id, p] of this.pending) {
      this.ports.clearTimeout(p.timer);
      p.reject(new RmsDataError("closed", PLAIN.closed));
      this.pending.delete(id);
    }
    for (const q of this.queue.splice(0)) q.pending.reject(new RmsDataError("closed", PLAIN.closed));
  }

  private async call<Req, Res>(route: FrameDataRoute, requestShape: Shape<Req> | null, request: unknown, responseShape: Shape<Res>): Promise<Res> {
    let body: unknown = request;
    if (requestShape !== null) {
      const parsed = requestShape.safeParse(request);
      if (!parsed.success) throw new RmsDataError("invalid_request", PLAIN.invalid, 400);
      body = parsed.data;
    }
    const { status, body: answer } = await this.send(route, body);
    if (status >= 200 && status < 300) {
      const parsed = responseShape.safeParse(answer);
      if (!parsed.success) throw new RmsDataError("internal", PLAIN.unreadable, status);
      return parsed.data;
    }
    const refusal = DataError.safeParse(answer);
    if (refusal.success) throw new RmsDataError(refusal.data.error.code, refusal.data.error.message, status);
    throw new RmsDataError("internal", PLAIN.failed, status);
  }

  private send(route: FrameDataRoute, body: unknown): Promise<{ status: number; body: unknown }> {
    if (this.closed) return Promise.reject(new RmsDataError("closed", PLAIN.closed));
    let text: string | undefined;
    try {
      text = JSON.stringify(body);
    } catch {
      return Promise.reject(new RmsDataError("invalid_request", PLAIN.invalid, 400));
    }
    if (text === undefined || byteLength(text) > FRAME_LIMITS.maxBodyBytes) return Promise.reject(new RmsDataError("invalid_request", PLAIN.tooBig, 400));
    const message = { rms: FRAME_PROTOCOL, type: "rms.data", id: newId(), route, body } as const;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject };
      if (this.pending.size < FRAME_LIMITS.maxInFlight) this.dispatch({ message, pending });
      else if (this.queue.length < FRAME_LIMITS.maxQueued) this.queue.push({ message, pending });
      else reject(new RmsDataError("limit", PLAIN.busy, 429));
    });
  }

  private dispatch({ message, pending }: Queued): void {
    const timer = this.ports.setTimeout(() => {
      if (!this.pending.delete(message.id)) return;
      pending.reject(new RmsDataError("timeout", PLAIN.timeout));
      this.pump();
    }, FRAME_LIMITS.requestTimeoutMs);
    this.pending.set(message.id, { ...pending, timer });
    this.ports.post(message);
  }

  private pump(): void {
    while (!this.closed && this.pending.size < FRAME_LIMITS.maxInFlight && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) this.dispatch(next);
    }
  }
}
