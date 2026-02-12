import { describe, expect, test } from "vitest";
import { createControlPlaneApp } from "../../src/app.js";
import type { DockerClient } from "../../src/ports/docker-client.js";
import type {
  WorkspaceSyncClient,
  WorkspaceSyncRequest,
} from "../../src/ports/workspace-sync-client.js";
import { InMemorySessionWorkerRepository } from "../../src/repositories/in-memory-session-worker-repository.js";
import { withHttpServer } from "./http-test-utils.js";

class FakeDockerClient implements DockerClient {
  private readonly containers = new Set<string>();
  private counter = 0;
  readonly calls: string[] = [];

  async createWorker(): Promise<string> {
    const containerId = `ctr-${this.counter++}`;
    this.containers.add(containerId);
    this.calls.push(`create:${containerId}`);
    return containerId;
  }

  async start(containerId: string): Promise<void> {
    if (!this.containers.has(containerId)) {
      throw new Error(`container missing: ${containerId}`);
    }
    this.calls.push(`start:${containerId}`);
  }

  async stop(containerId: string): Promise<void> {
    if (!this.containers.has(containerId)) {
      throw new Error(`container missing: ${containerId}`);
    }
    this.calls.push(`stop:${containerId}`);
  }

  async remove(containerId: string): Promise<void> {
    this.containers.delete(containerId);
    this.calls.push(`remove:${containerId}`);
  }

  async exists(containerId: string): Promise<boolean> {
    return this.containers.has(containerId);
  }
}

class FakeSyncClient implements WorkspaceSyncClient {
  readonly requests: WorkspaceSyncRequest[] = [];

  async syncWorkspace(request: WorkspaceSyncRequest): Promise<void> {
    this.requests.push(request);
  }
}

describe("Run Lifecycle E2E", () => {
  test("should cover activate -> idle stop -> restart -> remove stopped flow", async () => {
    const sessionWorkerRepository = new InMemorySessionWorkerRepository();
    const dockerClient = new FakeDockerClient();
    const workspaceSyncClient = new FakeSyncClient();
    const app = createControlPlaneApp({
      sessionWorkerRepository,
      dockerClient,
      workspaceSyncClient,
      providerAdapters: [],
    });

    await withHttpServer(app, async (baseUrl) => {
      const activateA = await fetch(
        `${baseUrl}/api/session-workers/sess-e2e-lifecycle/activate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            appId: "app-1",
            projectName: "default",
            userLoginName: "alice",
          }),
        },
      );
      expect(activateA.status).toBe(200);
      const activateABody = (await activateA.json()) as {
        action: string;
        worker: { containerId: string; state: string };
      };
      expect(activateABody.action).toBe("created_and_started");
      expect(activateABody.worker.state).toBe("running");

      await sleep(10);

      const stopIdleA = await fetch(`${baseUrl}/api/session-workers/cleanup/idle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idleTimeoutMs: 1,
          limit: 20,
        }),
      });
      expect(stopIdleA.status).toBe(200);
      expect(await stopIdleA.json()).toMatchObject({
        total: 1,
        succeeded: 1,
      });

      const stoppedWorker = await fetch(
        `${baseUrl}/api/session-workers/sess-e2e-lifecycle`,
      );
      expect(stoppedWorker.status).toBe(200);
      const stoppedWorkerBody = (await stoppedWorker.json()) as {
        state: string;
        lastSyncStatus: string;
      };
      expect(stoppedWorkerBody.state).toBe("stopped");
      expect(stoppedWorkerBody.lastSyncStatus).toBe("success");

      const activateB = await fetch(
        `${baseUrl}/api/session-workers/sess-e2e-lifecycle/activate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            appId: "app-1",
            projectName: "default",
            userLoginName: "alice",
          }),
        },
      );
      expect(activateB.status).toBe(200);
      const activateBBody = (await activateB.json()) as { action: string };
      expect(activateBBody.action).toBe("started");

      await sleep(10);

      const stopIdleB = await fetch(`${baseUrl}/api/session-workers/cleanup/idle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idleTimeoutMs: 1,
          limit: 20,
        }),
      });
      expect(stopIdleB.status).toBe(200);
      expect(await stopIdleB.json()).toMatchObject({
        total: 1,
        succeeded: 1,
      });

      await sleep(10);

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

      const deletedWorker = await fetch(
        `${baseUrl}/api/session-workers/sess-e2e-lifecycle`,
      );
      expect(deletedWorker.status).toBe(200);
      const deletedWorkerBody = (await deletedWorker.json()) as {
        state: string;
      };
      expect(deletedWorkerBody.state).toBe("deleted");
    });

    expect(dockerClient.calls).toEqual([
      "create:ctr-0",
      "start:ctr-0",
      "stop:ctr-0",
      "start:ctr-0",
      "stop:ctr-0",
      "remove:ctr-0",
    ]);

    expect(workspaceSyncClient.requests.map((item) => item.reason)).toEqual([
      "pre.stop",
      "pre.stop",
      "pre.remove",
    ]);
  });
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
