export type DriveScopedRouteTarget = "binding-owner-agent" | "bound-session";

export type DriveScopedRouteResult = {
  target: DriveScopedRouteTarget;
  text: string;
};

export function resolveDriveScopedRoute(input: {
  text: string;
  prefix: string;
  driveActive: boolean;
}): DriveScopedRouteResult {
  if (!input.driveActive) {
    return {
      target: "bound-session",
      text: input.text,
    };
  }

  const normalizedPrefix = input.prefix.trim();
  if (!normalizedPrefix) {
    return {
      target: "binding-owner-agent",
      text: input.text,
    };
  }

  const leadingTrimmed = input.text.trimStart();
  if (!leadingTrimmed.startsWith(normalizedPrefix)) {
    return {
      target: "binding-owner-agent",
      text: input.text,
    };
  }

  return {
    target: "bound-session",
    text: leadingTrimmed.slice(normalizedPrefix.length).trim(),
  };
}
