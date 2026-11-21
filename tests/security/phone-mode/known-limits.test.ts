// KNOWN LIMITS of the local demo on a shared network (ADR 0010, security review of phone mode).
//
// Same rule as tests/security/db/known-limits.test.ts: each test DOCUMENTS a weak spot that is open
// today. It asserts the weak spot is still there. The day one is fixed, its test fails: delete it,
// add the opposite test to the real suite, and update the ADR. Do not loosen a failing test here.
//
// Why they matter: while the laptop is on a network other people are on, each of these is open to
// anyone on that network. The containment today is the network itself (the phone's own hotspot).
//
// Nothing here changes anything: the two live checks are one read each, against the local sign-in service only.
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoPath } from "../helpers/env.js";

const script = readFileSync(repoPath("scripts/demo-phone.sh"), "utf8");
const signIn = () => `${(process.env.SUPABASE_URL as string).replace(/\/$/, "")}/auth/v1`;

describe("KNOWN LIMIT (ADR 0010): a stranger on the same network can make an account and a restaurant", () => {
  it("KNOWN LIMIT: the local sign-in service takes new sign-ups from anyone, with no email check", async () => {
    const res = await fetch(`${signIn()}/settings`, { headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY as string } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disable_signup?: boolean; mailer_autoconfirm?: boolean };
    // Today: open, and a new account is signed in at once. Fix: enable_signup = false in supabase/config.toml
    // (takes effect at the next container start) once the demo accounts exist.
    expect(body.disable_signup).toBe(false);
    expect(body.mailer_autoconfirm).toBe(true);
  });

});

describe("FIXED (was a known limit): phone mode can stop new restaurants while the demo is open to the network", () => {
  it("start --no-signups gives the API it starts RMS_MAX_RESTAURANTS=0, and nothing else does", () => {
    // Any signed-in account without a restaurant may call POST /auth/onboarding and become the owner of a
    // new one, up to RMS_MAX_RESTAURANTS (default 25). An owner can start build runs, which spend the model key.
    // Off by default, because the demo itself signs up a restaurant. The cap lives only in the API process the
    // script starts, so "stop" ends it with that process.
    const apiStart = script.split("\n").find((l) => l.includes("start_bg api "));
    expect(apiStart).toContain("${no_signups:+RMS_MAX_RESTAURANTS=0}");
    expect(script).toMatch(/--no-signups\) no_signups=1 ;;/);
    expect(script.match(/RMS_MAX_RESTAURANTS=0/g)?.length).toBeGreaterThanOrEqual(1);
    for (const line of script.split("\n").filter((l) => l.includes("start_bg ") && !l.includes("start_bg api ") && !l.trim().startsWith("#") && !l.includes("start_bg()"))) {
      expect(line, line).not.toContain("RMS_MAX_RESTAURANTS");
    }
  });
});

describe("KNOWN LIMIT (local stack): the sign-in service's own keys are the same on every machine", () => {
  it("KNOWN LIMIT: a service token made from the published default signing secret can list the users", async () => {
    // The local Supabase stack ships with documented default keys. Anyone who can reach port 54321 can use them
    // to list users, set any user's password (the owner's, the maintainer's) and so sign in as them.
    // On 127.0.0.1 that is this laptop only. Docker publishes the port on every address, so on a shared network
    // it is everyone. Fix: publish the local stack on 127.0.0.1 only and reach sign-in from the phone through the web app.
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "service_role", iss: "supabase-demo", iat: now, exp: now + 60 })}`;
    const defaultSecret = ["super", "secret", "jwt", "token", "with", "at", "least", "32", "characters", "long"].join("-");
    const forged = `${head}.${createHmac("sha256", defaultSecret).update(head).digest("base64url")}`;
    const res = await fetch(`${signIn()}/admin/users?page=1&per_page=1`, { headers: { apikey: forged, authorization: `Bearer ${forged}` } });
    // Never echo the body: it holds user records.
    await res.arrayBuffer();
    expect(res.status).toBe(200);
  });
});

describe("KNOWN LIMIT (Wave 3): the mini-app host answers on every name of the laptop", () => {
  it("KNOWN LIMIT: phone mode starts the mini-app host on every address and gives it no host to insist on", () => {
    // The session cookie belongs to the web app's host and scripts can read it. Cookies ignore the port. The
    // mini-app host is advertised on the laptop's OTHER name, but started like this it also answers on the web
    // app's name (http://<mac>.local:3002/...), and a mini-app opened there can read the owner's session.
    // Fix (task N): the mini-app host refuses any request whose Host is not exactly the host of APPS_URL.
    const line = script.split("\n").find((l) => l.includes("start_bg apps "));
    expect(line).toBeDefined();
    expect(line).toContain("HOSTNAME=0.0.0.0");
    expect(line).not.toMatch(/ALLOWED_HOST|APPS_HOST=|ONLY_HOST/);
    // It is not built yet, so nothing is exposed today. When it is, replace this test with a live one.
    expect(existsSync(repoPath("apps/apps-host/package.json"))).toBe(false);
  });
});
