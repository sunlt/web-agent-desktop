import type { ChatMessage, ProviderKind } from "../providers/types.js";

export interface RunQueuePayload {
  readonly sessionId: string;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly resumeSessionId?: string;
  readonly executionProfile?: string;
  readonly tools?: Record<string, unknown>;
  readonly providerOptions?: Record<string, unknown>;
  readonly requireHumanLoop?: boolean;
}

export type RunQueueStatus =
  | "queued"
  | "claimed"
  | "succeeded"
  | "failed"
  | "canceled";

export interface RunQueueItem {
  readonly runId: string;
  readonly sessionId: string;
  readonly provider: ProviderKind;
  readonly status: RunQueueStatus;
  readonly lockOwner: string | null;
  readonly lockExpiresAt: Date | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly payload: RunQueuePayload;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ClaimRunQueueInput {
  readonly owner: string;
  readonly now: Date;
  readonly lockMs: number;
}

export interface RunQueueRepository {
  enqueue(input: {
    runId: string;
    sessionId: string;
    provider: ProviderKind;
    maxAttempts: number;
    payload: RunQueuePayload;
    now: Date;
  }): Promise<{ accepted: boolean; runId: string }>;

  claimNext(input: ClaimRunQueueInput): Promise<RunQueueItem | null>;

  markSucceeded(input: {
    runId: string;
    now: Date;
  }): Promise<void>;

  markCanceled(input: {
    runId: string;
    now: Date;
    reason?: string;
  }): Promise<void>;

  markRetryOrFailed(input: {
    runId: string;
    now: Date;
    retryDelayMs: number;
    errorMessage: string;
  }): Promise<{
    status: "queued" | "failed";
    attempts: number;
    maxAttempts: number;
  }>;

  findByRunId(runId: string): Promise<RunQueueItem | null>;
}
