import type {
  ChatTransport,
  FinishReason,
  UIMessage,
  UIMessageChunk,
} from "ai";
import { extractMessageText, resolveResponseError } from "./utils";

export type ProviderKind = "claude-code" | "opencode" | "codex-cli";

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

interface MessageDeltaEvent {
  readonly type: "message.delta";
  readonly runId: string;
  readonly provider: ProviderKind;
  readonly text: string;
  readonly ts: string;
}

interface ParsedSseEvent {
  readonly event: string;
  readonly data: unknown;
}

interface RunStartMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

type PortalUiMessage = UIMessage<PortalMessageMetadata>;

export function createControlPlaneTransport(input: {
  apiBase: string;
  getRunConfig: () => RunStartConfig;
  onRunStatus: (event: RunStatusEvent) => void;
  onTodoUpdate: (event: TodoUpdateEvent) => void;
  onRunWarning: (event: RunWarningEvent) => void;
  onRunClosed: () => void;
}): ChatTransport<PortalUiMessage> {
  return {
    sendMessages: async ({ messages, abortSignal }) => {
      const runConfig = input.getRunConfig();
      const runMessages = toRunMessages(messages);
      if (runMessages.length === 0) {
        throw new Error("消息不能为空");
      }

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
        stream: response.body,
        abortSignal,
        onRunStatus: input.onRunStatus,
        onTodoUpdate: input.onTodoUpdate,
        onRunWarning: input.onRunWarning,
        onRunClosed: input.onRunClosed,
      });
    },
    reconnectToStream: async () => null,
  };
}

function sseToUiMessageChunkStream(input: {
  stream: ReadableStream<Uint8Array>;
  abortSignal: AbortSignal | undefined;
  onRunStatus: (event: RunStatusEvent) => void;
  onTodoUpdate: (event: TodoUpdateEvent) => void;
  onRunWarning: (event: RunWarningEvent) => void;
  onRunClosed: () => void;
}): ReadableStream<UIMessageChunk<PortalMessageMetadata>> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream<UIMessageChunk<PortalMessageMetadata>>({
    start(controller) {
      reader = input.stream.getReader();
      const decoder = new TextDecoder();
      const textPartId = `text-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const createdAt = new Date().toISOString();

      let buffer = "";
      let textStarted = false;
      let finished = false;
      let runId: string | undefined;
      const buildMetadata = (): PortalMessageMetadata =>
        runId ? { createdAt, runId } : { createdAt };

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
        void reader?.cancel();
      };

      input.abortSignal?.addEventListener("abort", abortHandler);

      controller.enqueue({
        type: "start",
        messageMetadata: {
          createdAt,
        },
      });

      void (async () => {
        try {
          while (true) {
            const result = await reader?.read();
            if (!result) {
              break;
            }
            const { value, done } = result;
            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSseBuffer(buffer);
            buffer = parsed.rest;

            for (const event of parsed.events) {
              if (event.event === "run.closed") {
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
                runId = statusEvent.runId;
                input.onRunStatus(statusEvent);

                controller.enqueue({
                  type: "message-metadata",
                  messageMetadata: buildMetadata(),
                });

                if (statusEvent.status === "failed") {
                  pushErrorAndFinish(statusEvent.detail ?? "运行失败");
                  return;
                }

                if (statusEvent.status === "blocked") {
                  pushErrorAndFinish(statusEvent.detail ?? "运行被阻塞");
                  return;
                }

                if (statusEvent.status === "finished") {
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

          pushFinish("stop");
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            controller.enqueue({
              type: "abort",
              reason: "aborted",
            });
            pushFinish("other");
            return;
          }

          pushErrorAndFinish(error instanceof Error ? error.message : String(error));
        } finally {
          input.abortSignal?.removeEventListener("abort", abortHandler);
        }
      })();
    },
    cancel() {
      void reader?.cancel();
    },
  });
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

    events.push({
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
