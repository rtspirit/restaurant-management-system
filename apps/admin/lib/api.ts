"use client";
// Calls the RMS API as the signed-in maintainer: their Supabase access token as a bearer header.
// No cookie is sent to the API.
import { supabaseBrowser } from "./supabase/client";

export type FeedItem = {
  id: string;
  orgId: string;
  appId: string | null;
  origin: string;
  signals: string[];
  tier: "T0" | "T1" | "T2" | "T3";
  summary: string;
  ownerSummary: string;
  actor: string;
  decision: "applied" | "pending_owner" | "pending_maintainer" | "approved" | "rejected";
  createdAt: string;
  decidedAt: string | null;
  restaurantName: string;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MESSAGES: Record<number, string> = {
  401: "Please sign in again.",
  403: "This account is not a maintainer.",
};

export const apiFetch = async <T,>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> => {
  const base = process.env.NEXT_PUBLIC_API_URL;
  if (!base) throw new ApiError(0, "The console is missing the API address.");
  const { data } = await supabaseBrowser().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError(401, MESSAGES[401] as string);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? null : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "Could not reach the RMS API.");
  }
  const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) throw new ApiError(res.status, MESSAGES[res.status] ?? json?.error?.message ?? "Something went wrong.");
  return json as T;
};
