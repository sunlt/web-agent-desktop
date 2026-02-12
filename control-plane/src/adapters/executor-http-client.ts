import type {
  ExecutorClient,
  ExecutorWorkspaceValidationResult,
} from "../ports/executor-client.js";
import type {
  WorkspaceSyncClient,
  WorkspaceSyncRequest,
  ExecutionTraceMeta,
} from "../ports/workspace-sync-client.js";

export interface ExecutorHttpClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly token?: string;
}

export class ExecutorHttpClient
  implements ExecutorClient, WorkspaceSyncClient
{
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly token?: string;

  constructor(options: ExecutorHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.token = options.token;
  }

  async restoreWorkspace(input: {
    sessionId: string;
    containerId: string;
    plan: {
      conflictPolicy: string;
      protectedPaths: readonly string[];
      requiredPaths: readonly string[];
      entries: readonly unknown[];
    };
    trace?: ExecutionTraceMeta;
  }): Promise<void> {
    await this.post("/workspace/restore", input, input.trace);
  }

  async linkAgentData(input: {
    sessionId: string;
    containerId: string;
    trace?: ExecutionTraceMeta;
  }): Promise<void> {
    await this.post("/workspace/link-agent-data", input, input.trace);
  }

  async validateWorkspace(input: {
    sessionId: string;
    containerId: string;
    requiredPaths: readonly string[];
    trace?: ExecutionTraceMeta;
  }): Promise<ExecutorWorkspaceValidationResult> {
    const body = await this.post<{
      ok?: boolean;
      missingRequiredPaths?: string[];
    }>("/workspace/validate", input, input.trace);

    return {
      ok: body?.ok !== false,
      missingRequiredPaths: body?.missingRequiredPaths ?? [],
    };
  }

  async syncWorkspace(request: WorkspaceSyncRequest): Promise<void> {
    await this.post("/workspace/sync", request, request.trace);
  }

  private async post<T = unknown>(
    path: string,
    payload: unknown,
    trace?: ExecutionTraceMeta,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(trace ? traceToHeaders(trace) : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const text = await response.text();
      const json = safeParseJson(text);
      if (!response.ok) {
        throw new Error(
          `executor request failed: ${path} ${response.status} ${stringifyBody(json ?? text)}`,
        );
      }

      return (json as T) ?? ({} as T);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function traceToHeaders(
  trace: ExecutionTraceMeta,
): Record<string, string> {
  return {
    "x-trace-id": trace.traceId,
    "x-trace-session-id": trace.sessionId,
    "x-trace-executor-id": trace.executorId,
    "x-trace-operation": trace.operation,
    "x-trace-ts": trace.ts,
    ...(trace.runId ? { "x-trace-run-id": trace.runId } : {}),
  };
}

function safeParseJson(input: string): unknown {
  if (input.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function stringifyBody(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
