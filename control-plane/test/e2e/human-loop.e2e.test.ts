import { describe, expect, test } from "vitest";
import { createControlPlaneApp } from "../../src/app.js";
import type {
  AgentProviderAdapter,
  ProviderRunHandle,
  ProviderRunInput,
} from "../../src/providers/types.js";
import { withHttpServer } from "./http-test-utils.js";

class HumanLoopUnsupportedProvider implements AgentProviderAdapter {
  readonly kind = "opencode" as const;
  readonly capabilities = {
    resume: true,
    humanLoop: false,
    todoStream: true,
    buildPlanMode: true,
  };

  async run(_: ProviderRunInput): Promise<ProviderRunHandle> {
    throw new Error("should not run when human-loop is required");
  }
}

class HumanLoopSupportedProvider implements AgentProviderAdapter {
  readonly kind = "claude-code" as const;
  readonly capabilities = {
    resume: true,
    humanLoop: true,
    todoStream: true,
    buildPlanMode: false,
  };

  async run(_: ProviderRunInput): Promise<ProviderRunHandle> {
    return {
      stream: async function* () {
        yield {
          type: "message.delta" as const,
          text: "human-loop-ready",
        };
        yield {
          type: "run.finished" as const,
          status: "succeeded",
        };
      },
      stop: async () => {},
    };
  }
}

describe("Human Loop E2E", () => {
  test("should return 409 when provider does not support required human-loop", async () => {
    const app = createControlPlaneApp({
      providerAdapters: [new HumanLoopUnsupportedProvider()],
    });

    await withHttpServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/runs/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "opencode",
          model: "openai/gpt-5.1-codex",
          messages: [{ role: "user", content: "请执行任务" }],
          requireHumanLoop: true,
        }),
      });

      expect(response.status).toBe(409);
      const body = (await response.json()) as {
        accepted: boolean;
        reason: string;
      };
      expect(body.accepted).toBe(false);
      expect(body.reason).toContain("human-loop");
    });
  });

  test("should accept run when provider supports required human-loop", async () => {
    const app = createControlPlaneApp({
      providerAdapters: [new HumanLoopSupportedProvider()],
    });

    await withHttpServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/runs/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "run-human-loop-ok",
          provider: "claude-code",
          model: "sonnet",
          messages: [{ role: "user", content: "继续执行" }],
          requireHumanLoop: true,
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        accepted: boolean;
        events: Array<{ type: string; status?: string; text?: string }>;
        snapshot: { status: string };
      };
      expect(body.accepted).toBe(true);
      expect(body.events.some((item) => item.type === "message.delta" && item.text === "human-loop-ready")).toBe(true);
      expect(
        body.events.some(
          (item) => item.type === "run.status" && item.status === "finished",
        ),
      ).toBe(true);
      expect(body.snapshot.status).toBe("succeeded");
    });
  });
});
