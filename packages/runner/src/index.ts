// @rms/runner: runs a build session. Task I owns this package.
// Brief: docs/briefs/wave2.md, task I.
//
// What goes here: the session and run store (events numbered across the session), the planner
// (questions, plan, model changes through the platform), the Codex driver (AgentDriver:
// start, read, stop), the pump that turns driver events into owner-safe AgentEvents and stores
// them, the checks done from outside the sandbox, usage recording, and cancel.
// The build agent's prompts live in src/prompts/ and start from AGENT_RULES in @rms/contracts.
export {};
