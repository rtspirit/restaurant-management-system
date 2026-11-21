// The build routes, as the screen uses them (contracts: AGENT_ROUTES, DATA_ROUTES).
//
// `AgentApi` is the whole surface. The real one below talks to the RMS API. A practice one with
// the same shape lives in `mock.ts`. `api.ts` picks between them, and nothing else in the app
// knows which is in use.
import { AGENT_ROUTES, ApiError, PreviewGrant, SessionView, StartRunResponse, type ApiErrorCode, type StartRunRequest } from "@rms/contracts";
import { apiFetch, SignedOutError } from "../api";
import { apiUrl } from "../me";

/** A route answered with an error. `message` is plain words from the server, safe to show. */
export class AgentApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** One Data API call made for a framed mini-app. `status` and `body` go back to the frame as they came. */
export type DataCall = (path: string, token: string, body: string, signal?: AbortSignal) => Promise<{ status: number; body: unknown }>;

/** Who a practice run should say it is for. The real API knows this from the session. */
export type PracticeProfile = {
  restaurantName: string;
  brandColour: string | null;
  userName: string;
  role: "owner" | "staff";
  locations: { name: string }[];
};

export type AgentApi = {
  /** True for the practice stand-in: nothing is built or saved. The screen says so. */
  readonly practice: boolean;
  /** Practice only: tells the stand-in which restaurant to show in its preview. */
  describe?: (profile: PracticeProfile) => void;
  start: (request: StartRunRequest) => Promise<StartRunResponse>;
  session: (sessionId: string) => Promise<SessionView>;
  /** The raw event stream after `after`. Read it with `followSession`. */
  events: (sessionId: string, after: number, signal: AbortSignal) => Promise<Response>;
  preview: (sessionId: string) => Promise<PreviewGrant>;
  cancel: (runId: string) => Promise<void>;
  /** Calls the Data API with a frame's own token. Never with the owner's session. */
  data: DataCall;
};

const SOMETHING_WRONG = "RMS could not do that just now. Try again in a moment.";

/** Turns an error answer into an `AgentApiError`. The server's own words are used only when they parse. */
async function fail(response: Response): Promise<never> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = ApiError.safeParse(body);
  if (parsed.success) throw new AgentApiError(parsed.data.error.code, parsed.data.error.message);
  throw new AgentApiError(response.status === 404 ? "not_found" : response.status === 409 ? "busy" : "internal", SOMETHING_WRONG);
}

const path = (route: string, ids: Record<string, string>): string =>
  Object.entries(ids).reduce((text, [name, value]) => text.split(`:${name}`).join(encodeURIComponent(value)), route);

async function send(route: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await apiFetch(route, init);
  } catch (error) {
    if (error instanceof SignedOutError) throw new AgentApiError("unauthenticated", "Please sign in again.");
    throw new AgentApiError("unavailable", "RMS is not answering just now. Try again in a moment.");
  }
  if (!response.ok) return fail(response);
  return response.json().catch(() => null);
}

/** The RMS API, signed in as the owner. */
export const realAgentApi: AgentApi = {
  practice: false,
  start: async (request) => StartRunResponse.parse(await send(AGENT_ROUTES.start, { method: "POST", body: JSON.stringify(request) })),
  session: async (sessionId) => SessionView.parse(await send(path(AGENT_ROUTES.session, { sessionId }), { method: "GET" })),
  events: async (sessionId, after, signal) => {
    try {
      return await apiFetch(`${path(AGENT_ROUTES.events, { sessionId })}?after=${after}`, { method: "GET", headers: { accept: "text/event-stream" }, signal });
    } catch (error) {
      // Signed out is an answer, not a dropped connection: say so, so nothing keeps knocking.
      if (error instanceof SignedOutError) return new Response(null, { status: 401 });
      throw error;
    }
  },
  preview: async (sessionId) => PreviewGrant.parse(await send(path(AGENT_ROUTES.preview, { sessionId }), { method: "POST" })),
  cancel: async (runId) => {
    await send(path(AGENT_ROUTES.cancel, { runId }), { method: "POST" });
  },
  // Plain `fetch`, on purpose: `apiFetch` would attach the owner's own session, and a frame's
  // request must carry the frame's token and nothing else (ADR 0008).
  data: async (route, token, body, signal) => {
    const response = await fetch(`${apiUrl()}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
      cache: "no-store",
      credentials: "omit",
      ...(signal ? { signal } : {}),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  },
};
