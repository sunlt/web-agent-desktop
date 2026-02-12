import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Pool } from "pg";
import { createControlPlaneApp } from "../../src/app.js";
import { DockerCliClient } from "../../src/adapters/docker-cli-client.js";
import { ExecutorHttpClient } from "../../src/adapters/executor-http-client.js";
import { createPostgresPool } from "../../src/adapters/postgres-pool.js";
import { PostgresRunCallbackRepository } from "../../src/repositories/postgres-run-callback-repository.js";
import { PostgresSessionWorkerRepository } from "../../src/repositories/postgres-session-worker-repository.js";
import { withHttpServer } from "./http-test-utils.js";
import {
  createS3Client,
  ensureBucket,
  objectExists,
  startExecutorFixture,
  startRustfsContainer,
  type ExecutorFixtureHandle,
  type RustfsContainerHandle,
} from "./real-environment-utils.js";

const runRealE2E = process.env.RUN_REAL_E2E === "1";
const describeReal = runRealE2E ? describe : describe.skip;

describeReal("Real Infra E2E (Postgres + Docker + RustFS + Executor)", () => {
  let rustfs: RustfsContainerHandle | null = null;
  let executorFixture: ExecutorFixtureHandle | null = null;
  let pool: Pool | null = null;
  let bucket = "";

  beforeAll(async () => {
    rustfs = await startRustfsContainer();
    bucket = `cp-e2e-${Date.now()}`;
    executorFixture = await startExecutorFixture({
      rustfsEndpoint: rustfs.endpoint,
      accessKey: rustfs.accessKey,
      secretKey: rustfs.secretKey,
      bucket,
    });
    pool = createPostgresPool();
    await applyMigrations(pool);
  }, 180_000);

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    if (executorFixture) {
      await executorFixture.stop();
    }
    if (rustfs) {
      await rustfs.stop();
    }
  }, 180_000);

  test("should run lifecycle with real adapters and sync workspace to RustFS", async () => {
    if (!pool || !rustfs || !executorFixture) {
      throw new Error("real infra fixtures not initialized");
    }

    const sessionId = `sess-real-${Date.now()}`;
    const runId = `run-real-${Date.now()}`;
    const appId = "app-real";
    const projectName = "default";
    const userLoginName = "alice";
    const workspacePrefix = `app/${appId}/project/${projectName}/${userLoginName}/session/${sessionId}/workspace`;
    const key = `${workspacePrefix}/README.md`;

    const sessionWorkerRepository = new PostgresSessionWorkerRepository(pool);
    const callbackRepository = new PostgresRunCallbackRepository(pool);
    const dockerClient = new DockerCliClient({
      containerImage: "alpine:3.20",
      containerCommand: ["sh", "-c", "sleep infinity"],
    });
    const executorClient = new ExecutorHttpClient({
      baseUrl: executorFixture.baseUrl,
      timeoutMs: 20_000,
    });

    const app = createControlPlaneApp({
      sessionWorkerRepository,
      callbackRepository,
      dockerClient,
      workspaceSyncClient: executorClient,
      executorClient,
      providerAdapters: [],
    });

    await withHttpServer(app, async (baseUrl) => {
      const activate = await fetch(
        `${baseUrl}/api/session-workers/${sessionId}/activate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            appId,
            projectName,
            userLoginName,
            runtimeVersion: "2026.02.12",
            manifest: {
              appId,
              runtimeVersion: "2026.02.12",
              workspaceTemplatePrefix:
                "app/app-real/registry/runtime/2026.02.12/template/",
              requiredPaths: ["/workspace/.agent_data"],
              seedFiles: [
                {
                  from: "app/app-real/registry/runtime/2026.02.12/seeds/README.md",
                  to: "/workspace/README.md",
                  ifMissingOnly: true,
                },
              ],
              mountPoints: [
                {
                  name: "agent_data",
                  targetPath: "/workspace/.agent_data",
                  readOnly: false,
                },
              ],
              conflictPolicy: "keep_session",
              protectedPaths: ["/workspace/.agent_data"],
              cleanupRules: [],
            },
          }),
        },
      );

      expect(activate.status).toBe(200);
      expect(await activate.json()).toMatchObject({
        action: "created_and_started",
      });

      await sleep(30);

      const stopIdle = await fetch(`${baseUrl}/api/session-workers/cleanup/idle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idleTimeoutMs: 1,
          limit: 20,
        }),
      });
      expect(stopIdle.status).toBe(200);
      expect(await stopIdle.json()).toMatchObject({
        total: 1,
        succeeded: 1,
      });

      const bind = await fetch(`${baseUrl}/api/runs/${runId}/bind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
        }),
      });
      expect(bind.status).toBe(200);

      const stopMessage = await fetch(`${baseUrl}/api/runs/${runId}/callbacks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: `evt-stop-${Date.now()}`,
          type: "message.stop",
        }),
      });
      expect(stopMessage.status).toBe(200);
      expect(await stopMessage.json()).toMatchObject({
        action: "message_stop_synced",
      });

      const finish = await fetch(`${baseUrl}/api/runs/${runId}/callbacks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: `evt-${Date.now()}`,
          type: "run.finished",
          status: "succeeded",
          usage: {
            inputTokens: 10,
            outputTokens: 20,
          },
        }),
      });
      expect(finish.status).toBe(200);

      await sleep(30);

      const removeStopped = await fetch(
        `${baseUrl}/api/session-workers/cleanup/stopped`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            removeAfterMs: 1,
            limit: 20,
          }),
        },
      );
      expect(removeStopped.status).toBe(200);
      expect(await removeStopped.json()).toMatchObject({
        total: 1,
        succeeded: 1,
      });
    });

    const s3Client = createS3Client({
      endpoint: rustfs.endpoint,
      accessKey: rustfs.accessKey,
      secretKey: rustfs.secretKey,
    });
    await ensureBucket(s3Client, bucket);
    expect(
      await objectExists({
        client: s3Client,
        bucket,
        key,
      }),
    ).toBe(true);

    const usageResult = await pool.query(
      `SELECT usage FROM usage_logs WHERE run_id = $1`,
      [runId],
    );
    expect(usageResult.rowCount).toBe(1);

    const events = executorFixture.getEvents();
    expect(
      events.some(
        (event) =>
          event.path === "/workspace/restore" &&
          typeof event.traceId === "string" &&
          event.traceId.length > 0 &&
          event.operation === "workspace.restore",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.path === "/workspace/sync" &&
          typeof event.traceId === "string" &&
          event.traceId.length > 0 &&
          event.runId === runId &&
          event.operation?.startsWith("workspace.sync."),
      ),
    ).toBe(true);

    await pool.query(`DELETE FROM usage_logs WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM run_events WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM agent_runs WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM session_workers WHERE session_id = $1`, [
      sessionId,
    ]);
  }, 180_000);

  test("should keep worker running when executor sync fails (failure injection)", async () => {
    if (!pool || !rustfs) {
      throw new Error("real infra fixtures not initialized");
    }

    const failingFixture = await startExecutorFixture({
      rustfsEndpoint: rustfs.endpoint,
      accessKey: rustfs.accessKey,
      secretKey: rustfs.secretKey,
      bucket: `${bucket}-fail`,
      failureRules: {
        "/workspace/sync": {
          times: 1,
          status: 500,
          body: { error: "injected_sync_failure" },
        },
      },
    });

    try {
      const sessionId = `sess-real-fail-${Date.now()}`;
      const sessionWorkerRepository = new PostgresSessionWorkerRepository(pool);
      const callbackRepository = new PostgresRunCallbackRepository(pool);
      const dockerClient = new DockerCliClient({
        containerImage: "alpine:3.20",
        containerCommand: ["sh", "-c", "sleep infinity"],
      });
      const executorClient = new ExecutorHttpClient({
        baseUrl: failingFixture.baseUrl,
        timeoutMs: 20_000,
        maxRetries: 0,
      });

      const app = createControlPlaneApp({
        sessionWorkerRepository,
        callbackRepository,
        dockerClient,
        workspaceSyncClient: executorClient,
        executorClient,
        providerAdapters: [],
      });
      let containerId = "";

      await withHttpServer(app, async (baseUrl) => {
        const activate = await fetch(
          `${baseUrl}/api/session-workers/${sessionId}/activate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              appId: "app-real",
              projectName: "default",
              userLoginName: "alice",
            }),
          },
        );
        expect(activate.status).toBe(200);
        const activateBody = (await activate.json()) as {
          worker: { containerId: string };
        };
        containerId = activateBody.worker.containerId;

        await sleep(30);

        const stopIdle = await fetch(
          `${baseUrl}/api/session-workers/cleanup/idle`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              idleTimeoutMs: 1,
              limit: 20,
            }),
          },
        );
        expect(stopIdle.status).toBe(200);
        expect(await stopIdle.json()).toMatchObject({
          total: 1,
          succeeded: 0,
          failed: 1,
        });

        const worker = await fetch(
          `${baseUrl}/api/session-workers/${sessionId}`,
        );
        expect(worker.status).toBe(200);
        const body = (await worker.json()) as {
          state: string;
          lastSyncStatus: string;
        };
        expect(body.state).toBe("running");
        expect(body.lastSyncStatus).toBe("failed");
      });

      const syncEvents = failingFixture
        .getEvents()
        .filter((item) => item.path === "/workspace/sync");
      expect(syncEvents.length).toBeGreaterThan(0);
      expect(syncEvents[0]?.operation).toMatch(/^workspace\.sync\./);

      if (containerId) {
        await dockerClient.remove(containerId, { force: true }).catch(() => {});
      }

      await pool.query(`DELETE FROM session_workers WHERE session_id = $1`, [
        sessionId,
      ]);
    } finally {
      await failingFixture.stop();
    }
  }, 180_000);

  test("should retry sync and stop worker when executor has transient failure", async () => {
    if (!pool || !rustfs) {
      throw new Error("real infra fixtures not initialized");
    }

    const flakyFixture = await startExecutorFixture({
      rustfsEndpoint: rustfs.endpoint,
      accessKey: rustfs.accessKey,
      secretKey: rustfs.secretKey,
      bucket: `${bucket}-retry`,
      failureRules: {
        "/workspace/sync": {
          times: 1,
          status: 500,
          body: { error: "temporary_sync_failure" },
        },
      },
    });

    try {
      const sessionId = `sess-real-retry-${Date.now()}`;
      const sessionWorkerRepository = new PostgresSessionWorkerRepository(pool);
      const callbackRepository = new PostgresRunCallbackRepository(pool);
      const dockerClient = new DockerCliClient({
        containerImage: "alpine:3.20",
        containerCommand: ["sh", "-c", "sleep infinity"],
      });
      const executorClient = new ExecutorHttpClient({
        baseUrl: flakyFixture.baseUrl,
        timeoutMs: 20_000,
        maxRetries: 1,
        retryDelayMs: 5,
      });

      const app = createControlPlaneApp({
        sessionWorkerRepository,
        callbackRepository,
        dockerClient,
        workspaceSyncClient: executorClient,
        executorClient,
        providerAdapters: [],
      });
      let containerId = "";

      await withHttpServer(app, async (baseUrl) => {
        const activate = await fetch(
          `${baseUrl}/api/session-workers/${sessionId}/activate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              appId: "app-real",
              projectName: "default",
              userLoginName: "alice",
            }),
          },
        );
        expect(activate.status).toBe(200);
        const activateBody = (await activate.json()) as {
          worker: { containerId: string };
        };
        containerId = activateBody.worker.containerId;

        await sleep(30);

        const stopIdle = await fetch(
          `${baseUrl}/api/session-workers/cleanup/idle`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              idleTimeoutMs: 1,
              limit: 20,
            }),
          },
        );
        expect(stopIdle.status).toBe(200);
        expect(await stopIdle.json()).toMatchObject({
          total: 1,
          succeeded: 1,
          failed: 0,
        });

        const worker = await fetch(
          `${baseUrl}/api/session-workers/${sessionId}`,
        );
        expect(worker.status).toBe(200);
        const body = (await worker.json()) as {
          state: string;
          lastSyncStatus: string;
        };
        expect(body.state).toBe("stopped");
        expect(body.lastSyncStatus).toBe("success");
      });

      const syncEvents = flakyFixture
        .getEvents()
        .filter((item) => item.path === "/workspace/sync");
      expect(syncEvents.length).toBeGreaterThanOrEqual(2);
      expect(syncEvents[0]?.operation).toMatch(/^workspace\.sync\./);

      if (containerId) {
        await dockerClient.remove(containerId, { force: true }).catch(() => {});
      }

      await pool.query(`DELETE FROM session_workers WHERE session_id = $1`, [
        sessionId,
      ]);
    } finally {
      await flakyFixture.stop();
    }
  }, 180_000);
});

async function applyMigrations(pool: Pool): Promise<void> {
  const migration = await import("node:fs/promises").then((fs) =>
    fs.readFile(
      new URL("../../sql/001_init.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(migration);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
