import type {
  ExecutorClient,
  ExecutorWorkspaceFileDownloadResult,
  ExecutorWorkspaceFileReadResult,
  ExecutorWorkspaceFileTreeResult,
  ExecutorWorkspaceTerminalResult,
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

interface ExecutorRequestInput {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly payload?: unknown;
  readonly trace?: ExecutionTraceMeta;
}

interface BinaryResponse {
  readonly contentType: string;
  readonly body: Buffer;
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
    await this.requestJson({
      method: "POST",
      path: "/workspace/restore",
      payload: input,
      trace: input.trace,
    });
  }

  async linkAgentData(input: {
    sessionId: string;
    containerId: string;
    trace?: ExecutionTraceMeta;
  }): Promise<void> {
    await this.requestJson({
      method: "POST",
      path: "/workspace/link-agent-data",
      payload: input,
      trace: input.trace,
    });
  }

  async validateWorkspace(input: {
    sessionId: string;
    containerId: string;
    requiredPaths: readonly string[];
    trace?: ExecutionTraceMeta;
  }): Promise<ExecutorWorkspaceValidationResult> {
    const body = await this.requestJson<{
      ok?: boolean;
      missingRequiredPaths?: string[];
    }>({
      method: "POST",
      path: "/workspace/validate",
      payload: input,
      trace: input.trace,
    });

    return {
      ok: body?.ok !== false,
      missingRequiredPaths: body?.missingRequiredPaths ?? [],
    };
  }

  async syncWorkspace(request: WorkspaceSyncRequest): Promise<void> {
    await this.requestJson({
      method: "POST",
      path: "/workspace/sync",
      payload: request,
      trace: request.trace,
    });
  }

  async listWorkspaceTree(input: {
    sessionId: string;
    containerId: string;
    path: string;
    trace?: ExecutionTraceMeta;
  }): Promise<ExecutorWorkspaceFileTreeResult> {
    return await this.requestJson<ExecutorWorkspaceFileTreeResult>({
      method: "GET",
      path: withQuery("/workspace/tree", {
        containerId: input.containerId,
        path: input.path,
      }),
      trace: input.trace,
    });
  }

  async readWorkspaceFile(input: {
    sessionId: string;
    containerId: string;
    path: string;
    offset?: number;
    limit?: number;
    trace?: ExecutionTraceMeta;
  }): Promise<ExecutorWorkspaceFileReadResult> {
    return await this.requestJson<ExecutorWorkspaceFileReadResult>({
      method: "GET",
      path: withQuery("/workspace/file", {
        containerId: input.containerId,
        path: input.path,
        ...(typeof input.offset === "number" ? { offset: String(input.offset) } : {}),
        ...(typeof input.limit === "number" ? { limit: String(input.limit) } : {}),
      }),
      trace: input.trace,
    });
  }

  async writeWorkspaceFile(input: {
    sessionId: string;
    containerId: string;
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
    trace?: ExecutionTraceMeta;
  }): Promise<{ path: string; size: number }> {
    const body = await this.requestJson<{ path: string; size: number }>({
      method: "PUT",
      path: "/workspace/file",
      payload: {
        containerId: input.containerId,
        path: input.path,
        content: input.content,
        encoding: input.encoding,
      },
      trace: input.trace,
    });
    return {
      path: body.path,
      size: body.size,
    };
  }

  async uploadWorkspaceFile(input: {
    sessionId: string;
    containerId: string;
    path: string;
    contentBase64: string;
    trace?: ExecutionTraceMeta;
  }): Promise<{ path: string; size: number }> {
    const body = await this.requestJson<{ path: string; size: number }>({
      method: "POST",
      path: "/workspace/upload",
      payload: {
        containerId: input.containerId,
        path: input.path,
        contentBase64: input.contentBase64,
      },
      trace: input.trace,
    });
    return {
      path: body.path,
      size: body.size,
    };
  }

  async renameWorkspacePath(input: {
    sessionId: string;
    containerId: string;
    path: string;
    newPath: string;
    trace?: ExecutionTraceMeta;
  }): Promise<{ path: string; newPath: string }> {
    const body = await this.requestJson<{ path: string; newPath: string }>({
      method: "POST",
      path: "/workspace/rename",
      payload: {
        containerId: input.containerId,
        path: input.path,
        newPath: input.newPath,
      },
      trace: input.trace,
    });
    return {
      path: body.path,
      newPath: body.newPath,
    };
  }

  async deleteWorkspacePath(input: {
    sessionId: string;
    containerId: string;
    path: string;
    trace?: ExecutionTraceMeta;
  }): Promise<{ path: string; deleted: true }> {
    const body = await this.requestJson<{ path: string; deleted: true }>({
      method: "DELETE",
      path: withQuery("/workspace/file", {
        containerId: input.containerId,
        path: input.path,
      }),
      trace: input.trace,
    });
    return {
      path: body.path,
      deleted: true,
    };
  }

  async mkdirWorkspacePath(input: {
    sessionId: string;
    containerId: string;
    path: string;
    trace?: ExecutionTraceMeta;
  }): Promise<{ path: string }> {
    const body = await this.requestJson<{ path: string }>({
      method: "POST",
      path: "/workspace/mkdir",
      payload: {
        containerId: input.containerId,
        path: input.path,
      },
      trace: input.trace,
    });
    return {
      path: body.path,
    };
  }

  async downloadWorkspaceFile(input: {
    sessionId: string;
    containerId: string;
    path: string;
    trace?: ExecutionTraceMeta;
  }): Promise<ExecutorWorkspaceFileDownloadResult> {
    const response = await this.requestBinary({
      method: "GET",
      path: withQuery("/workspace/download", {
        containerId: input.containerId,
        path: input.path,
      }),
      trace: input.trace,
    });

    return {
      path: input.path,
      fileName: basenameFromPath(input.path),
      contentType: response.contentType,
      content: response.body,
    };
  }

  async executeWorkspaceCommand(input: {
    sessionId: string;
    containerId: string;
    command: string;
    cwd?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    trace?: ExecutionTraceMeta;
  }): Promise<ExecutorWorkspaceTerminalResult> {
    return await this.requestJson<ExecutorWorkspaceTerminalResult>({
      method: "POST",
      path: "/tty/exec",
      payload: {
        containerId: input.containerId,
        command: input.command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
      },
      trace: input.trace,
    });
  }

  private async requestJson<T = unknown>(input: ExecutorRequestInput): Promise<T> {
    const response = await this.request(input);
    const text = await response.text();
    const json = safeParseJson(text);
    if (!response.ok) {
      throw new ExecutorRequestError({
        kind: "http",
        path: input.path,
        attempt: this.maxRetries + 1,
        maxAttempts: this.maxRetries + 1,
        status: response.status,
        responseBody: stringifyBody(json ?? text),
        retryable: this.retryStatusCodes.has(response.status),
      });
    }
    return (json as T) ?? ({} as T);
  }

  private async requestBinary(input: ExecutorRequestInput): Promise<BinaryResponse> {
    const response = await this.request(input);
    if (!response.ok) {
      const text = await response.text();
      const json = safeParseJson(text);
      throw new ExecutorRequestError({
        kind: "http",
        path: input.path,
        attempt: this.maxRetries + 1,
        maxAttempts: this.maxRetries + 1,
        status: response.status,
        responseBody: stringifyBody(json ?? text),
        retryable: this.retryStatusCodes.has(response.status),
      });
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const body = Buffer.from(await response.arrayBuffer());
    return {
      contentType,
      body,
    };
  }

  private async request(input: ExecutorRequestInput): Promise<Response> {
    const maxAttempts = this.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.requestOnce(input, attempt, maxAttempts);
      } catch (error) {
        const requestError =
          error instanceof ExecutorRequestError
            ? error
            : toExecutorRequestError({
                error,
                path: input.path,
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
      path: input.path,
      attempt: maxAttempts,
      maxAttempts,
      retryable: false,
      responseBody: "unreachable_retry_exhausted",
    });
  }

  private async requestOnce(
    input: ExecutorRequestInput,
    attempt: number,
    maxAttempts: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const hasBody =
        input.method === "POST" ||
        input.method === "PUT";

      const response = await fetch(`${this.baseUrl}${input.path}`, {
        method: input.method,
        headers: {
          ...(hasBody ? { "content-type": "application/json" } : {}),
          ...(input.trace ? traceToHeaders(input.trace) : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(input.payload ?? {}) } : {}),
        signal: controller.signal,
      });

      if (!response.ok && this.retryStatusCodes.has(response.status)) {
        const text = await response.text();
        const json = safeParseJson(text);
        throw new ExecutorRequestError({
          kind: "http",
          path: input.path,
          attempt,
          maxAttempts,
          status: response.status,
          responseBody: stringifyBody(json ?? text),
          retryable: true,
        });
      }

      return response;
    } catch (error) {
      if (error instanceof ExecutorRequestError) {
        throw error;
      }
      throw toExecutorRequestError({
        error,
        path: input.path,
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
  return error instanceof DOMException && error.name === "AbortError";
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

function withQuery(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  const serialized = query.toString();
  if (!serialized) {
    return path;
  }
  return `${path}?${serialized}`;
}

function basenameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((item) => item.length > 0);
  return segments.at(-1) ?? "file";
}
