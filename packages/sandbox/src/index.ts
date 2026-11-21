// @rms/sandbox: where a mini-app is built and previewed. Task I owns this package.
// Brief: docs/briefs/wave2.md, task I.
//
// What goes here: `SandboxProvider` (create, find again by name, run a command, read and write
// files, preview address, stop) with two implementations: Vercel Sandbox (the real one, facts
// in docs/spikes and docs/reference/verified-apis.md section 3) and a local one for tests that
// runs commands in a temporary folder on this machine and never starts the real agent.
//
// The wall: one sandbox per build session. Its only open address is the model provider, with
// the key added by the firewall from outside. No RMS credential of any kind goes in.
export {};
