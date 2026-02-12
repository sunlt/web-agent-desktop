import { describe, expect, test } from "vitest";
import type { RuntimeManifest } from "../src/domain/runtime-manifest.js";
import {
  buildRestorePlan,
  RestorePlanValidationError,
  validateRequiredPaths,
} from "../src/services/restore-plan.js";

describe("restore-plan", () => {
  test("should default conflictPolicy to keep_session", () => {
    const plan = buildRestorePlan({
      appId: "code-assistant",
      projectName: "default",
      userLoginName: "alice",
      sessionId: "sess-01",
      runtimeVersion: "2026.02.12",
      manifest: baseManifest({
        conflictPolicy: undefined,
      }),
    });

    expect(plan.conflictPolicy).toBe("keep_session");
    expect(plan.entries.map((entry) => entry.layer)).toEqual([
      "registry_base",
      "session_overlay",
      "knowledge_overlay",
      "knowledge_overlay",
      "user_overlay",
      "runtime_fixups",
    ]);
  });

  test("should reject non-workspace protected path", () => {
    expect(() =>
      buildRestorePlan({
        appId: "code-assistant",
        projectName: "default",
        userLoginName: "alice",
        sessionId: "sess-01",
        runtimeVersion: "2026.02.12",
        manifest: baseManifest({
          protectedPaths: ["/etc/passwd"],
        }),
      }),
    ).toThrow(RestorePlanValidationError);
  });

  test("should detect missing required paths", () => {
    const validation = validateRequiredPaths(
      ["/workspace/.agent_data", "/workspace/.kb/app"],
      ["/workspace/.agent_data"],
    );

    expect(validation.ok).toBe(false);
    expect(validation.missingRequiredPaths).toEqual(["/workspace/.kb/app"]);
  });
});

function baseManifest(
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    appId: "code-assistant",
    runtimeVersion: "2026.02.12",
    workspaceTemplatePrefix:
      "app/code-assistant/registry/runtime/2026.02.12/template/",
    requiredPaths: ["/workspace/.agent_data"],
    seedFiles: [],
    mountPoints: [],
    conflictPolicy: "keep_session",
    protectedPaths: ["/workspace/.agent_data"],
    cleanupRules: [],
    ...overrides,
  };
}
