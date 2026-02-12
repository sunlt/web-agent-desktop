import { describe, expect, test } from "vitest";
import { createControlPlaneApp } from "../../src/app.js";
import { createSessionWorker } from "../../src/domain/session-worker.js";
import { InMemoryRunQueueRepository } from "../../src/repositories/in-memory-run-queue-repository.js";
import { InMemorySessionWorkerRepository } from "../../src/repositories/in-memory-session-worker-repository.js";
import { withHttpServer } from "./http-test-utils.js";

describe("Reconcile API E2E", () => {
  test("should reconcile stale claimed run and stale sync worker", async () => {
    const runQueueRepository = new InMemoryRunQueueRepository();
    const sessionWorkerRepository = new InMemorySessionWorkerRepository();

    const app = createControlPlaneApp({
      runQueueRepository,
      sessionWorkerRepository,
    });

    const runId = "run-reconcile-1";
    const sessionId = "sess-reconcile-1";
    const now = new Date("2026-02-11T10:00:00.000Z");

    await runQueueRepository.enqueue({
      runId,
      sessionId,
      provider: "opencode",
      maxAttempts: 3,
      payload: {
        sessionId,
        provider: "opencode",
        model: "openai/gpt-5.1-codex",
        messages: [{ role: "user", content: "hello" }],
      },
      now,
    });

    const claimed = await runQueueRepository.claimNext({
      owner: "stale-owner",
      now,
      lockMs: 1,
    });
    expect(claimed?.status).toBe("claimed");

    await sessionWorkerRepository.save(
      createSessionWorker({
        sessionId,
        containerId: "ctr-reconcile-1",
        workspaceS3Prefix:
          "app/app-1/project/default/alice/session/sess-reconcile-1/workspace",
        now,
      }),
    );

    await withHttpServer(app, async (baseUrl) => {
      const runs = await fetch(`${baseUrl}/api/reconcile/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          limit: 10,
          retryDelayMs: 0,
        }),
      });
      expect(runs.status).toBe(200);
      expect(await runs.json()).toEqual({
        total: 1,
        retried: 1,
        failed: 0,
      });

      const sync = await fetch(`${baseUrl}/api/reconcile/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          staleAfterMs: 1,
          limit: 10,
        }),
      });
      expect(sync.status).toBe(200);
      expect(await sync.json()).toEqual({
        total: 1,
        succeeded: 1,
        skipped: 0,
        failed: 0,
      });
    });

    const run = await runQueueRepository.findByRunId(runId);
    expect(run?.status).toBe("queued");
    expect(run?.errorMessage).toBe("reconciler_stale_claim_timeout");

    const worker = await sessionWorkerRepository.findBySessionId(sessionId);
    expect(worker?.lastSyncStatus).toBe("success");
    expect(worker?.lastSyncAt).not.toBeNull();
  });
});
