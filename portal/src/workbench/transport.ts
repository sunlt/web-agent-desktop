import type {
  ChatTransport,
  FinishReason,
  UIMessage,
  UIMessageChunk,
} from "ai";
import { extractMessageText, resolveResponseError } from "./utils";

const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 3500, 5000];

export type ProviderKind =
  | "claude-code"
  | "opencode"
  | "codex-cli"
  | "codex-app-server";

export interface RunStartConfig {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly requireHumanLoop: boolean;
  readonly executionProfile?: string;
  readonly providerOptions?: Record<string, unknown>;
}

export interface PortalMessageMetadata {
  readonly createdAt?: string;
  readonly runId?: string;
}

export interface RunStatusEvent {
  readonly type: "run.status";
  readonly runId: string;
  readonly provider: ProviderKind;
  readonly status: "started" | "finished" | "failed" | "blocked";
  readonly ts: string;
  readonly detail?: string;
}

export interface TodoUpdateEvent {
  readonly type: "todo.update";
  readonly runId: string;
  readonly provider: ProviderKind;
  readonly todo: {
    readonly todoId: string;
    readonly content: string;
    readonly status: "todo" | "doing" | "done" | "canceled";
    readonly order: number;
  };
  readonly ts: string;
}

export interface RunWarningEvent {
  readonly type: "run.warning";
  readonly runId: string;
  readonly provider: ProviderKind;
  readonly warning: string;
  readonly ts: string;
}

export interface StreamLifecycleEvent {
  readonly kind: "reconnecting" | "reconnected" | "reconnect-failed";
  readonly runId: string;
  readonly attempt: number;
  readonly cursor: number;
  readonly reason?: string;
}

interface MessageDeltaEvent {
  readonly type: "message.delta";
  readonly runId: string;
  readonly provider: ProviderKind;
  readonly text: string;
  readonly ts: string;
}

interface ParsedSseEvent {
  readonly id?: number;
  readonly event: string;
  readonly data: unknown;
}

interface RunStartMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface StreamCheckpoint {
  runId: string | null;
  cursor: number;
  terminal: boolean;
}

type PortalUiMessage = UIMessage<PortalMessageMetadata>;

export function createControlPlaneTransport(input: {
  apiBase: string;
  getRunConfig: () => RunStartConfig;
  onRunStatus: (event: RunStatusEvent) => void;
  onTodoUpdate: (event: TodoUpdateEvent) => void;
  onRunWarning: (event: RunWarningEvent) => void;
  onRunClosed: () => void;
  onStreamLifecycle?: (event: StreamLifecycleEvent) => void;
}): ChatTransport<PortalUiMessage> {
  const checkpoints = new Map<string, StreamCheckpoint>();

  return {
    sendMessages: async ({ chatId, messages, abortSignal }) => {
      const runConfig = input.getRunConfig();
      const runMessages = toRunMessages(messages);
      if (runMessages.length === 0) {
        throw new Error("消息不能为空");
      }

      const checkpoint: StreamCheckpoint = {
        runId: null,
        cursor: 0,
        terminal: false,
      };
      checkpoints.set(chatId, checkpoint);

      const response = await fetch(`${input.apiBase}/runs/start`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          provider: runConfig.provider,
          model: runConfig.model,
          requireHumanLoop: runConfig.requireHumanLoop,
          executionProfile: runConfig.executionProfile,
          providerOptions: runConfig.providerOptions,
          messages: runMessages,
        }),
        signal: abortSignal ?? null,
      });

      if (!response.ok) {
        throw new Error(await resolveResponseError(response));
      }

      if (!response.body) {
        throw new Error("SSE 响应体为空");
      }

      return sseToUiMessageChunkStream({
        apiBase: input.apiBase,
        stream: response.body,
        abortSignal,
        checkpoint,
        onRunStatus: input.onRunStatus,
        onTodoUpdate: input.onTodoUpdate,
        onRunWarning: input.onRunWarning,
        onRunClosed: input.onRunClosed,
        ...(input.onStreamLifecycle
          ? { onStreamLifecycle: input.onStreamLifecycle }
          : {}),
      });
    },
    reconnectToStream: async ({ chatId }) => {
      const checkpoint = checkpoints.get(chatId);
      if (!checkpoint?.runId || checkpoint.terminal) {
        return null;
      }

      const stream = await openRunStream({
        apiBase: input.apiBase,
        runId: checkpoint.runId,
        cursor: checkpoint.cursor,
      });

      return sseToUiMessageChunkStream({
        apiBase: input.apiBase,
        stream,
        abortSignal: undefined,
        checkpoint,
        onRunStatus: input.onRunStatus,
        onTodoUpdate: input.onTodoUpdate,
        onRunWarning: input.onRunWarning,
        onRunClosed: input.onRunClosed,
        ...(input.onStreamLifecycle
          ? { onStreamLifecycle: input.onStreamLifecycle }
          : {}),
      });
    },
  };
}

function sseToUiMessageChunkStream(input: {
  apiBase: string;
  stream: ReadableStream<Uint8Array>;
  abortSignal: AbortSignal | undefined;
  checkpoint: StreamCheckpoint;
  onRunStatus: (event: RunStatusEvent) => void;
  onTodoUpdate: (event: TodoUpdateEvent) => void;
  onRunWarning: (event: RunWarningEvent) => void;
  onRunClosed: () => void;
  onStreamLifecycle?: (event: StreamLifecycleEvent) => void;
}): ReadableStream<UIMessageChunk<PortalMessageMetadata>> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream<UIMessageChunk<PortalMessageMetadata>>({
    start(controller) {
      const decoder = new TextDecoder();
      const textPartId = `text-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const createdAt = new Date().toISOString();

      let stream = input.stream;
      let buffer = "";
      let textStarted = false;
      let finished = false;
      let reconnecting = false;

      const buildMetadata = (): PortalMessageMetadata => {
        if (input.checkpoint.runId) {
          return {
            createdAt,
            runId: input.checkpoint.runId,
          };
        }
        return { createdAt };
      };

      const pushFinish = (finishReason: FinishReason = "stop") => {
        if (finished) {
          return;
        }
        if (textStarted) {
          controller.enqueue({
            type: "text-end",
            id: textPartId,
          });
        }
        controller.enqueue({
          type: "finish",
          finishReason,
          messageMetadata: buildMetadata(),
        });
        controller.close();
        finished = true;
      };

      const pushErrorAndFinish = (message: string) => {
        if (finished) {
          return;
        }
        controller.enqueue({
          type: "error",
          errorText: message,
        });
        pushFinish("error");
      };

      const ensureTextStarted = () => {
        if (textStarted) {
          return;
        }
        controller.enqueue({
          type: "text-start",
          id: textPartId,
        });
        textStarted = true;
      };

      const abortHandler = () => {
        try {
          void reader?.cancel();
        } catch {
          // ignore cancellation race on released reader
        }
      };

      const runReconnectFlow = async (
        reason: string,
      ): Promise<ReadableStream<Uint8Array> | null> => {
        const runId = input.checkpoint.runId;
        if (!runId || input.checkpoint.terminal) {
          return null;
        }

        reconnecting = true;

        for (let index = 0; index < RECONNECT_BACKOFF_MS.length; index += 1) {
          const attempt = index + 1;
          if (input.abortSignal?.aborted) {
            return null;
          }

          input.onStreamLifecycle?.({
            kind: "reconnecting",
            runId,
            attempt,
            cursor: input.checkpoint.cursor,
            reason,
          });

          try {
            const reconnected = await openRunStream({
              apiBase: input.apiBase,
              runId,
              cursor: input.checkpoint.cursor,
              ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
            });

            input.onStreamLifecycle?.({
              kind: "reconnected",
              runId,
              attempt,
              cursor: input.checkpoint.cursor,
            });
            reconnecting = false;
            return reconnected;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const nextDelay = RECONNECT_BACKOFF_MS[index];
            const isLast = index === RECONNECT_BACKOFF_MS.length - 1;

            if (isLast || nextDelay === undefined) {
              input.onStreamLifecycle?.({
                kind: "reconnect-failed",
                runId,
                attempt,
                cursor: input.checkpoint.cursor,
                reason: message,
              });
              reconnecting = false;
              return null;
            }

            await delay(nextDelay, input.abortSignal);
          }
        }

        reconnecting = false;
        return null;
      };

      input.abortSignal?.addEventListener("abort", abortHandler);

      controller.enqueue({
        type: "start",
        messageMetadata: { createdAt },
      });

      void (async () => {
        while (!finished) {
          reader = stream.getReader();
          let streamEnded = false;

          try {
            while (true) {
              const result = await reader.read();
              if (result.done) {
                streamEnded = true;
                break;
              }

              const { value } = result;
              buffer += decoder.decode(value, { stream: true });
              const parsed = parseSseBuffer(buffer);
              buffer = parsed.rest;

              for (const event of parsed.events) {
                if (typeof event.id === "number") {
                  input.checkpoint.cursor = Math.max(input.checkpoint.cursor, event.id);
                }

                if (event.event === "run.closed") {
                  const runClosedId = getRunIdFromEventData(event.data);
                  if (runClosedId) {
                    input.checkpoint.runId = runClosedId;
                  }
                  input.checkpoint.terminal = true;
                  input.onRunClosed();
                  pushFinish("stop");
                  return;
                }

                if (!event.data || typeof event.data !== "object") {
                  continue;
                }

                const payload = event.data as { type?: string };

                if (payload.type === "run.status") {
                  const statusEvent = payload as RunStatusEvent;
                  input.checkpoint.runId = statusEvent.runId;
                  input.onRunStatus(statusEvent);

                  controller.enqueue({
                    type: "message-metadata",
                    messageMetadata: buildMetadata(),
                  });

                  if (statusEvent.status === "failed") {
                    input.checkpoint.terminal = true;
                    pushErrorAndFinish(statusEvent.detail ?? "运行失败");
                    return;
                  }

                  if (statusEvent.status === "blocked") {
                    input.checkpoint.terminal = true;
                    pushErrorAndFinish(statusEvent.detail ?? "运行被阻塞");
                    return;
                  }

                  if (statusEvent.status === "finished") {
                    input.checkpoint.terminal = true;
                    const detail = (statusEvent.detail ?? "").toLowerCase();
                    if (detail === "canceled") {
                      controller.enqueue({
                        type: "abort",
                        reason: "canceled",
                      });
                    }
                    pushFinish("stop");
                    return;
                  }

                  continue;
                }

                if (payload.type === "message.delta") {
                  const deltaEvent = payload as MessageDeltaEvent;
                  if (!input.checkpoint.runId) {
                    input.checkpoint.runId = deltaEvent.runId;
                  }
                  ensureTextStarted();
                  controller.enqueue({
                    type: "text-delta",
                    id: textPartId,
                    delta: deltaEvent.text,
                  });
                  continue;
                }

                if (payload.type === "todo.update") {
                  input.onTodoUpdate(payload as TodoUpdateEvent);
                  continue;
                }

                if (payload.type === "run.warning") {
                  input.onRunWarning(payload as RunWarningEvent);
                }
              }
            }
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
              controller.enqueue({
                type: "abort",
                reason: "aborted",
              });
              pushFinish("other");
              return;
            }

            if (input.checkpoint.terminal) {
              pushFinish("stop");
              return;
            }

            const nextStream = await runReconnectFlow(
              error instanceof Error ? error.message : String(error),
            );

            if (!nextStream) {
              pushErrorAndFinish("流式连接中断，重连失败");
              return;
            }

            stream = nextStream;
            buffer = "";
            continue;
          } finally {
            reader.releaseLock();
            reader = null;
          }

          if (!streamEnded || finished) {
            continue;
          }

          if (input.checkpoint.terminal) {
            pushFinish("stop");
            return;
          }

          const nextStream = await runReconnectFlow(
            reconnecting ? "stream still reconnecting" : "stream ended unexpectedly",
          );

          if (!nextStream) {
            pushErrorAndFinish("流式连接中断，重连失败");
            return;
          }

          stream = nextStream;
          buffer = "";
        }
      })().finally(() => {
        input.abortSignal?.removeEventListener("abort", abortHandler);
      });
    },
    cancel() {
      try {
        void reader?.cancel();
      } catch {
        // ignore cancellation race on released reader
      }
    },
  });
}

async function openRunStream(input: {
  apiBase: string;
  runId: string;
  cursor: number;
  abortSignal?: AbortSignal;
}): Promise<ReadableStream<Uint8Array>> {
  const query = new URLSearchParams({
    cursor: String(Math.max(0, input.cursor)),
  });
  const response = await fetch(
    `${input.apiBase}/runs/${encodeURIComponent(input.runId)}/stream?${query.toString()}`,
    {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        "last-event-id": String(Math.max(0, input.cursor)),
      },
      signal: input.abortSignal ?? null,
    },
  );

  if (!response.ok) {
    throw new Error(await resolveResponseError(response));
  }

  if (!response.body) {
    throw new Error("SSE 重连响应体为空");
  }

  return response.body;
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

    let eventId: number | undefined;
    let eventName = "message";
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
      if (line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("id:")) {
        const parsed = Number(line.slice("id:".length).trim());
        if (Number.isInteger(parsed) && parsed >= 0) {
          eventId = parsed;
        }
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

    events.push({
      ...(typeof eventId === "number" ? { id: eventId } : {}),
      event: eventName,
      data,
    });
  }

  return {
    events,
    rest,
  };
}

function toRunMessages(messages: PortalUiMessage[]): RunStartMessage[] {
  return messages
    .map((message) => ({
      role: message.role,
      content: extractMessageText(message).trim(),
    }))
    .filter((message) => message.content.length > 0);
}

function getRunIdFromEventData(data: unknown): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const runId = (data as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.trim().length > 0 ? runId : undefined;
}

async function delay(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };

    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
