export type SyncReason = "message.stop" | "run.finished" | "pre.stop" | "pre.remove";

export interface ExecutionTraceMeta {
  readonly traceId: string;
  readonly sessionId: string;
  readonly executorId: string;
  readonly operation: string;
  readonly ts: string;
  readonly runId?: string;
}

export interface WorkspaceSyncRequest {
  readonly sessionId: string;
  readonly containerId: string;
  readonly workspaceS3Prefix: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly reason: SyncReason;
  readonly trace?: ExecutionTraceMeta;
}

export interface WorkspaceSyncClient {
  syncWorkspace(request: WorkspaceSyncRequest): Promise<void>;
}
