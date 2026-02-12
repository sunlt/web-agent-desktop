import { describe, expect, test } from "vitest";
import { createControlPlaneApp } from "../../src/app.js";
import { createSessionWorker } from "../../src/domain/session-worker.js";
import { InMemoryRunCallbackRepository } from "../../src/repositories/in-memory-run-callback-repository.js";
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

      const metrics = await fetch(`${baseUrl}/api/reconcile/metrics?alertLimit=10`);
      expect(metrics.status).toBe(200);
      const metricsBody = (await metrics.json()) as {
        staleRuns: {
          runs: number;
          total: number;
          retried: number;
          failed: number;
        };
        staleSync: {
          runs: number;
          total: number;
          succeeded: number;
          skipped: number;
          failed: number;
        };
        alerts: Array<{ type: string }>;
      };
      expect(metricsBody.staleRuns).toMatchObject({
        runs: 1,
        total: 1,
        retried: 1,
        failed: 0,
      });
      expect(metricsBody.staleSync).toMatchObject({
        runs: 1,
        total: 1,
        succeeded: 1,
        skipped: 0,
        failed: 0,
      });
      expect(metricsBody.alerts).toEqual([]);

      const prometheusMetrics = await fetch(
        `${baseUrl}/api/reconcile/metrics/prometheus?alertLimit=10`,
      );
      expect(prometheusMetrics.status).toBe(200);
      expect(prometheusMetrics.headers.get("content-type")).toContain("text/plain");
      const prometheusBody = await prometheusMetrics.text();
      expect(prometheusBody).toContain(
        "control_plane_reconcile_stale_runs_runs_total 1",
      );
      expect(prometheusBody).toContain(
        "control_plane_reconcile_stale_sync_succeeded_total 1",
      );
    });

    const run = await runQueueRepository.findByRunId(runId);
    expect(run?.status).toBe("queued");
    expect(run?.errorMessage).toBe("reconciler_stale_claim_timeout");

    const worker = await sessionWorkerRepository.findBySessionId(sessionId);
    expect(worker?.lastSyncStatus).toBe("success");
    expect(worker?.lastSyncAt).not.toBeNull();
  });

  test("should expire timed-out human-loop requests and fail related runs", async () => {
    const callbackRepository = new InMemoryRunCallbackRepository();
    const app = createControlPlaneApp({
      callbackRepository,
    });

    const staleRunId = "run-reconcile-human-loop-stale";
    const freshRunId = "run-reconcile-human-loop-fresh";
    const now = Date.now();
    const staleRequestedAt = new Date(now - 2 * 60_000);
    const freshRequestedAt = new Date(now - 2_000);

    await callbackRepository.bindRun(staleRunId, "sess-reconcile-human-loop-stale");
    await callbackRepository.bindRun(freshRunId, "sess-reconcile-human-loop-fresh");

    await callbackRepository.updateRunStatus({
      runId: staleRunId,
      status: "waiting_human",
    });
    await callbackRepository.updateRunStatus({
      runId: freshRunId,
      status: "waiting_human",
    });

    await callbackRepository.upsertPendingRequest({
      questionId: "q-reconcile-human-loop-stale",
      runId: staleRunId,
      sessionId: "sess-reconcile-human-loop-stale",
      prompt: "stale request",
      metadata: {},
      requestedAt: staleRequestedAt,
    });
    await callbackRepository.upsertPendingRequest({
      questionId: "q-reconcile-human-loop-fresh",
      runId: freshRunId,
      sessionId: "sess-reconcile-human-loop-fresh",
      prompt: "fresh request",
      metadata: {},
      requestedAt: freshRequestedAt,
    });

    await withHttpServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/reconcile/human-loop-timeout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          timeoutMs: 60_000,
          limit: 10,
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        pending: 2,
        expired: 1,
        failedRuns: 1,
      });

      const metrics = await fetch(`${baseUrl}/api/reconcile/metrics?alertLimit=10`);
      expect(metrics.status).toBe(200);
      const metricsBody = (await metrics.json()) as {
        humanLoopTimeout: {
          runs: number;
          pending: number;
          expired: number;
          failedRuns: number;
        };
        alerts: Array<{ type: string; level: string }>;
      };
      expect(metricsBody.humanLoopTimeout).toMatchObject({
        runs: 1,
        pending: 2,
        expired: 1,
        failedRuns: 1,
      });
      expect(
        metricsBody.alerts.some(
          (item) => item.type === "human_loop_timeout" && item.level === "warn",
        ),
      ).toBe(true);
    });

    const stale = callbackRepository.getHumanLoopRequest("q-reconcile-human-loop-stale");
    expect(stale?.status).toBe("expired");
    expect(stale?.resolvedAt).not.toBeNull();

    const fresh = callbackRepository.getHumanLoopRequest("q-reconcile-human-loop-fresh");
    expect(fresh?.status).toBe("pending");
    expect(fresh?.resolvedAt).toBeNull();

    expect(callbackRepository.getRunStatus(staleRunId)).toBe("failed");
    expect(callbackRepository.getRunStatus(freshRunId)).toBe("waiting_human");
  });
});
