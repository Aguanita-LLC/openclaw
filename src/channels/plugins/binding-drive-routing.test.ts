import { describe, expect, it } from "vitest";
import { resolveDriveScopedRoute } from "./binding-drive-routing.js";

describe("resolveDriveScopedRoute", () => {
  it("preserves bound-session routing when no drive is active", () => {
    expect(
      resolveDriveScopedRoute({
        text: "please continue",
        prefix: "@target ",
        driveActive: false,
      }),
    ).toEqual({
      target: "bound-session",
      text: "please continue",
    });

    expect(
      resolveDriveScopedRoute({
        text: "@target please continue",
        prefix: "@target ",
        driveActive: false,
      }),
    ).toEqual({
      target: "bound-session",
      text: "@target please continue",
    });
  });

  it("routes active-drive plain text to the binding owner agent", () => {
    expect(
      resolveDriveScopedRoute({
        text: "change course",
        prefix: "@target ",
        driveActive: true,
      }),
    ).toEqual({
      target: "binding-owner-agent",
      text: "change course",
    });
  });

  it("routes active-drive prefixed text to the bound session and strips the prefix", () => {
    expect(
      resolveDriveScopedRoute({
        text: "  @target   inspect the failing test ",
        prefix: "@target ",
        driveActive: true,
      }),
    ).toEqual({
      target: "bound-session",
      text: "inspect the failing test",
    });
  });

  it("keeps empty-after-prefix messages bound so the harness can receive explicit nudges", () => {
    expect(
      resolveDriveScopedRoute({
        text: "@target   ",
        prefix: "@target ",
        driveActive: true,
      }),
    ).toEqual({
      target: "bound-session",
      text: "",
    });
  });
});
