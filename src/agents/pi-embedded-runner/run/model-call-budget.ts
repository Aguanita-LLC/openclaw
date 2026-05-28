import type { StreamFn } from "@mariozechner/pi-agent-core";

export class ModelCallBudgetExceededError extends Error {
  readonly callCount: number;
  readonly threshold: number;

  constructor(callCount: number, threshold: number) {
    super(
      `Model call budget exceeded (${callCount}/${threshold} calls): run aborted to prevent runaway inference loop.`,
    );
    this.name = "ModelCallBudgetExceededError";
    this.callCount = callCount;
    this.threshold = threshold;
  }
}

export function isModelCallBudgetExceededError(
  error: unknown,
): error is ModelCallBudgetExceededError {
  return (
    error instanceof ModelCallBudgetExceededError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "ModelCallBudgetExceededError" &&
      typeof (error as { callCount?: unknown }).callCount === "number" &&
      typeof (error as { threshold?: unknown }).threshold === "number")
  );
}

export function wrapStreamFnWithModelCallBudget(
  baseFn: StreamFn,
  options: { criticalThreshold: number; onExceeded?: () => void },
): StreamFn {
  const { criticalThreshold, onExceeded } = options;
  if (!Number.isFinite(criticalThreshold) || criticalThreshold <= 0) {
    return baseFn;
  }

  let callCount = 0;
  let exceeded = false;

  return ((model, context, opts) => {
    callCount += 1;
    if (callCount >= criticalThreshold) {
      if (!exceeded) {
        exceeded = true;
        onExceeded?.();
      }
      throw new ModelCallBudgetExceededError(callCount, criticalThreshold);
    }
    return baseFn(model, context, opts);
  }) as StreamFn;
}
