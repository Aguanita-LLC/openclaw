import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams as baseParams,
} from "./run.overflow-compaction.harness.js";
import { ModelCallBudgetExceededError } from "./run/model-call-budget.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("model-call budget handling in runEmbeddedPiAgent", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    mockedRunEmbeddedAttempt.mockReset();
  });

  it("surfaces budget exhaustion without retrying another attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: new ModelCallBudgetExceededError(10, 10),
        promptErrorSource: "prompt",
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads[0]?.isError).toBe(true);
    expect(result.payloads[0]?.text).toContain("Model call budget exceeded");
    expect(result.meta.error).toMatchObject({ kind: "model_call_budget_exceeded" });
  });
});
