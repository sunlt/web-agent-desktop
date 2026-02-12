import { randomUUID } from "node:crypto";
import { createLogger, type Logger } from "../observability/logger.js";
import type { RunQueueRepository } from "../repositories/run-queue-repository.js";
import type {
  RunQueueItem,
  RunQueuePayload,
} from "../repositories/run-queue-repository.js";
import type { RunOrchestrator } from "./run-orchestrator.js";

export interface EnqueueRunInput extends RunQueuePayload {
  readonly runId?: string;
  readonly maxAttempts?: number;
  readonly now?: Date;
}

export interface EnqueueRunResult {
  readonly accepted: boolean;
  readonly runId: string;
}

export interface DrainQueueInput {
  readonly owner?: string;
  readonly limit?: number;
  readonly lockMs?: number;
  readonly retryDelayMs?: number;
}

export interface DrainQueueResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly retried: number;
  readonly failed: number;
  readonly canceled: number;
}

export class RunQueueManager {
  private readonly owner: string;
  private readonly lockMs: number;
  private readonly retryDelayMs: number;
  private readonly logger: Logger;

  constructor(
    private readonly repo: RunQueueRepository,
    private readonly orchestrator: RunOrchestrator,
    options: {
      owner?: string;
      lockMs?: number;
      retryDelayMs?: number;
      logger?: Logger;
    } = {},
  ) {
    this.owner = options.owner ?? `manager-${process.pid}`;
    this.lockMs = options.lockMs ?? 15_000;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.logger = (options.logger ?? createLogger()).child({
      component: "run-queue-manager",
      owner: this.owner,
    });
  }

  async enqueueRun(input: EnqueueRunInput): Promise<EnqueueRunResult> {
    const now = input.now ?? new Date();
    const runId = input.runId ?? randomUUID();
    const payload: RunQueuePayload = {
      sessionId: input.sessionId,
      provider: input.provider,
      model: input.model,
      messages: input.messages,
      resumeSessionId: input.resumeSessionId,
      executionProfile: input.executionProfile,
      tools: input.tools,
      providerOptions: input.providerOptions,
      requireHumanLoop: input.requireHumanLoop,
    };

    const queued = await this.repo.enqueue({
      runId,
      sessionId: input.sessionId,
      provider: input.provider,
      maxAttempts: input.maxAttempts ?? 5,
      payload,
      now,
    });

    return {
      accepted: queued.accepted,
      runId,
    };
  }

  async drainOnce(input: DrainQueueInput = {}): Promise<DrainQueueResult> {
    const limit = Math.max(1, input.limit ?? 10);
    const owner = input.owner ?? this.owner;
    const lockMs = input.lockMs ?? this.lockMs;
    const retryDelayMs = input.retryDelayMs ?? this.retryDelayMs;

    let claimed = 0;
    let succeeded = 0;
    let retried = 0;
    let failed = 0;
    let canceled = 0;

    for (let index = 0; index < limit; index += 1) {
      const now = new Date();
      const item = await this.repo.claimNext({
        owner,
        now,
        lockMs,
      });
      if (!item) {
        break;
      }

      claimed += 1;
      const result = await this.processClaimedItem(item, retryDelayMs);
      this.logger.info("run queue item processed", {
        runId: item.runId,
        sessionId: item.sessionId,
        result,
      });
      if (result === "succeeded") {
        succeeded += 1;
      } else if (result === "retried") {
        retried += 1;
      } else if (result === "failed") {
        failed += 1;
      } else {
        canceled += 1;
      }
    }

    return {
      claimed,
      succeeded,
      retried,
      failed,
      canceled,
    };
  }

  async getQueueItem(runId: string): Promise<RunQueueItem | null> {
    return this.repo.findByRunId(runId);
  }

  private async processClaimedItem(
    item: RunQueueItem,
    retryDelayMs: number,
  ): Promise<"succeeded" | "retried" | "failed" | "canceled"> {
    try {
      const started = await this.orchestrator.startRun({
        runId: item.runId,
        provider: item.payload.provider,
        model: item.payload.model,
        messages: item.payload.messages,
        resumeSessionId: item.payload.resumeSessionId,
        executionProfile: item.payload.executionProfile,
        tools: item.payload.tools,
        providerOptions: item.payload.providerOptions,
        requireHumanLoop: item.payload.requireHumanLoop,
      });

      if (!started.accepted) {
        await this.repo.markCanceled({
          runId: item.runId,
          now: new Date(),
          reason: started.reason ?? "run_rejected",
        });
        return "canceled";
      }

      for await (const _event of this.orchestrator.streamRun(item.runId)) {
        // stream 已由 orchestrator 聚合处理，这里仅等待完成
      }

      const snapshot = this.orchestrator.getRunSnapshot(item.runId);
      if (!snapshot) {
        throw new Error(`missing run snapshot: ${item.runId}`);
      }

      if (snapshot.status === "succeeded") {
        await this.repo.markSucceeded({
          runId: item.runId,
          now: new Date(),
        });
        return "succeeded";
      }

      if (snapshot.status === "canceled" || snapshot.status === "blocked") {
        await this.repo.markCanceled({
          runId: item.runId,
          now: new Date(),
          reason: snapshot.reason,
        });
        return "canceled";
      }

      const failed = await this.repo.markRetryOrFailed({
        runId: item.runId,
        now: new Date(),
        retryDelayMs,
        errorMessage: snapshot.reason ?? `run_${snapshot.status}`,
      });

      return failed.status === "queued" ? "retried" : "failed";
    } catch (error) {
      const failed = await this.repo.markRetryOrFailed({
        runId: item.runId,
        now: new Date(),
        retryDelayMs,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return failed.status === "queued" ? "retried" : "failed";
    }
  }
}
