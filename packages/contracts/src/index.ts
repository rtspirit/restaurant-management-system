// @rms/contracts: shared zod schemas and types. Owned by the lead. Ask the lead for changes.
// 0.4.0 (Wave 2): build sessions and the event stream, the frame hand-off, the build agent's
// tools and the app template, connections and Demo POS, Ask, memory and duplicates.
// 0.5.0 (Wave 3): where mini-app code is kept, publish and the apps host, change detectors and
// the owner's side of a change, held actions, sharing, listings, installing, recommendations.
export const CONTRACTS_VERSION = "0.5.0";

export * from "./ids.js";
export * from "./auth.js";
export * from "./models.js";
export * from "./data-api.js";
export * from "./manifest.js";
export * from "./agent.js";
export * from "./frame.js";
export * from "./build.js";
export * from "./mcp.js";
export * from "./ask.js";
export * from "./memory.js";
export * from "./governance.js";
export * from "./objects.js";
export * from "./publish.js";
export * from "./changes.js";
export * from "./marketplace.js";
export * from "./platform.js";
export * from "./storage.js";
