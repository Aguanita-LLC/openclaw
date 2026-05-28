import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";

describe("resolveToolLoopDetectionConfig", () => {
  it("keeps global modelCallBudget when the agent has no override", () => {
    const config = {
      tools: {
        loopDetection: {
          modelCallBudget: { criticalThreshold: 10 },
        },
      },
      agents: {
        list: [{ id: "main", workspace: "/tmp/main" }],
      },
    } as OpenClawConfig;

    expect(
      resolveToolLoopDetectionConfig({ cfg: config, agentId: "main" })?.modelCallBudget,
    ).toEqual({ criticalThreshold: 10 });
  });

  it("lets agent modelCallBudget criticalThreshold override the global value", () => {
    const config = {
      tools: {
        loopDetection: {
          modelCallBudget: { criticalThreshold: 10 },
        },
      },
      agents: {
        list: [
          {
            id: "main",
            workspace: "/tmp/main",
            tools: {
              loopDetection: {
                modelCallBudget: { criticalThreshold: 4 },
              },
            },
          },
        ],
      },
    } as OpenClawConfig;

    expect(
      resolveToolLoopDetectionConfig({ cfg: config, agentId: "main" })?.modelCallBudget,
    ).toEqual({ criticalThreshold: 4 });
  });
});
