import type { Logger } from "../observability/logger.js";
import { createLogger } from "../observability/logger.js";
import type { RunCallbackRepository } from "../repositories/run-callback-repository.js";
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

export interface ReconcileHumanLoopTimeoutInput {
  readonly now?: Date;
  readonly timeoutMs: number;
  readonly limit?: number;
}

export interface ReconcileHumanLoopTimeoutResult {
  readonly pending: number;
  readonly expired: number;
  readonly failedRuns: number;
}

type ReconcileAlertType = "stale_runs" | "stale_sync" | "human_loop_timeout";
type ReconcileAlertLevel = "warn" | "error";

export interface ReconcileAlert {
  readonly id: string;
  readonly type: ReconcileAlertType;
  readonly level: ReconcileAlertLevel;
  readonly message: string;
  readonly ts: string;
  readonly payload: Record<string, unknown>;
}

export interface ReconcileMetricsSnapshot {
  readonly staleRuns: {
    readonly runs: number;
    readonly lastRunAt: string | null;
    readonly total: number;
    readonly retried: number;
    readonly failed: number;
    readonly lastResult: ReconcileStaleRunsResult | null;
  };
  readonly staleSync: {
    readonly runs: number;
    readonly lastRunAt: string | null;
    readonly total: number;
    readonly succeeded: number;
    readonly skipped: number;
    readonly failed: number;
    readonly lastResult: ReconcileStaleSyncResult | null;
  };
  readonly humanLoopTimeout: {
    readonly runs: number;
    readonly lastRunAt: string | null;
    readonly pending: number;
    readonly expired: number;
    readonly failedRuns: number;
    readonly lastResult: ReconcileHumanLoopTimeoutResult | null;
  };
  readonly alerts: readonly ReconcileAlert[];
}

export class Reconciler {
  private readonly logger: Logger;
  private readonly staleRunMetrics = {
    runs: 0,
    lastRunAt: null as Date | null,
    total: 0,
    retried: 0,
    failed: 0,
    lastResult: null as ReconcileStaleRunsResult | null,
  };
  private readonly staleSyncMetrics = {
    runs: 0,
    lastRunAt: null as Date | null,
    total: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    lastResult: null as ReconcileStaleSyncResult | null,
  };
  private readonly humanLoopTimeoutMetrics = {
    runs: 0,
    lastRunAt: null as Date | null,
    pending: 0,
    expired: 0,
    failedRuns: 0,
    lastResult: null as ReconcileHumanLoopTimeoutResult | null,
  };
  private readonly alerts: ReconcileAlert[] = [];
  private alertSequence = 0;

  constructor(
    private readonly runQueueRepository: RunQueueRepository,
    private readonly callbackRepository: RunCallbackRepository,
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

    const summary = {
      total: staleItems.length,
      retried,
      failed,
    };

    this.recordStaleRunsMetrics(now, summary);
    if (summary.failed > 0) {
      this.appendAlert({
        type: "stale_runs",
        level: "error",
        message: "reconcile stale runs failed",
        payload: {
          total: summary.total,
          retried: summary.retried,
          failed: summary.failed,
        },
      });
    }

    return summary;
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

    const summary = {
      total: workers.length,
      succeeded,
      skipped,
      failed,
    };

    this.recordStaleSyncMetrics(now, summary);
    if (summary.failed > 0 || summary.skipped > 0) {
      this.appendAlert({
        type: "stale_sync",
        level: summary.failed > 0 ? "error" : "warn",
        message:
          summary.failed > 0
            ? "reconcile stale sync failed"
            : "reconcile stale sync skipped",
        payload: {
          total: summary.total,
          succeeded: summary.succeeded,
          skipped: summary.skipped,
          failed: summary.failed,
        },
      });
    }

    return summary;
  }

  async reconcileHumanLoopTimeout(
    input: ReconcileHumanLoopTimeoutInput,
  ): Promise<ReconcileHumanLoopTimeoutResult> {
    const now = input.now ?? new Date();
    const timeoutMs = Math.max(1, input.timeoutMs);
    const limit = Math.max(1, input.limit ?? 200);
    const cutoff = new Date(now.getTime() - timeoutMs);

    const pendingRequests = await this.callbackRepository.listRequests({
      status: "pending",
      limit,
    });
    const timedOutRequests = pendingRequests.filter(
      (request) => request.requestedAt.getTime() <= cutoff.getTime(),
    );

    const failedRunIds = new Set<string>();

    for (const request of timedOutRequests) {
      await this.callbackRepository.markRequestStatus({
        questionId: request.questionId,
        runId: request.runId,
        status: "expired",
        resolvedAt: now,
      });
      failedRunIds.add(request.runId);

      this.logger.warn("human-loop request expired", {
        runId: request.runId,
        questionId: request.questionId,
        requestedAt: request.requestedAt.toISOString(),
        timeoutMs,
      });
    }

    for (const runId of failedRunIds) {
      await this.callbackRepository.updateRunStatus({
        runId,
        status: "failed",
        updatedAt: now,
      });
    }

    const summary = {
      pending: pendingRequests.length,
      expired: timedOutRequests.length,
      failedRuns: failedRunIds.size,
    };

    this.recordHumanLoopTimeoutMetrics(now, summary);
    if (summary.expired > 0) {
      this.appendAlert({
        type: "human_loop_timeout",
        level: "warn",
        message: "reconcile human-loop timeout expired pending requests",
        payload: {
          pending: summary.pending,
          expired: summary.expired,
          failedRuns: summary.failedRuns,
        },
      });
    }

    return summary;
  }

  getMetrics(input: { alertLimit?: number } = {}): ReconcileMetricsSnapshot {
    const alertLimit = Math.max(1, input.alertLimit ?? 50);
    const alerts = this.alerts.slice(-alertLimit).reverse();

    return {
      staleRuns: {
        runs: this.staleRunMetrics.runs,
        lastRunAt: this.staleRunMetrics.lastRunAt?.toISOString() ?? null,
        total: this.staleRunMetrics.total,
        retried: this.staleRunMetrics.retried,
        failed: this.staleRunMetrics.failed,
        lastResult: this.staleRunMetrics.lastResult,
      },
      staleSync: {
        runs: this.staleSyncMetrics.runs,
        lastRunAt: this.staleSyncMetrics.lastRunAt?.toISOString() ?? null,
        total: this.staleSyncMetrics.total,
        succeeded: this.staleSyncMetrics.succeeded,
        skipped: this.staleSyncMetrics.skipped,
        failed: this.staleSyncMetrics.failed,
        lastResult: this.staleSyncMetrics.lastResult,
      },
      humanLoopTimeout: {
        runs: this.humanLoopTimeoutMetrics.runs,
        lastRunAt: this.humanLoopTimeoutMetrics.lastRunAt?.toISOString() ?? null,
        pending: this.humanLoopTimeoutMetrics.pending,
        expired: this.humanLoopTimeoutMetrics.expired,
        failedRuns: this.humanLoopTimeoutMetrics.failedRuns,
        lastResult: this.humanLoopTimeoutMetrics.lastResult,
      },
      alerts,
    };
  }

  private recordStaleRunsMetrics(
    now: Date,
    summary: ReconcileStaleRunsResult,
  ): void {
    this.staleRunMetrics.runs += 1;
    this.staleRunMetrics.lastRunAt = now;
    this.staleRunMetrics.total += summary.total;
    this.staleRunMetrics.retried += summary.retried;
    this.staleRunMetrics.failed += summary.failed;
    this.staleRunMetrics.lastResult = summary;
  }

  private recordStaleSyncMetrics(
    now: Date,
    summary: ReconcileStaleSyncResult,
  ): void {
    this.staleSyncMetrics.runs += 1;
    this.staleSyncMetrics.lastRunAt = now;
    this.staleSyncMetrics.total += summary.total;
    this.staleSyncMetrics.succeeded += summary.succeeded;
    this.staleSyncMetrics.skipped += summary.skipped;
    this.staleSyncMetrics.failed += summary.failed;
    this.staleSyncMetrics.lastResult = summary;
  }

  private recordHumanLoopTimeoutMetrics(
    now: Date,
    summary: ReconcileHumanLoopTimeoutResult,
  ): void {
    this.humanLoopTimeoutMetrics.runs += 1;
    this.humanLoopTimeoutMetrics.lastRunAt = now;
    this.humanLoopTimeoutMetrics.pending += summary.pending;
    this.humanLoopTimeoutMetrics.expired += summary.expired;
    this.humanLoopTimeoutMetrics.failedRuns += summary.failedRuns;
    this.humanLoopTimeoutMetrics.lastResult = summary;
  }

  private appendAlert(input: {
    type: ReconcileAlertType;
    level: ReconcileAlertLevel;
    message: string;
    payload: Record<string, unknown>;
  }): void {
    this.alertSequence += 1;
    const alert: ReconcileAlert = {
      id: `reconcile-alert-${this.alertSequence}`,
      type: input.type,
      level: input.level,
      message: input.message,
      ts: new Date().toISOString(),
      payload: input.payload,
    };
    this.alerts.push(alert);
    if (this.alerts.length > 200) {
      this.alerts.splice(0, this.alerts.length - 200);
    }

    const loggerMethod = input.level === "error" ? "error" : "warn";
    this.logger[loggerMethod]("reconcile alert emitted", {
      alertType: input.type,
      alertLevel: input.level,
      message: input.message,
      ...input.payload,
    });
  }
}
