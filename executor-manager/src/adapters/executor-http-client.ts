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
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly retryStatusCodes?: readonly number[];
}

export type ExecutorRequestErrorKind = "http" | "timeout" | "network";

export class ExecutorRequestError extends Error {
  readonly kind: ExecutorRequestErrorKind;
  readonly path: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly status?: number;
  readonly responseBody?: string;
  readonly retryable: boolean;

  constructor(input: {
    kind: ExecutorRequestErrorKind;
    path: string;
    attempt: number;
    maxAttempts: number;
    status?: number;
    responseBody?: string;
    retryable: boolean;
    cause?: unknown;
  }) {
    super(formatExecutorErrorMessage(input), {
      cause: input.cause,
    });
    this.name = "ExecutorRequestError";
    this.kind = input.kind;
    this.path = input.path;
    this.attempt = input.attempt;
    this.maxAttempts = input.maxAttempts;
    this.status = input.status;
    this.responseBody = input.responseBody;
    this.retryable = input.retryable;
  }
}

export class ExecutorHttpClient
  implements ExecutorClient, WorkspaceSyncClient
{
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly token?: string;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly retryStatusCodes: Set<number>;

  constructor(options: ExecutorHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.token = options.token;
    this.maxRetries = Math.max(0, options.maxRetries ?? 0);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 200);
    this.retryStatusCodes = new Set(
      options.retryStatusCodes ?? [500, 502, 503, 504],
    );
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
    const maxAttempts = this.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.postOnce<T>(path, payload, trace, attempt, maxAttempts);
      } catch (error) {
        const requestError =
          error instanceof ExecutorRequestError
            ? error
            : toExecutorRequestError({
                error,
                path,
                attempt,
                maxAttempts,
              });
        if (!requestError.retryable || attempt >= maxAttempts) {
          throw requestError;
        }
        await sleep(this.retryDelayMs * attempt);
      }
    }

    throw new ExecutorRequestError({
      kind: "network",
      path,
      attempt: maxAttempts,
      maxAttempts,
      retryable: false,
      responseBody: "unreachable_retry_exhausted",
    });
  }

  private async postOnce<T = unknown>(
    path: string,
    payload: unknown,
    trace: ExecutionTraceMeta | undefined,
    attempt: number,
    maxAttempts: number,
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
        throw new ExecutorRequestError({
          kind: "http",
          path,
          attempt,
          maxAttempts,
          status: response.status,
          responseBody: stringifyBody(json ?? text),
          retryable: this.retryStatusCodes.has(response.status),
        });
      }

      return (json as T) ?? ({} as T);
    } catch (error) {
      if (error instanceof ExecutorRequestError) {
        throw error;
      }
      throw toExecutorRequestError({
        error,
        path,
        attempt,
        maxAttempts,
      });
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

function toExecutorRequestError(input: {
  error: unknown;
  path: string;
  attempt: number;
  maxAttempts: number;
}): ExecutorRequestError {
  if (isAbortError(input.error)) {
    return new ExecutorRequestError({
      kind: "timeout",
      path: input.path,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      retryable: true,
      cause: input.error,
    });
  }
  return new ExecutorRequestError({
    kind: "network",
    path: input.path,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    retryable: true,
    cause: input.error,
  });
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  );
}

function formatExecutorErrorMessage(input: {
  kind: ExecutorRequestErrorKind;
  path: string;
  attempt: number;
  maxAttempts: number;
  status?: number;
  responseBody?: string;
}): string {
  const status = input.status ? ` status=${input.status}` : "";
  const responseBody = input.responseBody
    ? ` body=${truncate(input.responseBody, 240)}`
    : "";
  return `executor request failed: kind=${input.kind} path=${input.path} attempt=${input.attempt}/${input.maxAttempts}${status}${responseBody}`;
}

function truncate(input: string, max: number): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max - 3)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
