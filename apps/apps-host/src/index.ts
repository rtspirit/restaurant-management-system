// The apps host, wired to the real store. Task N owns this app.
// The RMS web app's address comes from settings (`WEB_URL`), never from code, and is read on
// every request. A plain-http network address counts only in local demo mode and only when it
// is on the local demo list exactly (`originRules` in @rms/contracts, ADR 0012).
// The server answers only under its own name from `APPS_URL`, never under the web app's.
//
// It reads through the platform login today, and ONLY through `readPublishedScreen` (one
// database function: a published version's built file, by mini-app, version and path). That is
// acceptable only because this server runs on the demo laptop and is never deployed. Before it
// is deployed anywhere it gets its own login that can run that one function and nothing else
// (ADR 0009).
import { APPS_HOST, appsHostNames, exactOrigins, originRules } from "@rms/contracts";
import { adminDb, readPublishedScreen } from "@rms/db";
import { createAppsHost } from "./app.js";

const app = createAppsHost({
  read: (appId, versionId, path) => readPublishedScreen(adminDb(), appId, versionId, path),
  shellOrigins: () => exactOrigins(process.env[APPS_HOST.shellEnv], originRules(process.env)),
  ownHosts: () => appsHostNames(exactOrigins(process.env[APPS_HOST.urlEnv], originRules(process.env))),
});

export default app;
