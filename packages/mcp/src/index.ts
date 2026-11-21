// @rms/mcp: the gateway to connected systems, and the Demo POS server RMS hosts. Task L.
// Brief: docs/briefs/wave2.md, task L. Notes: docs/briefs/wave2-task-l-notes.md.
//
// The gateway (gateway.ts) is the only code that talks to a connected system. Tool output is
// data: it is parsed with the tool's output shape and never followed.
export * from "./gateway.js";
export * from "./connections.js";
export * from "./sync.js";
export { buildDemoPosServer, demoPosCaller, serveDemoPos, type DemoPosCaller } from "./demo-pos/server.js";
export { demoPosAnswer } from "./demo-pos/data.js";
