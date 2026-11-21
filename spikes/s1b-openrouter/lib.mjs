// Shared helpers for spike S1b. Throwaway code.
// Rule: the OpenRouter key is read here and goes ONLY into (a) direct calls from this machine and
// (b) the sandbox firewall rule. It is never printed, never written to a file, and never passed
// into the sandbox as an env var, argument or file. The OpenAI key in the env file is never read.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT = resolve(HERE, "out"); // git-ignored
const TEAM = "team_RM4toarAtl8vljERLdxRvfeh";
const PROJECT = "rms-api";

export const LLM_HOST = "openrouter.ai";
export const LLM_BASE = process.env.RMS_LLM_BASE_URL || `https://${LLM_HOST}/api/v1`;
export const TASK = "Change the greeting to say Hello, Marigold Kitchen and add a second line that says Open today.";
export const DUMMY = "dummy-key-the-firewall-swaps-in-the-real-one";
/** Privacy option sent with every direct model call: refuse providers that keep or train on prompts. */
export const PRIVACY = { data_collection: "deny" };

/** Loads the short-lived OIDC token from ./.env.local and checks it is for our team and project. */
export function loadVercelAuth() {
  const link = JSON.parse(readFileSync(resolve(HERE, ".vercel/project.json"), "utf8"));
  if (link.orgId !== TEAM) throw new Error("STOP: this folder is linked to another team");
  if (link.projectName !== PROJECT) throw new Error("STOP: this folder is linked to another project");
  const env = parseEnv(readFileSync(resolve(HERE, ".env.local"), "utf8"));
  const token = env.VERCEL_OIDC_TOKEN;
  if (!token) throw new Error("No VERCEL_OIDC_TOKEN. Run pull-oidc.sh first.");
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  if (claims.owner_id !== TEAM) throw new Error("STOP: the OIDC token is for another team");
  if (claims.project_id !== link.projectId) throw new Error("STOP: the OIDC token is for another project");
  if (claims.exp * 1000 < Date.now()) throw new Error("The OIDC token has expired. Run pull-oidc.sh again.");
  process.env.VERCEL_OIDC_TOKEN = token;
  return { teamId: link.orgId, projectId: link.projectId };
}

/** Reads ONLY the OpenRouter key from the env file named by RMS_ENV_FILE. */
export function loadKey() {
  const file = process.env.RMS_ENV_FILE;
  if (!file) throw new Error("Set RMS_ENV_FILE to the path of the repo's .env.local");
  const key = parseEnv(readFileSync(file, "utf8")).OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY missing in RMS_ENV_FILE");
  return key;
}

/** Model names are settings. They come from the environment of the command, never from code. */
export function model(name = "RMS_BUILD_MODEL") {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} (an id from OpenRouter's model list)`);
  return v;
}

export function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

/** Belt and braces: removes the key from any text before it is printed or saved. */
export function scrubber(key) {
  return (text) => String(text).split(key).join("<OPENROUTER_KEY_REDACTED>");
}

/** A direct call from this machine with the real key. Returns status, headers, parsed body, ms. */
export async function orFetch(key, path, body) {
  const t0 = Date.now();
  const res = await fetch(`${LLM_BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: Object.fromEntries(res.headers), json, text, ms: Date.now() - t0 };
}

export function saveName(name) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, "sandbox-name"), name);
}
export function readName() {
  const f = resolve(OUT, "sandbox-name");
  if (!existsSync(f)) throw new Error("No sandbox name saved. Run create.mjs first.");
  return readFileSync(f, "utf8").trim();
}
export function saveOut(file, text) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, file), text);
}
