import { describe, expect, test } from "vitest";
import { createControlPlaneApp } from "../../src/app.js";
import { withHttpServer } from "./http-test-utils.js";

describe("Restore Plan API E2E", () => {
  test("should block with 422 when required paths are missing", async () => {
    const app = createControlPlaneApp({
      providerAdapters: [],
    });

    await withHttpServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/runs/restore-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "code-assistant",
          projectName: "default",
          userLoginName: "alice",
          sessionId: "sess-restore-1",
          runtimeVersion: "2026.02.12",
          manifest: {
            appId: "code-assistant",
            runtimeVersion: "2026.02.12",
            workspaceTemplatePrefix:
              "app/code-assistant/registry/runtime/2026.02.12/template/",
            requiredPaths: ["/workspace/.agent_data", "/workspace/.kb/app"],
            seedFiles: [],
            mountPoints: [],
            conflictPolicy: "keep_session",
            protectedPaths: ["/workspace/.agent_data"],
            cleanupRules: [],
          },
          existingPaths: ["/workspace/.agent_data"],
        }),
      });

      expect(response.status).toBe(422);
      const body = (await response.json()) as {
        ok: boolean;
        reason: string;
        missingRequiredPaths: string[];
      };
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("required_paths_missing");
      expect(body.missingRequiredPaths).toEqual(["/workspace/.kb/app"]);
    });
  });

  test("should return executor-consumable restore plan when validation passes", async () => {
    const app = createControlPlaneApp({
      providerAdapters: [],
    });

    await withHttpServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/runs/restore-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "code-assistant",
          projectName: "default",
          userLoginName: "alice",
          sessionId: "sess-restore-2",
          runtimeVersion: "2026.02.12",
          manifest: {
            appId: "code-assistant",
            runtimeVersion: "2026.02.12",
            workspaceTemplatePrefix:
              "app/code-assistant/registry/runtime/2026.02.12/template/",
            requiredPaths: ["/workspace/.agent_data", "/workspace/.kb/app"],
            seedFiles: [
              {
                from: "app/code-assistant/registry/runtime/2026.02.12/seeds/README.md",
                to: "/workspace/README.md",
                ifMissingOnly: true,
              },
            ],
            mountPoints: [
              {
                name: "app_kb",
                targetPath: "/workspace/.kb/app",
                readOnly: true,
              },
            ],
            protectedPaths: ["/workspace/.agent_data"],
            cleanupRules: [
              {
                action: "remove_if_exists",
                path: "/workspace/.tmp",
              },
            ],
          },
          existingPaths: ["/workspace/.agent_data", "/workspace/.kb/app"],
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        plan: {
          conflictPolicy: string;
          entries: Array<{ layer: string }>;
          requiredPaths: string[];
          seedFiles: Array<{ to: string }>;
        };
      };

      expect(body.ok).toBe(true);
      expect(body.plan.conflictPolicy).toBe("keep_session");
      expect(body.plan.requiredPaths).toEqual([
        "/workspace/.agent_data",
        "/workspace/.kb/app",
      ]);
      expect(body.plan.seedFiles[0]?.to).toBe("/workspace/README.md");
      expect(body.plan.entries.some((entry) => entry.layer === "runtime_fixups")).toBe(true);
    });
  });
});
