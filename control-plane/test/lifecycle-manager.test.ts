import { describe, expect, test } from "vitest";
import type { RuntimeManifest } from "../src/domain/runtime-manifest.js";
import { createSessionWorker, type SessionWorker } from "../src/domain/session-worker.js";
import type { DockerClient } from "../src/ports/docker-client.js";
import type { ExecutorClient } from "../src/ports/executor-client.js";
import type {
  WorkspaceSyncClient,
  WorkspaceSyncRequest,
} from "../src/ports/workspace-sync-client.js";
import { InMemorySessionWorkerRepository } from "../src/repositories/in-memory-session-worker-repository.js";
import { LifecycleManager } from "../src/services/lifecycle-manager.js";

class FakeDockerClient implements DockerClient {
  private readonly containers = new Map<string, { exists: boolean; state: "running" | "stopped" }>();
  public readonly calls: string[] = [];
  private counter = 0;

  seed(containerId: string, state: "running" | "stopped"): void {
    this.containers.set(containerId, { exists: true, state });
  }

  async createWorker(): Promise<string> {
    const id = `ctr-${this.counter++}`;
    this.containers.set(id, { exists: true, state: "stopped" });
    this.calls.push(`create:${id}`);
    return id;
  }

  async start(containerId: string): Promise<void> {
    const item = this.require(containerId);
    item.state = "running";
    this.calls.push(`start:${containerId}`);
  }

  async stop(containerId: string): Promise<void> {
    const item = this.require(containerId);
    item.state = "stopped";
    this.calls.push(`stop:${containerId}`);
  }

  async remove(containerId: string): Promise<void> {
    this.require(containerId);
    this.containers.delete(containerId);
    this.calls.push(`remove:${containerId}`);
  }

  async exists(containerId: string): Promise<boolean> {
    return this.containers.has(containerId);
  }

  private require(containerId: string): { exists: boolean; state: "running" | "stopped" } {
    const item = this.containers.get(containerId);
    if (!item) {
      throw new Error("container missing");
    }
    return item;
  }
}

class FakeSyncClient implements WorkspaceSyncClient {
  public readonly requests: WorkspaceSyncRequest[] = [];
  public failForSessionId: string | null = null;

  async syncWorkspace(request: WorkspaceSyncRequest): Promise<void> {
    this.requests.push(request);
    if (this.failForSessionId === request.sessionId) {
      throw new Error("sync failed");
    }
  }
}

class FakeExecutorClient implements ExecutorClient {
  readonly calls: string[] = [];

  async restoreWorkspace(_: {
    sessionId: string;
    containerId: string;
    plan: unknown;
  }): Promise<void> {
    this.calls.push("restore");
  }

  async linkAgentData(_: {
    sessionId: string;
    containerId: string;
  }): Promise<void> {
    this.calls.push("link");
  }

  async validateWorkspace(_: {
    sessionId: string;
    containerId: string;
    requiredPaths: readonly string[];
  }): Promise<{ ok: boolean; missingRequiredPaths: readonly string[] }> {
    this.calls.push("validate");
    return { ok: true, missingRequiredPaths: [] };
  }
}

function seedStoppedWorker(params: {
  sessionId: string;
  containerId: string;
  now: Date;
  hoursAgo: number;
}): SessionWorker {
  const base = createSessionWorker({
    sessionId: params.sessionId,
    containerId: params.containerId,
    workspaceS3Prefix: `app/app-1/project/default/alice/session/${params.sessionId}/workspace`,
    now: new Date(params.now.getTime() - params.hoursAgo * 60 * 60 * 1000),
  });

  return {
    ...base,
    state: "stopped",
    stoppedAt: new Date(params.now.getTime() - params.hoursAgo * 60 * 60 * 1000),
  };
}

describe("LifecycleManager", () => {
  test("should create and start worker when session does not exist", async () => {
    const repo = new InMemorySessionWorkerRepository();
    const docker = new FakeDockerClient();
    const sync = new FakeSyncClient();
    const manager = new LifecycleManager(repo, docker, sync);

    const result = await manager.activateSession({
      appId: "app-1",
      projectName: "default",
      userLoginName: "alice",
      sessionId: "sess-1",
    });

    expect(result.action).toBe("created_and_started");
    expect(docker.calls).toEqual(["create:ctr-0", "start:ctr-0"]);

    const stored = await repo.findBySessionId("sess-1");
    expect(stored?.state).toBe("running");
  });

  test("should stop idle worker only after successful sync", async () => {
    const now = new Date("2026-02-11T10:00:00.000Z");
    const repo = new InMemorySessionWorkerRepository();
    const docker = new FakeDockerClient();
    const sync = new FakeSyncClient();
    const manager = new LifecycleManager(repo, docker, sync);

    docker.seed("ctr-1", "running");
    const worker = createSessionWorker({
      sessionId: "sess-2",
      containerId: "ctr-1",
      workspaceS3Prefix: "app/app-1/project/default/alice/session/sess-2/workspace",
      now: new Date(now.getTime() - 40 * 60 * 1000),
    });
    await repo.save(worker);

    const result = await manager.stopIdleWorkers({
      now,
      idleTimeoutMs: 30 * 60 * 1000,
      limit: 10,
    });

    expect(result).toEqual({ total: 1, succeeded: 1, skipped: 0, failed: 0 });
    expect(sync.requests).toHaveLength(1);
    expect(docker.calls).toContain("stop:ctr-1");
    const stored = await repo.findBySessionId("sess-2");
    expect(stored?.state).toBe("stopped");
    expect(stored?.lastSyncStatus).toBe("success");
  });

  test("should block stop when sync fails", async () => {
    const now = new Date("2026-02-11T10:00:00.000Z");
    const repo = new InMemorySessionWorkerRepository();
    const docker = new FakeDockerClient();
    const sync = new FakeSyncClient();
    sync.failForSessionId = "sess-3";
    const manager = new LifecycleManager(repo, docker, sync);

    docker.seed("ctr-2", "running");
    const worker = createSessionWorker({
      sessionId: "sess-3",
      containerId: "ctr-2",
      workspaceS3Prefix: "app/app-1/project/default/alice/session/sess-3/workspace",
      now: new Date(now.getTime() - 40 * 60 * 1000),
    });
    await repo.save(worker);

    const result = await manager.stopIdleWorkers({
      now,
      idleTimeoutMs: 30 * 60 * 1000,
      limit: 10,
    });

    expect(result).toEqual({ total: 1, succeeded: 0, skipped: 0, failed: 1 });
    expect(docker.calls).not.toContain("stop:ctr-2");
    const stored = await repo.findBySessionId("sess-3");
    expect(stored?.state).toBe("running");
    expect(stored?.lastSyncStatus).toBe("failed");
  });

  test("should mark deleted when stopped worker container is missing", async () => {
    const now = new Date("2026-02-11T10:00:00.000Z");
    const repo = new InMemorySessionWorkerRepository();
    const docker = new FakeDockerClient();
    const sync = new FakeSyncClient();
    const manager = new LifecycleManager(repo, docker, sync);

    await repo.save(
      seedStoppedWorker({
        sessionId: "sess-4",
        containerId: "ctr-missing",
        now,
        hoursAgo: 25,
      }),
    );

    const result = await manager.removeLongStoppedWorkers({
      now,
      removeAfterMs: 24 * 60 * 60 * 1000,
      limit: 10,
    });

    expect(result).toEqual({ total: 1, succeeded: 0, skipped: 1, failed: 0 });
    expect(sync.requests).toHaveLength(0);
    const stored = await repo.findBySessionId("sess-4");
    expect(stored?.state).toBe("deleted");
  });

  test("should remove stopped worker only after successful sync", async () => {
    const now = new Date("2026-02-11T10:00:00.000Z");
    const repo = new InMemorySessionWorkerRepository();
    const docker = new FakeDockerClient();
    const sync = new FakeSyncClient();
    const manager = new LifecycleManager(repo, docker, sync);

    docker.seed("ctr-5", "stopped");
    await repo.save(
      seedStoppedWorker({
        sessionId: "sess-5",
        containerId: "ctr-5",
        now,
        hoursAgo: 30,
      }),
    );

    const result = await manager.removeLongStoppedWorkers({
      now,
      removeAfterMs: 24 * 60 * 60 * 1000,
      limit: 10,
    });

    expect(result).toEqual({ total: 1, succeeded: 1, skipped: 0, failed: 0 });
    expect(docker.calls).toContain("remove:ctr-5");
    const stored = await repo.findBySessionId("sess-5");
    expect(stored?.state).toBe("deleted");
    expect(stored?.lastSyncStatus).toBe("success");
  });

  test("should sync workspace on message.stop callback", async () => {
    const now = new Date("2026-02-11T10:00:00.000Z");
    const repo = new InMemorySessionWorkerRepository();
    const docker = new FakeDockerClient();
    const sync = new FakeSyncClient();
    const manager = new LifecycleManager(repo, docker, sync);

    docker.seed("ctr-6", "running");
    await repo.save(
      createSessionWorker({
        sessionId: "sess-6",
        containerId: "ctr-6",
        workspaceS3Prefix: "app/app-1/project/default/alice/session/sess-6/workspace",
        now,
      }),
    );

    const synced = await manager.syncSessionWorkspace(
      "sess-6",
      "message.stop",
      now,
    );

    expect(synced).toBe(true);
    expect(sync.requests).toHaveLength(1);
    expect(sync.requests[0].reason).toBe("message.stop");

    const stored = await repo.findBySessionId("sess-6");
    expect(stored?.lastSyncStatus).toBe("success");
  });

  test("should prepare workspace via executor when runtime manifest is provided", async () => {
    const now = new Date("2026-02-12T10:00:00.000Z");
    const repo = new InMemorySessionWorkerRepository();
    const docker = new FakeDockerClient();
    const sync = new FakeSyncClient();
    const executor = new FakeExecutorClient();
    const manager = new LifecycleManager(repo, docker, sync, executor);

    const manifest: RuntimeManifest = {
      appId: "app-1",
      runtimeVersion: "2026.02.12",
      workspaceTemplatePrefix: "app/app-1/registry/runtime/2026.02.12/template/",
      requiredPaths: ["/workspace/.agent_data"],
      seedFiles: [],
      mountPoints: [],
      conflictPolicy: "keep_session",
      protectedPaths: ["/workspace/.agent_data"],
      cleanupRules: [],
    };

    await manager.activateSession(
      {
        appId: "app-1",
        projectName: "default",
        userLoginName: "alice",
        sessionId: "sess-prepare",
        runtimeVersion: "2026.02.12",
        manifest,
      },
      now,
    );

    expect(executor.calls).toEqual(["restore", "link", "validate"]);
  });
});
