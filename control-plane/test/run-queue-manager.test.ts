import { describe, expect, test } from "vitest";
import { InMemoryRunQueueRepository } from "../src/repositories/in-memory-run-queue-repository.js";
import { ProviderRegistry } from "../src/providers/provider-registry.js";
import type {
  AgentProviderAdapter,
  ProviderRunHandle,
  ProviderRunInput,
  ProviderStreamChunk,
} from "../src/providers/types.js";
import { RunOrchestrator } from "../src/services/run-orchestrator.js";
import { RunQueueManager } from "../src/services/run-queue-manager.js";

class RetryProviderAdapter implements AgentProviderAdapter {
  readonly kind = "opencode" as const;
  readonly capabilities = {
    resume: true,
    humanLoop: false,
    todoStream: false,
    buildPlanMode: true,
  };

  private callCount = 0;

  async run(_input: ProviderRunInput): Promise<ProviderRunHandle> {
    this.callCount += 1;
    const shouldFail = this.callCount === 1;

    const chunks: ProviderStreamChunk[] = shouldFail
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

describe("RunQueueManager", () => {
  test("should retry failed run and then mark succeeded", async () => {
    const queueRepo = new InMemoryRunQueueRepository();
    const provider = new RetryProviderAdapter();
    const orchestrator = new RunOrchestrator(new ProviderRegistry([provider]));
    const manager = new RunQueueManager(queueRepo, orchestrator, {
      owner: "mgr-test",
      lockMs: 10_000,
      retryDelayMs: 0,
    });

    const enqueue = await manager.enqueueRun({
      runId: "run-queue-1",
      sessionId: "sess-1",
      provider: "opencode",
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      maxAttempts: 3,
    });
    expect(enqueue).toEqual({ accepted: true, runId: "run-queue-1" });

    const firstDrain = await manager.drainOnce({ limit: 1, retryDelayMs: 0 });
    expect(firstDrain).toEqual({
      claimed: 1,
      succeeded: 0,
      retried: 1,
      failed: 0,
      canceled: 0,
    });

    const afterFirst = await manager.getQueueItem("run-queue-1");
    expect(afterFirst?.status).toBe("queued");
    expect(afterFirst?.attempts).toBe(1);

    const secondDrain = await manager.drainOnce({ limit: 1, retryDelayMs: 0 });
    expect(secondDrain).toEqual({
      claimed: 1,
      succeeded: 1,
      retried: 0,
      failed: 0,
      canceled: 0,
    });

    const afterSecond = await manager.getQueueItem("run-queue-1");
    expect(afterSecond?.status).toBe("succeeded");
    expect(afterSecond?.attempts).toBe(2);
  });

  test("should reclaim expired claimed run", async () => {
    const repo = new InMemoryRunQueueRepository();
    const now = new Date("2026-02-12T10:00:00.000Z");

    await repo.enqueue({
      runId: "run-queue-2",
      sessionId: "sess-2",
      provider: "opencode",
      maxAttempts: 3,
      payload: {
        sessionId: "sess-2",
        provider: "opencode",
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      },
      now,
    });

    const firstClaim = await repo.claimNext({
      owner: "mgr-a",
      now,
      lockMs: 1_000,
    });
    expect(firstClaim?.runId).toBe("run-queue-2");
    expect(firstClaim?.attempts).toBe(1);

    const secondClaim = await repo.claimNext({
      owner: "mgr-b",
      now: new Date(now.getTime() + 500),
      lockMs: 1_000,
    });
    expect(secondClaim).toBeNull();

    const recovered = await repo.claimNext({
      owner: "mgr-b",
      now: new Date(now.getTime() + 1_500),
      lockMs: 1_000,
    });
    expect(recovered?.runId).toBe("run-queue-2");
    expect(recovered?.attempts).toBe(2);
    expect(recovered?.lockOwner).toBe("mgr-b");
  });
});
