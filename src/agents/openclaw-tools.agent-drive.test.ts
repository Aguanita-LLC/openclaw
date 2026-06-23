import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("agent_drive tool registration", () => {
  it("registers the owner-only drive tool for normal agent runs", () => {
    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:discord:direct:operator",
      agentChannel: "discord",
      config: {},
      disablePluginTools: true,
    }).find((candidate) => candidate.name === "agent_drive");

    expect(tool).toBeDefined();
    expect(tool?.ownerOnly).toBe(true);
  });
});
