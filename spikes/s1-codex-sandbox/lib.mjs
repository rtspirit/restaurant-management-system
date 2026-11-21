// Shared helpers for spike S1. Throwaway code.
// Rule: the OpenAI key is read here and goes ONLY into the firewall rule. It is never printed,
// never written to a file, and never passed into the sandbox as an env var, argument or file.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT = resolve(HERE, "out"); // git-ignored
const TEAM = "team_RM4toarAtl8vljERLdxRvfeh";
const PROJECT = "rms-api";

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

/** Reads the OpenAI key and the build model name from the env file named by RMS_ENV_FILE. */
export function loadOpenAI() {
  const file = process.env.RMS_ENV_FILE;
  if (!file) throw new Error("Set RMS_ENV_FILE to the path of the repo's .env.local");
  const env = parseEnv(readFileSync(file, "utf8"));
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing in RMS_ENV_FILE");
  if (!env.RMS_BUILD_MODEL) throw new Error("RMS_BUILD_MODEL missing in RMS_ENV_FILE");
  return { key: env.OPENAI_API_KEY, model: process.env.RMS_BUILD_MODEL_OVERRIDE || env.RMS_BUILD_MODEL };
}

/** The build model name only (no key is read into a variable the caller sees). */
export function loadModelName() {
  return loadOpenAI().model;
}

export function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

/** Belt and braces: removes the key from any text before it is printed or saved. */
export function scrubber(key) {
  return (text) => String(text).split(key).join("<OPENAI_KEY_REDACTED>");
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
