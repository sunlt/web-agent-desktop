import type {
  ExecutorClient,
  ExecutorWorkspaceValidationResult,
} from "../ports/executor-client.js";

export class NoopExecutorClient implements ExecutorClient {
  async restoreWorkspace(_: {
    sessionId: string;
    containerId: string;
    plan: unknown;
  }): Promise<void> {
    return;
  }

  async linkAgentData(_: {
    sessionId: string;
    containerId: string;
  }): Promise<void> {
    return;
  }

  async validateWorkspace(_: {
    sessionId: string;
    containerId: string;
    requiredPaths: readonly string[];
  }): Promise<ExecutorWorkspaceValidationResult> {
    return {
      ok: true,
      missingRequiredPaths: [],
    };
  }
}
