import { describe, expect, test } from "vitest";
import { createControlPlaneApp } from "../../src/app.js";
import type {
  AgentProviderAdapter,
  ProviderRunHandle,
  ProviderRunInput,
  ProviderStreamChunk,
} from "../../src/providers/types.js";
import { withHttpServer } from "./http-test-utils.js";

class E2EProviderAdapter implements AgentProviderAdapter {
  readonly kind = "opencode" as const;
  readonly capabilities = {
    resume: true,
    humanLoop: false,
    todoStream: true,
    buildPlanMode: true,
  };

  async run(input: ProviderRunInput): Promise<ProviderRunHandle> {
    const chunks: ProviderStreamChunk[] = [
      {
        type: "message.delta",
        text: `echo:${input.messages.length}`,
      },
      {
        type: "todo.update",
        todo: {
          todoId: "todo-e2e-1",
          content: "执行 E2E 任务",
          status: "doing",
          order: 1,
        },
      },
      {
        type: "run.finished",
        status: "succeeded",
        usage: {
          inputTokens: 12,
          outputTokens: 34,
        },
      },
    ];

    return {
      stream: async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
      stop: async () => {},
    };
  }
}

describe("Runs API E2E", () => {
  test("POST /api/runs/start should return streamed events and final snapshot", async () => {
    const app = createControlPlaneApp({
      providerAdapters: [new E2EProviderAdapter()],
    });

    await withHttpServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/runs/start`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          runId: "run-e2e-1",
          provider: "opencode",
          model: "openai/gpt-5.1-codex",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        accepted: boolean;
        events: Array<{
          type: string;
          status?: string;
          text?: string;
          todo?: { todoId: string; status: string };
        }>;
        snapshot: { runId: string; status: string };
      };

      expect(data.accepted).toBe(true);
      expect(data.snapshot.runId).toBe("run-e2e-1");
      expect(data.snapshot.status).toBe("succeeded");

      expect(data.events.some((item) => item.type === "run.status" && item.status === "started")).toBe(
        true,
      );
      expect(data.events.some((item) => item.type === "message.delta" && item.text === "echo:1")).toBe(
        true,
      );
      expect(
        data.events.some(
          (item) =>
            item.type === "todo.update" &&
            item.todo?.todoId === "todo-e2e-1" &&
            item.todo.status === "doing",
        ),
      ).toBe(true);
      expect(
        data.events.some(
          (item) => item.type === "run.status" && item.status === "finished",
        ),
      ).toBe(true);
    });
  });
});
