import type {
  ClaimRunQueueInput,
  RunQueueItem,
  RunQueueRepository,
} from "./run-queue-repository.js";

export class InMemoryRunQueueRepository implements RunQueueRepository {
  private readonly items = new Map<string, RunQueueItem>();

  async enqueue(input: {
    runId: string;
    sessionId: string;
    provider: RunQueueItem["provider"];
    maxAttempts: number;
    payload: RunQueueItem["payload"];
    now: Date;
  }): Promise<{ accepted: boolean; runId: string }> {
    if (this.items.has(input.runId)) {
      return { accepted: false, runId: input.runId };
    }

    this.items.set(input.runId, {
      runId: input.runId,
      sessionId: input.sessionId,
      provider: input.provider,
      status: "queued",
      lockOwner: null,
      lockExpiresAt: null,
      attempts: 0,
      maxAttempts: Math.max(1, input.maxAttempts),
      payload: input.payload,
      errorMessage: null,
      createdAt: input.now,
      updatedAt: input.now,
    });

    return { accepted: true, runId: input.runId };
  }

  async claimNext(input: ClaimRunQueueInput): Promise<RunQueueItem | null> {
    const claimable = [...this.items.values()]
      .filter((item) => isClaimable(item, input.now))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const next = claimable[0];
    if (!next) {
      return null;
    }

    const claimed: RunQueueItem = {
      ...next,
      status: "claimed",
      lockOwner: input.owner,
      lockExpiresAt: new Date(input.now.getTime() + input.lockMs),
      attempts: next.attempts + 1,
      errorMessage: null,
      updatedAt: input.now,
    };
    this.items.set(next.runId, claimed);
    return claimed;
  }

  async markSucceeded(input: { runId: string; now: Date }): Promise<void> {
    const item = this.items.get(input.runId);
    if (!item) {
      return;
    }

    this.items.set(input.runId, {
      ...item,
      status: "succeeded",
      lockOwner: null,
      lockExpiresAt: null,
      errorMessage: null,
      updatedAt: input.now,
    });
  }

  async markCanceled(input: {
    runId: string;
    now: Date;
    reason?: string;
  }): Promise<void> {
    const item = this.items.get(input.runId);
    if (!item) {
      return;
    }

    this.items.set(input.runId, {
      ...item,
      status: "canceled",
      lockOwner: null,
      lockExpiresAt: null,
      errorMessage: input.reason ?? null,
      updatedAt: input.now,
    });
  }

  async markRetryOrFailed(input: {
    runId: string;
    now: Date;
    retryDelayMs: number;
    errorMessage: string;
  }): Promise<{
    status: "queued" | "failed";
    attempts: number;
    maxAttempts: number;
  }> {
    const item = this.items.get(input.runId);
    if (!item) {
      return {
        status: "failed",
        attempts: 0,
        maxAttempts: 0,
      };
    }

    const exhausted = item.attempts >= item.maxAttempts;
    const updated: RunQueueItem = {
      ...item,
      status: exhausted ? "failed" : "queued",
      lockOwner: null,
      lockExpiresAt: exhausted
        ? null
        : new Date(input.now.getTime() + input.retryDelayMs),
      errorMessage: input.errorMessage,
      updatedAt: input.now,
    };
    this.items.set(input.runId, updated);

    return {
      status: exhausted ? "failed" : "queued",
      attempts: updated.attempts,
      maxAttempts: updated.maxAttempts,
    };
  }

  async findByRunId(runId: string): Promise<RunQueueItem | null> {
    return this.items.get(runId) ?? null;
  }
}

function isClaimable(item: RunQueueItem, now: Date): boolean {
  if (item.status === "queued") {
    return !item.lockExpiresAt || item.lockExpiresAt.getTime() <= now.getTime();
  }

  if (item.status === "claimed") {
    return !!item.lockExpiresAt && item.lockExpiresAt.getTime() <= now.getTime();
  }

  return false;
}
