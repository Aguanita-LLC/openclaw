import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("ACP agent drive config", () => {
  it("accepts bounded drive settings and redirect prefix", () => {
    const result = OpenClawSchema.safeParse({
      acp: {
        drive: {
          maxTurns: 6,
          maxWallClockSec: 900,
          idleTimeoutSec: 60,
          redirectPrefix: "@codex ",
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.acp?.drive).toEqual({
      maxTurns: 6,
      maxWallClockSec: 900,
      idleTimeoutSec: 60,
      redirectPrefix: "@codex ",
    });
  });

  it("rejects non-positive bounds and an empty redirect prefix", () => {
    for (const drive of [
      { maxTurns: 0 },
      { maxWallClockSec: 0 },
      { idleTimeoutSec: 0 },
      { redirectPrefix: "" },
    ]) {
      expect(OpenClawSchema.safeParse({ acp: { drive } }).success).toBe(false);
    }
  });
});
