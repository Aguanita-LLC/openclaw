import { describe, expect, it } from "vitest";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema tools.loopDetection.postCompactionGuard validation", () => {
  it("accepts tools.loopDetection.postCompactionGuard configuration", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          enabled: true,
          postCompactionGuard: {
            windowSize: 5,
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty postCompactionGuard object", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          postCompactionGuard: {},
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys under tools.loopDetection.postCompactionGuard", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          postCompactionGuard: {
            windowSize: 3,
            bogus: "key",
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive windowSize", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          postCompactionGuard: {
            windowSize: 0,
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer windowSize", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          postCompactionGuard: {
            windowSize: 2.5,
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("validates via ToolsSchema directly", () => {
    const result = ToolsSchema.safeParse({
      loopDetection: {
        postCompactionGuard: { windowSize: 4 },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts tools.loopDetection.modelCallBudget configuration", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          enabled: true,
          modelCallBudget: { criticalThreshold: 10 },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts criticalThreshold 0 to disable modelCallBudget", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          modelCallBudget: { criticalThreshold: 0 },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys under tools.loopDetection.modelCallBudget", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          modelCallBudget: { criticalThreshold: 10, bogus: true },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative modelCallBudget criticalThreshold", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          modelCallBudget: { criticalThreshold: -1 },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer modelCallBudget criticalThreshold", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          modelCallBudget: { criticalThreshold: 2.5 },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an empty modelCallBudget object", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          modelCallBudget: {},
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
