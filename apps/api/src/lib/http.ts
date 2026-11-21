// Shared HTTP helpers for the Wave 2 routes. Lead-owned. Import these instead of writing your own.
// (The Wave 1 routes each wrote their own. They are left as they are.)
import { API_ERROR_STATUS, type ApiError, type ApiErrorCode, EVENT_STREAM } from "@rms/contracts";
import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** The RMS web app's origin, from WEB_URL. Null when it is not set or not an address. */
export const webOrigin = (): string | null => {
  const url = process.env.WEB_URL;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * Lets the RMS web app, and only it, call these routes from the browser. Exactly one origin,
 * never a wildcard, no cookies: the credential is always a bearer header.
 */
export const webCors = (): MiddlewareHandler =>
  cors({
    origin: (origin) => {
      const web = webOrigin();
      return web !== null && origin === web ? web : null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["authorization", "content-type"],
    credentials: false,
    maxAge: 600,
  });

/** Answers are never cached, never sniffed, never framed, and never leak the address they came from. */
export const safeHeaders = (): MiddlewareHandler => async (c, next) => {
  await next();
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header("x-frame-options", "DENY");
  c.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
};

/** A refusal in the shared envelope. `message` is plain words for an owner. Internal detail goes to the log, not here. */
export const apiError = (c: Context, code: ApiErrorCode, message: string, requestId: string = crypto.randomUUID()) => {
  const body: ApiError = { error: { code, message, requestId } };
  return c.json(body, API_ERROR_STATUS[code] as ContentfulStatusCode);
};

/** Reads a JSON body. Returns `undefined` for an empty body and `null` when it is not JSON. */
export const readJson = async (c: Context): Promise<unknown> => {
  const text = await c.req.text();
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

/** One line for the log. Never pass a request body, a token or a key. */
export const logLine = (fields: Record<string, string | number | boolean | null>): void => {
  console.error(JSON.stringify(fields));
};

/** Response headers for an event stream (EVENT_STREAM in @rms/contracts). */
export const eventStreamHeaders = { "content-type": EVENT_STREAM.contentType, "cache-control": "no-store", "x-accel-buffering": "no" } as const;
