// AGENTS.md must carry the shared rule lines word for word (AGENT_RULES in @rms/contracts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENT_RULES, BUILD_TOOL_CLI, EDITABLE_TEMPLATE_FOLDERS } from "@rms/contracts";
import { describe, expect, it } from "vitest";

const text = readFileSync(fileURLToPath(new URL("../AGENTS.md", import.meta.url)), "utf8");

describe("AGENTS.md", () => {
  it.each([...AGENT_RULES.conversation, AGENT_RULES.untrusted, ...AGENT_RULES.limits])("says: %s", (line) => {
    expect(text).toContain(line);
  });

  it("names the tool command and the folders the agent may write in", () => {
    expect(text).toContain(BUILD_TOOL_CLI.command.join(" "));
    for (const folder of EDITABLE_TEMPLATE_FOLDERS) expect(text).toContain(folder);
  });
});
