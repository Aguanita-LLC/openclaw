import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  isModelCallBudgetExceededError,
  ModelCallBudgetExceededError,
  wrapStreamFnWithModelCallBudget,
} from "./model-call-budget.js";

type FnParams = Parameters<StreamFn>;
const dummyModel = {} as FnParams[0];
const dummyCtx = {} as FnParams[1];
const dummyOpts = {} as FnParams[2];

function makeBaseFn(): StreamFn {
  const mockStream = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  return vi.fn().mockReturnValue(mockStream) as unknown as StreamFn;
}

describe("wrapStreamFnWithModelCallBudget", () => {
  it("allows N-1 calls through without throwing", () => {
    const baseFn = makeBaseFn();
    const wrapped = wrapStreamFnWithModelCallBudget(baseFn, { criticalThreshold: 3 });

    expect(() => wrapped(dummyModel, dummyCtx, dummyOpts)).not.toThrow();
    expect(() => wrapped(dummyModel, dummyCtx, dummyOpts)).not.toThrow();
    expect(vi.mocked(baseFn)).toHaveBeenCalledTimes(2);
  });

  it("throws ModelCallBudgetExceededError on the N-th call before calling baseFn", () => {
    const baseFn = makeBaseFn();
    const wrapped = wrapStreamFnWithModelCallBudget(baseFn, { criticalThreshold: 3 });

    wrapped(dummyModel, dummyCtx, dummyOpts);
    wrapped(dummyModel, dummyCtx, dummyOpts);

    expect(() => wrapped(dummyModel, dummyCtx, dummyOpts)).toThrow(ModelCallBudgetExceededError);
    expect(vi.mocked(baseFn)).toHaveBeenCalledTimes(2);
  });

  it("calls onExceeded exactly once even if called again after exceeding", () => {
    const onExceeded = vi.fn();
    const baseFn = makeBaseFn();
    const wrapped = wrapStreamFnWithModelCallBudget(baseFn, {
      criticalThreshold: 2,
      onExceeded,
    });

    wrapped(dummyModel, dummyCtx, dummyOpts);
    expect(() => wrapped(dummyModel, dummyCtx, dummyOpts)).toThrow(ModelCallBudgetExceededError);
    expect(() => wrapped(dummyModel, dummyCtx, dummyOpts)).toThrow(ModelCallBudgetExceededError);
    expect(onExceeded).toHaveBeenCalledTimes(1);
  });

  it("criticalThreshold 0 disables the budget", () => {
    const baseFn = makeBaseFn();
    const wrapped = wrapStreamFnWithModelCallBudget(baseFn, { criticalThreshold: 0 });

    for (let i = 0; i < 20; i += 1) {
      wrapped(dummyModel, dummyCtx, dummyOpts);
    }
    expect(vi.mocked(baseFn)).toHaveBeenCalledTimes(20);
  });

  it("threshold 1 throws on the first call and works without onExceeded", () => {
    const baseFn = makeBaseFn();
    const wrapped = wrapStreamFnWithModelCallBudget(baseFn, { criticalThreshold: 1 });

    expect(() => wrapped(dummyModel, dummyCtx, dummyOpts)).toThrow(ModelCallBudgetExceededError);
    expect(vi.mocked(baseFn)).not.toHaveBeenCalled();
  });

  it("recognizes compatible budget errors by name", () => {
    const err = Object.assign(new Error("budget"), {
      name: "ModelCallBudgetExceededError",
      callCount: 3,
      threshold: 3,
    });

    expect(isModelCallBudgetExceededError(err)).toBe(true);
  });
});
