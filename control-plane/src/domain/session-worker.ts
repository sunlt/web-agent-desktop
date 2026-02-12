export type SessionWorkerState = "running" | "stopped" | "deleted";

export type SyncStatus = "idle" | "running" | "success" | "failed";

export interface SessionWorker {
  readonly sessionId: string;
  readonly containerId: string;
  readonly workspaceS3Prefix: string;
  readonly state: SessionWorkerState;
  readonly lastActiveAt: Date;
  readonly stoppedAt: Date | null;
  readonly lastSyncAt: Date | null;
  readonly lastSyncStatus: SyncStatus;
  readonly lastSyncError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewSessionWorkerInput {
  readonly sessionId: string;
  readonly containerId: string;
  readonly workspaceS3Prefix: string;
  readonly now: Date;
}

export function createSessionWorker(input: NewSessionWorkerInput): SessionWorker {
  return {
    sessionId: input.sessionId,
    containerId: input.containerId,
    workspaceS3Prefix: input.workspaceS3Prefix,
    state: "running",
    lastActiveAt: input.now,
    stoppedAt: null,
    lastSyncAt: null,
    lastSyncStatus: "idle",
    lastSyncError: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function touchSessionWorker(
  worker: SessionWorker,
  changes: Partial<Omit<SessionWorker, "sessionId" | "createdAt">>,
  now: Date,
): SessionWorker {
  return {
    ...worker,
    ...changes,
    updatedAt: now,
  };
}
