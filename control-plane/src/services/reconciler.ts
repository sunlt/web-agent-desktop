import type { Logger } from "../observability/logger.js";
import { createLogger } from "../observability/logger.js";
import type { RunQueueRepository } from "../repositories/run-queue-repository.js";
import type { SessionWorkerRepository } from "../repositories/session-worker-repository.js";

export interface SessionSyncService {
  syncSessionWorkspace(
    sessionId: string,
    reason: "message.stop" | "run.finished" | "pre.stop" | "pre.remove",
    now: Date,
  ): Promise<boolean>;
}

export interface ReconcilerOptions {
  readonly logger?: Logger;
}

export interface ReconcileStaleRunsInput {
  readonly now?: Date;
  readonly limit?: number;
  readonly retryDelayMs?: number;
}

export interface ReconcileStaleRunsResult {
  readonly total: number;
  readonly retried: number;
  readonly failed: number;
}

export interface ReconcileStaleSyncInput {
  readonly now?: Date;
  readonly staleAfterMs: number;
  readonly limit?: number;
}

export interface ReconcileStaleSyncResult {
  readonly total: number;
  readonly succeeded: number;
  readonly skipped: number;
  readonly failed: number;
}

export class Reconciler {
  private readonly logger: Logger;

  constructor(
    private readonly runQueueRepository: RunQueueRepository,
    private readonly sessionWorkerRepository: SessionWorkerRepository,
    private readonly syncService: SessionSyncService,
    options: ReconcilerOptions = {},
  ) {
    this.logger = (options.logger ?? createLogger()).child({
      component: "reconciler",
    });
  }

  async reconcileStaleRuns(
    input: ReconcileStaleRunsInput = {},
  ): Promise<ReconcileStaleRunsResult> {
    const now = input.now ?? new Date();
    const limit = Math.max(1, input.limit ?? 50);
    const retryDelayMs = Math.max(0, input.retryDelayMs ?? 1_000);

    const staleItems = await this.runQueueRepository.listStaleClaimed({
      now,
      limit,
    });

    let retried = 0;
    let failed = 0;

    for (const item of staleItems) {
      const result = await this.runQueueRepository.markRetryOrFailed({
        runId: item.runId,
        now,
        retryDelayMs,
        errorMessage: "reconciler_stale_claim_timeout",
      });

      const status = result.status === "queued" ? "retried" : "failed";
      if (status === "retried") {
        retried += 1;
      } else {
        failed += 1;
      }

      this.logger.warn("run claim stale reconciled", {
        runId: item.runId,
        sessionId: item.sessionId,
        status,
        attempts: result.attempts,
        maxAttempts: result.maxAttempts,
      });
    }

    return {
      total: staleItems.length,
      retried,
      failed,
    };
  }

  async reconcileStaleSync(
    input: ReconcileStaleSyncInput,
  ): Promise<ReconcileStaleSyncResult> {
    const now = input.now ?? new Date();
    const limit = Math.max(1, input.limit ?? 50);
    const cutoff = new Date(now.getTime() - Math.max(1, input.staleAfterMs));

    const workers = await this.sessionWorkerRepository.listStaleSyncCandidates(
      cutoff,
      limit,
    );

    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    for (const worker of workers) {
      try {
        const synced = await this.syncService.syncSessionWorkspace(
          worker.sessionId,
          "run.finished",
          now,
        );

        if (synced) {
          succeeded += 1;
          this.logger.info("stale sync reconciled", {
            sessionId: worker.sessionId,
            executorId: worker.containerId,
          });
        } else {
          skipped += 1;
          this.logger.warn("stale sync skipped", {
            sessionId: worker.sessionId,
          });
        }
      } catch (error) {
        failed += 1;
        this.logger.error("stale sync failed", {
          sessionId: worker.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      total: workers.length,
      succeeded,
      skipped,
      failed,
    };
  }
}
