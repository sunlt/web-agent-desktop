import {
  createSessionWorker,
  touchSessionWorker,
  type SessionWorker,
} from "../domain/session-worker.js";
import { randomUUID } from "node:crypto";
import type { RuntimeManifest } from "../domain/runtime-manifest.js";
import type { DockerClient } from "../ports/docker-client.js";
import type {
  ExecutorClient,
  ExecutorWorkspaceFileDownloadResult,
  ExecutorWorkspaceFileReadResult,
  ExecutorWorkspaceFileTreeResult,
  ExecutorWorkspaceTerminalResult,
} from "../ports/executor-client.js";
import type {
  ExecutionTraceMeta,
  SyncReason,
  WorkspaceSyncClient,
} from "../ports/workspace-sync-client.js";
import type { SessionWorkerRepository } from "../repositories/session-worker-repository.js";
import { buildRestorePlan } from "./restore-plan.js";
import { SYNC_EXCLUDE, SYNC_INCLUDE } from "./sync-policy.js";
import { workspaceS3Prefix } from "./workspace-path.js";

export interface LifecycleContext {
  readonly appId: string;
  readonly projectName?: string;
  readonly userLoginName: string;
  readonly sessionId: string;
}

export interface ActivateSessionInput extends LifecycleContext {
  readonly runtimeVersion?: string;
  readonly manifest?: RuntimeManifest;
}

export interface ActivateSessionResult {
  readonly action: "created_and_started" | "started" | "already_running";
  readonly worker: SessionWorker;
}

export interface BatchInput {
  readonly now: Date;
  readonly limit: number;
}

export interface StopIdleWorkersInput extends BatchInput {
  readonly idleTimeoutMs: number;
}

export interface RemoveLongStoppedWorkersInput extends BatchInput {
  readonly removeAfterMs: number;
}

export interface BatchResult {
  readonly total: number;
  readonly succeeded: number;
  readonly skipped: number;
  readonly failed: number;
}

export class SessionWorkerNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`session worker not found: ${sessionId}`);
    this.name = "SessionWorkerNotFoundError";
  }
}

export class LifecycleManager {
  constructor(
    private readonly repo: SessionWorkerRepository,
    private readonly docker: DockerClient,
    private readonly syncClient: WorkspaceSyncClient,
    private readonly executorClient: ExecutorClient = NOOP_EXECUTOR_CLIENT,
  ) {}

  async activateSession(
    context: ActivateSessionInput,
    now: Date = new Date(),
  ): Promise<ActivateSessionResult> {
    const prefix = workspaceS3Prefix(context);
    const existing = await this.repo.findBySessionId(context.sessionId);

    if (!existing || (await this.needsRecreate(existing))) {
      const containerId = await this.docker.createWorker({
        sessionId: context.sessionId,
      });
      await this.docker.start(containerId);

      const worker = createSessionWorker({
        sessionId: context.sessionId,
        containerId,
        workspaceS3Prefix: prefix,
        now,
      });

      await this.repo.save(worker);
      await this.prepareWorkspaceIfNeeded(context, worker);
      return { action: "created_and_started", worker };
    }

    if (existing.state === "stopped") {
      await this.docker.start(existing.containerId);
      const worker = touchSessionWorker(
        existing,
        {
          state: "running",
          stoppedAt: null,
          workspaceS3Prefix: prefix,
          lastActiveAt: now,
        },
        now,
      );
      await this.repo.save(worker);
      await this.prepareWorkspaceIfNeeded(context, worker);
      return { action: "started", worker };
    }

    const worker = touchSessionWorker(
      existing,
      {
        workspaceS3Prefix: prefix,
        lastActiveAt: now,
      },
      now,
    );
    await this.repo.save(worker);
    return { action: "already_running", worker };
  }

  async getSessionWorker(sessionId: string): Promise<SessionWorker | null> {
    return this.repo.findBySessionId(sessionId);
  }

  async listWorkspaceTree(
    sessionId: string,
    path: string,
  ): Promise<ExecutorWorkspaceFileTreeResult> {
    const worker = await this.requireWorker(sessionId);
    await this.touchWorker(worker);
    return await this.executorClient.listWorkspaceTree({
      sessionId: worker.sessionId,
      containerId: worker.containerId,
      path,
      trace: this.newTrace({
        sessionId: worker.sessionId,
        executorId: worker.containerId,
        operation: "workspace.tree",
      }),
    });
  }

  async readWorkspaceFile(
    sessionId: string,
    input: {
      path: string;
      offset?: number;
      limit?: number;
    },
  ): Promise<ExecutorWorkspaceFileReadResult> {
    const worker = await this.requireWorker(sessionId);
    await this.touchWorker(worker);
    return await this.executorClient.readWorkspaceFile({
      sessionId: worker.sessionId,
      containerId: worker.containerId,
      path: input.path,
      offset: input.offset,
      limit: input.limit,
      trace: this.newTrace({
        sessionId: worker.sessionId,
        executorId: worker.containerId,
        operation: "workspace.file.read",
      }),
    });
  }

  async writeWorkspaceFile(
    sessionId: string,
    input: {
      path: string;
      content: string;
      encoding?: "utf8" | "base64";
    },
  ): Promise<{ path: string; size: number }> {
    const worker = await this.requireWorker(sessionId);
    await this.touchWorker(worker);
    return await this.executorClient.writeWorkspaceFile({
      sessionId: worker.sessionId,
      containerId: worker.containerId,
      path: input.path,
      content: input.content,
      encoding: input.encoding,
      trace: this.newTrace({
        sessionId: worker.sessionId,
        executorId: worker.containerId,
        operation: "workspace.file.write",
      }),
    });
  }

  async uploadWorkspaceFile(
    sessionId: string,
    input: {
      path: string;
      contentBase64: string;
    },
  ): Promise<{ path: string; size: number }> {
    const worker = await this.requireWorker(sessionId);
    await this.touchWorker(worker);
    return await this.executorClient.uploadWorkspaceFile({
      sessionId: worker.sessionId,
      containerId: worker.containerId,
      path: input.path,
      contentBase64: input.contentBase64,
      trace: this.newTrace({
        sessionId: worker.sessionId,
        executorId: worker.containerId,
        operation: "workspace.file.upload",
      }),
    });
  }

  async renameWorkspacePath(
    sessionId: string,
    input: {
      path: string;
      newPath: string;
    },
  ): Promise<{ path: string; newPath: string }> {
    const worker = await this.requireWorker(sessionId);
    await this.touchWorker(worker);
    return await this.executorClient.renameWorkspacePath({
      sessionId: worker.sessionId,
      containerId: worker.containerId,
      path: input.path,
      newPath: input.newPath,
      trace: this.newTrace({
        sessionId: worker.sessionId,
        executorId: worker.containerId,
        operation: "workspace.file.rename",
      }),
    });
  }

  async deleteWorkspacePath(
    sessionId: string,
    path: string,
  ): Promise<{ path: string; deleted: true }> {
    const worker = await this.requireWorker(sessionId);
    await this.touchWorker(worker);
    return await this.executorClient.deleteWorkspacePath({
      sessionId: worker.sessionId,
      containerId: worker.containerId,
      path,
      trace: this.newTrace({
        sessionId: worker.sessionId,
        executorId: worker.containerId,
        operation: "workspace.file.delete",
      }),
    });
  }

  async mkdirWorkspacePath(
    sessionId: string,
    path: string,
  ): Promise<{ path: string }> {
    const worker = await this.requireWorker(sessionId);
    await this.touchWorker(worker);
    return await this.executorClient.mkdirWorkspacePath({
      sessionId: worker.sessionId,
      containerId: worker.containerId,
      path,
      trace: this.newTrace({
        sessionId: worker.sessionId,
        executorId: worker.containerId,
        operation: "workspace.file.mkdir",
      }),
    });
  }

  async downloadWorkspaceFile(
    sessionId: string,
    path: string,
  ): Promise<ExecutorWorkspaceFileDownloadResult> {
    const worker = await this.requireWorker(sessionId);
    await this.touchWorker(worker);
    return await this.executorClient.downloadWorkspaceFile({
      sessionId: worker.sessionId,
      containerId: worker.containerId,
      path,
      trace: this.newTrace({
        sessionId: worker.sessionId,
        executorId: worker.containerId,
        operation: "workspace.file.download",
      }),
    });
  }

  async executeWorkspaceCommand(
    sessionId: string,
    input: {
      command: string;
      cwd?: string;
      timeoutMs?: number;
      maxOutputBytes?: number;
    },
  ): Promise<ExecutorWorkspaceTerminalResult> {
    const worker = await this.requireWorker(sessionId);
    await this.touchWorker(worker);
    return await this.executorClient.executeWorkspaceCommand({
      sessionId: worker.sessionId,
      containerId: worker.containerId,
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      trace: this.newTrace({
        sessionId: worker.sessionId,
        executorId: worker.containerId,
        operation: "tty.exec",
      }),
    });
  }

  async syncSessionWorkspace(
    sessionId: string,
    reason: SyncReason,
    now: Date = new Date(),
    runId?: string,
  ): Promise<boolean> {
    const worker = await this.repo.findBySessionId(sessionId);
    if (!worker || worker.state === "deleted") {
      return false;
    }

    await this.syncWorkspace(worker, reason, now, runId);
    return true;
  }

  async stopIdleWorkers(input: StopIdleWorkersInput): Promise<BatchResult> {
    const cutoff = new Date(input.now.getTime() - input.idleTimeoutMs);
    const workers = await this.repo.listIdleRunning(cutoff, input.limit);

    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    for (const worker of workers) {
      try {
        if (!(await this.docker.exists(worker.containerId))) {
          const deleted = touchSessionWorker(
            worker,
            {
              state: "deleted",
              stoppedAt: input.now,
            },
            input.now,
          );
          await this.repo.save(deleted);
          skipped += 1;
          continue;
        }

        const syncedWorker = await this.syncWorkspace(
          worker,
          "pre.stop",
          input.now,
        );
        await this.docker.stop(worker.containerId);

        const stopped = touchSessionWorker(
          syncedWorker,
          {
            state: "stopped",
            stoppedAt: input.now,
          },
          input.now,
        );
        await this.repo.save(stopped);
        succeeded += 1;
      } catch {
        failed += 1;
      }
    }

    return {
      total: workers.length,
      succeeded,
      skipped,
      failed,
    };
  }

  async removeLongStoppedWorkers(
    input: RemoveLongStoppedWorkersInput,
  ): Promise<BatchResult> {
    const cutoff = new Date(input.now.getTime() - input.removeAfterMs);
    const workers = await this.repo.listLongStopped(cutoff, input.limit);

    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    for (const worker of workers) {
      try {
        if (!(await this.docker.exists(worker.containerId))) {
          const deleted = touchSessionWorker(
            worker,
            {
              state: "deleted",
            },
            input.now,
          );
          await this.repo.save(deleted);
          skipped += 1;
          continue;
        }

        const syncedWorker = await this.syncWorkspace(
          worker,
          "pre.remove",
          input.now,
        );
        await this.docker.remove(worker.containerId, { force: true });

        const deleted = touchSessionWorker(
          syncedWorker,
          {
            state: "deleted",
          },
          input.now,
        );
        await this.repo.save(deleted);
        succeeded += 1;
      } catch {
        failed += 1;
      }
    }

    return {
      total: workers.length,
      succeeded,
      skipped,
      failed,
    };
  }

  private async needsRecreate(worker: SessionWorker): Promise<boolean> {
    if (worker.state === "deleted") {
      return true;
    }

    const exists = await this.docker.exists(worker.containerId);
    return !exists;
  }

  private async requireWorker(sessionId: string): Promise<SessionWorker> {
    const worker = await this.repo.findBySessionId(sessionId);
    if (!worker || worker.state === "deleted") {
      throw new SessionWorkerNotFoundError(sessionId);
    }
    return worker;
  }

  private async touchWorker(worker: SessionWorker): Promise<void> {
    const now = new Date();
    const touched = touchSessionWorker(
      worker,
      {
        lastActiveAt: now,
      },
      now,
    );
    await this.repo.save(touched);
  }

  private async syncWorkspace(
    worker: SessionWorker,
    reason: SyncReason,
    now: Date,
    runId?: string,
  ): Promise<SessionWorker> {
    const syncing = touchSessionWorker(
      worker,
      {
        lastSyncStatus: "running",
        lastSyncError: null,
      },
      now,
    );
    await this.repo.save(syncing);

    try {
      await this.syncClient.syncWorkspace({
        sessionId: worker.sessionId,
        containerId: worker.containerId,
        workspaceS3Prefix: worker.workspaceS3Prefix,
        include: SYNC_INCLUDE,
        exclude: SYNC_EXCLUDE,
        reason,
        trace: this.newTrace({
          sessionId: worker.sessionId,
          executorId: worker.containerId,
          operation: `workspace.sync.${reason}`,
          runId,
        }),
      });

      const synced = touchSessionWorker(
        worker,
        {
          lastSyncStatus: "success",
          lastSyncAt: now,
          lastSyncError: null,
        },
        now,
      );
      await this.repo.save(synced);
      return synced;
    } catch (error) {
      const failed = touchSessionWorker(
        worker,
        {
          lastSyncStatus: "failed",
          lastSyncError: error instanceof Error ? error.message : String(error),
        },
        now,
      );
      await this.repo.save(failed);
      throw error;
    }
  }

  private async prepareWorkspaceIfNeeded(
    context: ActivateSessionInput,
    worker: SessionWorker,
  ): Promise<void> {
    if (!context.runtimeVersion || !context.manifest) {
      return;
    }

    const plan = buildRestorePlan({
      appId: context.appId,
      projectName: context.projectName,
      userLoginName: context.userLoginName,
      sessionId: context.sessionId,
      runtimeVersion: context.runtimeVersion,
      manifest: context.manifest,
    });

    const restoreTrace = this.newTrace({
      sessionId: worker.sessionId,
      executorId: worker.containerId,
      operation: "workspace.restore",
    });

    await this.executorClient.restoreWorkspace({
      sessionId: worker.sessionId,
      containerId: worker.containerId,
      plan,
      trace: restoreTrace,
    });

    const linkTrace = this.newTrace({
      sessionId: worker.sessionId,
      executorId: worker.containerId,
      operation: "workspace.link-agent-data",
    });

    await this.executorClient.linkAgentData({
      sessionId: worker.sessionId,
      containerId: worker.containerId,
      trace: linkTrace,
    });

    const validateTrace = this.newTrace({
      sessionId: worker.sessionId,
      executorId: worker.containerId,
      operation: "workspace.validate",
    });

    const validation = await this.executorClient.validateWorkspace({
      sessionId: worker.sessionId,
      containerId: worker.containerId,
      requiredPaths: plan.requiredPaths,
      trace: validateTrace,
    });

    if (!validation.ok) {
      throw new Error(
        `workspace required paths missing: ${validation.missingRequiredPaths.join(",")}`,
      );
    }
  }

  private newTrace(input: {
    sessionId: string;
    executorId: string;
    operation: string;
    runId?: string;
  }): ExecutionTraceMeta {
    return {
      traceId: randomUUID(),
      sessionId: input.sessionId,
      executorId: input.executorId,
      operation: input.operation,
      ts: new Date().toISOString(),
      runId: input.runId,
    };
  }
}

const NOOP_EXECUTOR_CLIENT: ExecutorClient = {
  restoreWorkspace: async () => {},
  linkAgentData: async () => {},
  validateWorkspace: async () => ({
    ok: true,
    missingRequiredPaths: [],
  }),
  listWorkspaceTree: async ({ path }) => ({
    path,
    entries: [],
  }),
  readWorkspaceFile: async ({ path }) => ({
    path,
    fileName: path.split("/").at(-1) ?? "file",
    contentType: "text/plain; charset=utf-8",
    size: 0,
    offset: 0,
    limit: 0,
    readBytes: 0,
    nextOffset: null,
    truncated: false,
    encoding: "utf8",
    content: "",
  }),
  writeWorkspaceFile: async ({ path, content }) => ({
    path,
    size: Buffer.byteLength(content, "utf8"),
  }),
  uploadWorkspaceFile: async ({ path, contentBase64 }) => ({
    path,
    size: Buffer.from(contentBase64, "base64").byteLength,
  }),
  renameWorkspacePath: async ({ path, newPath }) => ({
    path,
    newPath,
  }),
  deleteWorkspacePath: async ({ path }) => ({
    path,
    deleted: true,
  }),
  mkdirWorkspacePath: async ({ path }) => ({
    path,
  }),
  downloadWorkspaceFile: async ({ path }) => ({
    path,
    fileName: path.split("/").at(-1) ?? "file",
    contentType: "application/octet-stream",
    content: Buffer.alloc(0),
  }),
  executeWorkspaceCommand: async ({ command }) => ({
    command,
    cwd: "/workspace",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    truncated: false,
  }),
};
