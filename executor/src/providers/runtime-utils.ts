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
            const abortReason =
              typeof part.reason === "string" && part.reason.trim().length > 0
                ? `aborted:${part.reason.trim()}`
                : "aborted";
            yield emitFinish("canceled", abortReason);
            continue;
          }

          if (part.type === "error" && !finished) {
            finished = true;
            yield emitFinish("failed", normalizeErrorReason(part.error));
            continue;
          }

          if (part.type === "finish" && !finished) {
            finished = true;
            const mapped = mapFinishResult(
              part.finishReason,
              abortController.signal.aborted,
            );
            yield emitFinish(
              mapped.status,
              mapped.reason,
              toUsageRecord(part.totalUsage),
            );
          }
        }

        if (!finished) {
          const reason = await result.finishReason;
          const usage = await result.totalUsage;
          const mapped = mapFinishResult(reason, abortController.signal.aborted);
          yield emitFinish(
            mapped.status,
            mapped.reason,
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
          normalizeErrorReason(error),
        );
      }
    },
    stop: async () => {
      abortController.abort();
    },
  };
}

function mapFinishResult(
  reason: string | undefined,
  aborted: boolean,
): {
  status: "succeeded" | "failed" | "canceled";
  reason?: string;
} {
  if (aborted) {
    return {
      status: "canceled",
      reason: "aborted",
    };
  }

  if (reason === "error" || reason === "content-filter") {
    return {
      status: "failed",
      reason: `finish_reason:${reason}`,
    };
  }

  if (reason === "other") {
    return {
      status: "canceled",
      reason: "finish_reason:other",
    };
  }

  return {
    status: "succeeded",
  };
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

function normalizeErrorReason(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? message : error.name;
  }
  if (typeof error === "string") {
    const message = error.trim();
    return message.length > 0 ? message : "unknown_error";
  }
  if (error && typeof error === "object") {
    const candidate = (error as { message?: unknown }).message;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "unknown_error";
}
