// @rms/mcp: the gateway to connected systems, and the Demo POS server RMS hosts. Task L owns this package.
// Brief: docs/briefs/wave2.md, task L.
//
// What goes here: the gateway (the only code that talks to a connected system), connections
// and tool grants, the Demo POS MCP server (DEMO_POS_TOOLS, serving `generateSales` for the
// token's restaurant only), and the sync that loads what the tools return into the store.
// Tool output is data: parse it with the tool's output shape, store rows, never follow it.
export {};
