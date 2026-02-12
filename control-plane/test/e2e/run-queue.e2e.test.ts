import { describe, expect, test } from "vitest";
import { createControlPlaneApp } from "../../src/app.js";
import type {
  AgentProviderAdapter,
  ProviderRunHandle,
  ProviderRunInput,
  ProviderStreamChunk,
} from "../../src/providers/types.js";
import { withHttpServer } from "./http-test-utils.js";

class QueueE2EProviderAdapter implements AgentProviderAdapter {
  readonly kind = "opencode" as const;
  readonly capabilities = {
    resume: true,
    humanLoop: false,
    todoStream: false,
    buildPlanMode: true,
  };

  private attempts = 0;

  async run(_input: ProviderRunInput): Promise<ProviderRunHandle> {
    this.attempts += 1;
    const chunks: ProviderStreamChunk[] =
      this.attempts === 1
        ? [{ type: "run.finished", status: "failed" }]
        : [{ type: "run.finished", status: "succeeded" }];

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

describe("Run Queue API E2E", () => {
  test("should enqueue, retry, and finish run via queue drain", async () => {
    const app = createControlPlaneApp({
      providerAdapters: [new QueueE2EProviderAdapter()],
    });

    await withHttpServer(app, async (baseUrl) => {
      const enqueue = await fetch(`${baseUrl}/api/runs/queue/enqueue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "run-queue-e2e-1",
          sessionId: "sess-queue-e2e-1",
          provider: "opencode",
          model: "openai/gpt-5.1-codex",
          messages: [{ role: "user", content: "start" }],
          maxAttempts: 3,
        }),
      });
      expect(enqueue.status).toBe(202);
      expect(await enqueue.json()).toEqual({
        accepted: true,
        runId: "run-queue-e2e-1",
      });

      const firstDrain = await fetch(`${baseUrl}/api/runs/queue/drain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          limit: 1,
          retryDelayMs: 0,
        }),
      });
      expect(firstDrain.status).toBe(200);
      expect(await firstDrain.json()).toEqual({
        claimed: 1,
        succeeded: 0,
        retried: 1,
        failed: 0,
        canceled: 0,
      });

      const queued = await fetch(`${baseUrl}/api/runs/queue/run-queue-e2e-1`);
      expect(queued.status).toBe(200);
      const queuedBody = (await queued.json()) as {
        status: string;
        attempts: number;
      };
      expect(queuedBody.status).toBe("queued");
      expect(queuedBody.attempts).toBe(1);

      const secondDrain = await fetch(`${baseUrl}/api/runs/queue/drain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          limit: 1,
          retryDelayMs: 0,
        }),
      });
      expect(secondDrain.status).toBe(200);
      expect(await secondDrain.json()).toEqual({
        claimed: 1,
        succeeded: 1,
        retried: 0,
        failed: 0,
        canceled: 0,
      });

      const finished = await fetch(`${baseUrl}/api/runs/queue/run-queue-e2e-1`);
      expect(finished.status).toBe(200);
      const finishedBody = (await finished.json()) as {
        status: string;
        attempts: number;
      };
      expect(finishedBody.status).toBe("succeeded");
      expect(finishedBody.attempts).toBe(2);

      const duplicate = await fetch(`${baseUrl}/api/runs/queue/enqueue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "run-queue-e2e-1",
          sessionId: "sess-queue-e2e-1",
          provider: "opencode",
          model: "openai/gpt-5.1-codex",
          messages: [{ role: "user", content: "start" }],
        }),
      });
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toEqual({
        accepted: false,
        runId: "run-queue-e2e-1",
      });
    });
  });
});
