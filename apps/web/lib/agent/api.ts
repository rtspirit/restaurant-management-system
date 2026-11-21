// The build routes the signed-in app talks to: the real RMS API, always.
//
// There is no switch here on purpose. Nothing a page can set (an address, a query string,
// browser storage, a setting) can point the signed-in Build tab at anything else.
// The practice stand-in (`mock.ts`) is used in two places only, and each asks for it by name:
// the gallery pages under /gallery, and the tests.
import { realAgentApi, type AgentApi } from "./client";

export const agentApi: AgentApi = realAgentApi;
