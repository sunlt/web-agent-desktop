import type {
  AgentProviderAdapter,
  ProviderReplyInput,
  ProviderRunHandle,
  ProviderRunInput,
  ProviderKind,
  ProviderStreamChunk,
} from "./types.js";

interface ExecutorManagerProviderAdapterOptions {
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly timeoutMs?: number;
}

interface ParsedSseEvent {
  readonly event: string;
  readonly data: unknown;
}

interface StartRunResponse {
  readonly runId: string;
  readonly accepted: boolean;
  readonly warnings?: readonly string[];
  readonly reason?: string;
}

interface StreamEventPayload {
  readonly type: "provider.chunk";
  readonly runId: string;
  readonly provider: ProviderKind;
  readonly chunk: ProviderStreamChunk;
  readonly ts: string;
}

const CAPABILITY_BY_PROVIDER: Record<
  ProviderKind,
  AgentProviderAdapter["capabilities"]
> = {
  "opencode": {
    resume: true,
    humanLoop: false,
    todoStream: true,
    buildPlanMode: true,
  },
  "claude-code": {
    resume: true,
    humanLoop: false,
    todoStream: true,
    buildPlanMode: false,
  },
  "codex-cli": {
    resume: true,
    humanLoop: true,
    todoStream: true,
    buildPlanMode: false,
  },
};

export class ExecutorManagerProviderAdapter implements AgentProviderAdapter {
  readonly kind: ProviderKind;
  readonly capabilities: AgentProviderAdapter["capabilities"];

  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: ExecutorManagerProviderAdapterOptions) {
    this.kind = options.kind;
    this.capabilities = CAPABILITY_BY_PROVIDER[options.kind];
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 180_000);
  }

  async run(input: ProviderRunInput): Promise<ProviderRunHandle> {
    const startResponse = await this.requestJson<StartRunResponse>({
      method: "POST",
      path: "/api/provider-runs/start",
      body: {
        runId: input.runId,
        provider: input.provider,
        model: input.model,
        messages: input.messages,
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        ...(input.executionProfile ? { executionProfile: input.executionProfile } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      },
    });

    if (!startResponse.accepted) {
      throw new Error(startResponse.reason ?? "executor-manager rejected run");
    }

    const streamAbortController = new AbortController();
    const baseUrl = this.baseUrl;
    const timeoutMs = this.timeoutMs;
    const runId = startResponse.runId;

    return {
      stream: async function* (): AsyncIterable<ProviderStreamChunk> {
        const response = await fetch(
          `${baseUrl}/api/provider-runs/${encodeURIComponent(runId)}/stream?cursor=0`,
          {
            method: "GET",
            headers: {
              accept: "text/event-stream",
            },
            signal: streamAbortController.signal,
          },
        );

        if (!response.ok) {
          throw new Error(await resolveResponseError(response));
        }
        if (!response.body) {
          throw new Error("executor-manager stream body is empty");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finished = false;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSseBuffer(buffer);
            buffer = parsed.rest;

            for (const event of parsed.events) {
              if (event.event === "provider.closed") {
                finished = true;
                break;
              }

              if (event.event !== "provider.chunk") {
                continue;
              }

              if (!event.data || typeof event.data !== "object") {
                continue;
              }

              const payload = event.data as StreamEventPayload;
              if (!payload.chunk || typeof payload.chunk !== "object") {
                continue;
              }

              yield payload.chunk;

              if (payload.chunk.type === "run.finished") {
                finished = true;
              }
            }

            if (finished) {
              break;
            }
          }
        } catch (error) {
          if (streamAbortController.signal.aborted) {
            if (!finished) {
              yield {
                type: "run.finished",
                status: "canceled",
              };
            }
            return;
          }

          throw error;
        } finally {
          reader.releaseLock();
        }
      },
      stop: async () => {
        streamAbortController.abort();
        await requestStop({
          baseUrl,
          runId: input.runId,
          timeoutMs,
        });
      },
    };
  }

  async reply(input: ProviderReplyInput): Promise<void> {
    const response = await this.requestJson<{ ok?: boolean; reason?: string }>({
      method: "POST",
      path: `/api/provider-runs/${encodeURIComponent(input.runId)}/human-loop/reply`,
      body: {
        questionId: input.questionId,
        answer: input.answer,
      },
    });

    if (response.ok === false) {
      throw new Error(response.reason ?? "human-loop reply rejected");
    }
  }

  private async requestJson<T>(input: {
    method: "POST";
    path: string;
    body: unknown;
  }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${input.path}`, {
        method: input.method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(input.body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(await resolveResponseError(response));
      }

      const text = await response.text();
      if (text.trim().length === 0) {
        return {} as T;
      }

      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`executor-manager request timeout: ${input.path}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function requestStop(input: {
  baseUrl: string;
  runId: string;
  timeoutMs: number;
}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await fetch(
      `${input.baseUrl}/api/provider-runs/${encodeURIComponent(input.runId)}/stop`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({}),
        signal: controller.signal,
      },
    );

    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      throw new Error(await resolveResponseError(response));
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("executor-manager stop request timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseSseBuffer(raw: string): { events: ParsedSseEvent[]; rest: string } {
  const chunks = raw.replace(/\r\n/g, "\n").split("\n\n");
  const rest = chunks.pop() ?? "";
  const events: ParsedSseEvent[] = [];

  for (const chunk of chunks) {
    const block = chunk.trim();
    if (!block || block.startsWith(":")) {
      continue;
    }

    let eventName = "message";
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
      if (line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    const dataText = dataLines.join("\n");
    let data: unknown = dataText;

    if (dataText.length > 0) {
      try {
        data = JSON.parse(dataText);
      } catch {
        data = dataText;
      }
    }

    events.push({ event: eventName, data });
  }

  return {
    events,
    rest,
  };
}

async function resolveResponseError(response: Response): Promise<string> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return `request failed: status=${response.status}`;
  }

  try {
    const parsed = JSON.parse(text) as { error?: unknown; reason?: unknown; message?: unknown };
    const message =
      (typeof parsed.error === "string" ? parsed.error : undefined) ??
      (typeof parsed.reason === "string" ? parsed.reason : undefined) ??
      (typeof parsed.message === "string" ? parsed.message : undefined);
    return message ?? text;
  } catch {
    return text;
  }
}

export function createExecutorManagerProviderAdapters(input: {
  baseUrl: string;
  timeoutMs?: number;
}): AgentProviderAdapter[] {
  return [
    new ExecutorManagerProviderAdapter({
      kind: "opencode",
      baseUrl: input.baseUrl,
      ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
    }),
    new ExecutorManagerProviderAdapter({
      kind: "claude-code",
      baseUrl: input.baseUrl,
      ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
    }),
    new ExecutorManagerProviderAdapter({
      kind: "codex-cli",
      baseUrl: input.baseUrl,
      ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
    }),
  ];
}
