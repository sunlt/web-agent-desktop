import type { RestorePlan } from "../domain/runtime-manifest.js";
import type { ExecutionTraceMeta } from "./workspace-sync-client.js";

export interface ExecutorWorkspaceValidationResult {
  readonly ok: boolean;
  readonly missingRequiredPaths: readonly string[];
}

export interface ExecutorClient {
  restoreWorkspace(input: {
    sessionId: string;
    containerId: string;
    plan: RestorePlan;
    trace?: ExecutionTraceMeta;
  }): Promise<void>;

  linkAgentData(input: {
    sessionId: string;
    containerId: string;
    trace?: ExecutionTraceMeta;
  }): Promise<void>;

  validateWorkspace(input: {
    sessionId: string;
    containerId: string;
    requiredPaths: readonly string[];
    trace?: ExecutionTraceMeta;
  }): Promise<ExecutorWorkspaceValidationResult>;
}
