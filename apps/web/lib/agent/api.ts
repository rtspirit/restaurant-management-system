// Which build routes the app talks to. This is the ONE place that decides.
//
// Until the real event stream is merged (Wave 2, task I) the default is the practice stand-in:
// it runs in the browser, builds nothing and saves nothing, and the build screen says so.
// To use the real RMS API, set NEXT_PUBLIC_RMS_AGENT=real, or change "practice" to "real" on
// the line below. Nothing else in the app needs to change.
import { realAgentApi, type AgentApi } from "./client";
import { practiceAgentApi } from "./mock";

const DEFAULT_SOURCE: "practice" | "real" = "practice";

const asked = process.env.NEXT_PUBLIC_RMS_AGENT;
const source = asked === "real" || asked === "practice" ? asked : DEFAULT_SOURCE;

export const agentApi: AgentApi = source === "real" ? realAgentApi : practiceAgentApi;
