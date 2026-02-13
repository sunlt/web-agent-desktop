import { streamText, type LanguageModel, type ModelMessage } from "ai";
import type {
  ChatMessage,
  ProviderRunHandle,
  ProviderStreamChunk,
} from "./types.js";

export function toModelMessages(messages: readonly ChatMessage[]): ModelMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }
  return value;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return values.length > 0 ? values : undefined;
}

export function asBooleanRecord(
  value: unknown,
): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const result: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "boolean") {
      result[key] = item;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function asStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function withoutUndefined<T extends Record<string, unknown>>(
  value: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

export function createStreamingRunHandle(input: {
  model: LanguageModel;
  messages: readonly ChatMessage[];
}): ProviderRunHandle {
  const abortController = new AbortController();

  const result = streamText({
    model: input.model,
    messages: toModelMessages(input.messages),
    abortSignal: abortController.signal,
  });

  return {
    stream: async function* (): AsyncIterable<ProviderStreamChunk> {
      const toolOrder = new Map<string, number>();
      let nextOrder = 1;
      let finished = false;

      const ensureOrder = (toolCallId: string): number => {
        const existing = toolOrder.get(toolCallId);
        if (existing) {
          return existing;
        }

        const order = nextOrder;
        nextOrder += 1;
        toolOrder.set(toolCallId, order);
        return order;
      };

      const emitFinish = (
        status: "succeeded" | "failed" | "canceled",
        reason?: string,
        usage?: Record<string, unknown>,
      ): ProviderStreamChunk => ({
        type: "run.finished",
        status,
        ...(reason ? { reason } : {}),
        usage,
      });

      try {
        for await (const part of result.fullStream) {
          if (part.type === "text-delta" && part.text.length > 0) {
            yield {
              type: "message.delta",
              text: part.text,
            };
            continue;
          }

          if (part.type === "tool-call") {
            const order = ensureOrder(part.toolCallId);
            yield {
              type: "todo.update",
              todo: {
                todoId: part.toolCallId,
                content: `调用工具: ${part.toolName}`,
                status: "doing",
                order,
              },
            };
            continue;
          }

          if (part.type === "tool-result") {
            const order = ensureOrder(part.toolCallId);
            yield {
              type: "todo.update",
              todo: {
                todoId: part.toolCallId,
                content: `工具完成: ${part.toolName}`,
                status: "done",
                order,
              },
            };
            continue;
          }

          if (part.type === "tool-error") {
            const order = ensureOrder(part.toolCallId);
            yield {
              type: "todo.update",
              todo: {
                todoId: part.toolCallId,
                content: `工具失败: ${part.toolName}`,
                status: "canceled",
                order,
              },
            };
            continue;
          }

          if (part.type === "tool-output-denied") {
            const order = ensureOrder(part.toolCallId);
            yield {
              type: "todo.update",
              todo: {
                todoId: part.toolCallId,
                content: `工具被拒绝: ${part.toolName}`,
                status: "canceled",
                order,
              },
            };
            continue;
          }

          if (part.type === "abort" && !finished) {
            finished = true;
            yield emitFinish("canceled");
            continue;
          }

          if (part.type === "finish" && !finished) {
            finished = true;
            const status = mapFinishReason(part.finishReason, abortController.signal.aborted);
            const reason = status === "failed"
              ? `finish_reason:${part.finishReason ?? "error"}`
              : undefined;
            yield emitFinish(status, reason, toUsageRecord(part.totalUsage));
          }
        }

        if (!finished) {
          const reason = await result.finishReason;
          const usage = await result.totalUsage;
          const status = mapFinishReason(reason, abortController.signal.aborted);
          const detail = status === "failed"
            ? `finish_reason:${reason ?? "error"}`
            : undefined;
          yield emitFinish(
            status,
            detail,
            toUsageRecord(usage),
          );
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          yield {
            type: "run.finished",
            status: "canceled",
          };
          return;
        }

        yield emitFinish(
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    stop: async () => {
      abortController.abort();
    },
  };
}

function mapFinishReason(
  reason: string | undefined,
  aborted: boolean,
): "succeeded" | "failed" | "canceled" {
  if (aborted) {
    return "canceled";
  }

  if (reason === "error" || reason === "content-filter") {
    return "failed";
  }

  if (reason === "other") {
    return "canceled";
  }

  return "succeeded";
}

function toUsageRecord(usage: unknown): Record<string, unknown> | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(usage as Record<string, unknown>).filter(
      ([, value]) => value !== undefined,
    ),
  );
}
