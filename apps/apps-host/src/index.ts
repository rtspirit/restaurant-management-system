// The apps host, wired to the real store. Task N owns this app.
// The RMS web app's address comes from settings (`WEB_URL`), never from code, and is read on
// every request. A plain-http network address in that list counts only in local demo mode
// (`RMS_LOCAL_DEMO=1`, never on a deployed server): `originMode` in @rms/contracts, ADR 0012.
//
// It reads through the platform login today, and ONLY through `readPublishedScreen` (one
// database function: a published version's built file, by mini-app, version and path). That is
// acceptable only because this server runs on the demo laptop and is never deployed. Before it
// is deployed anywhere it gets its own login that can run that one function and nothing else
// (ADR 0009).
import { APPS_HOST, exactOrigins, originMode } from "@rms/contracts";
import { adminDb, readPublishedScreen } from "@rms/db";
import { createAppsHost } from "./app.js";

const app = createAppsHost({
  read: (appId, versionId, path) => readPublishedScreen(adminDb(), appId, versionId, path),
  shellOrigins: () => exactOrigins(process.env[APPS_HOST.shellEnv], originMode(process.env)),
});

export default app;
