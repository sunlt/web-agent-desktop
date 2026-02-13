import type { Request, Response } from "express";
import type { ChatMessage, ProviderKind } from "./providers/types.js";
import type { ProviderRunner } from "./services/provider-runner.js";

export type ParsedProviderRunStartInput = {
  runId?: string;
  provider: ProviderKind;
  model: string;
  messages: ChatMessage[];
  resumeSessionId?: string;
  executionProfile?: string;
  tools?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
  requireHumanLoop?: boolean;
};

export function parseProviderRunStartInput(
  value: unknown,
  options: {
    requireRunId: boolean;
    requireProvider: boolean;
    allowAgentField: boolean;
  },
): ParsedProviderRunStartInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }

  const body = value as Record<string, unknown>;
  const runId = options.requireRunId
    ? requireString(body.runId, "runId")
    : optionalString(body.runId);

  let provider: ProviderKind;
  if (body.provider === undefined || body.provider === null) {
    if (options.requireProvider) {
      throw new Error("provider is required");
    }
    provider = "opencode";
  } else {
    provider = parseProviderKind(body.provider);
  }

  const executionProfile = optionalString(body.executionProfile)
    ?? (options.allowAgentField ? optionalString(body.agent) : undefined);

  const resumeSessionId = optionalString(body.resumeSessionId);
  const tools = asObjectRecord(body.tools);
  const providerOptions = asObjectRecord(body.providerOptions);

  return {
    ...(runId ? { runId } : {}),
    provider,
    model: requireString(body.model, "model"),
    messages: parseChatMessages(body.messages),
    ...(resumeSessionId ? { resumeSessionId } : {}),
    ...(executionProfile ? { executionProfile } : {}),
    ...(tools ? { tools } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    ...(body.requireHumanLoop === true ? { requireHumanLoop: true } : {}),
  };
}

export function parseAfterSeq(req: Request): number {
  const queryCursor =
    typeof req.query?.cursor === "string" ? req.query.cursor : undefined;
  const lastEventId = req.headers["last-event-id"];
  const headerCursor =
    typeof lastEventId === "string"
      ? lastEventId
      : Array.isArray(lastEventId)
        ? lastEventId[0]
        : undefined;
  const raw = queryCursor ?? headerCursor;
  if (!raw) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

export function streamProviderRun(input: {
  req: Request;
  res: Response;
  runId: string;
  afterSeq: number;
  cancelOnClientClose: boolean;
  startedPayload?: {
    runId: string;
    warnings: readonly string[];
  };
  providerRunner: ProviderRunner;
}): void {
  input.res.status(200);
  input.res.setHeader("content-type", "text/event-stream; charset=utf-8");
  input.res.setHeader("cache-control", "no-cache");
  input.res.setHeader("connection", "keep-alive");
  input.res.flushHeaders?.();

  if (input.startedPayload) {
    input.res.write(`event: run.started\n`);
    input.res.write(`data: ${JSON.stringify(input.startedPayload)}\n\n`);
  }

  const unsubscribe = input.providerRunner.subscribe({
    runId: input.runId,
    afterSeq: input.afterSeq,
    onEvent: (entry) => {
      input.res.write(`id: ${entry.seq}\n`);
      input.res.write(`event: ${entry.event.type}\n`);
      input.res.write(`data: ${JSON.stringify(entry.event)}\n\n`);
    },
    onClose: () => {
      input.res.write(
        `event: provider.closed\ndata: ${JSON.stringify({ runId: input.runId })}\n\n`,
      );
      input.res.end();
    },
  });

  const heartbeat = setInterval(() => {
    input.res.write(": heartbeat\n\n");
  }, 15_000);

  input.req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    if (input.cancelOnClientClose) {
      void input.providerRunner.stopRun(input.runId);
    }
  });
}

function parseChatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("messages is required");
  }

  const parsed: ChatMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      throw new Error("invalid message item");
    }
    const message = item as { role?: unknown; content?: unknown; parts?: unknown };
    const role = parseMessageRole(message.role);
    const content = parseMessageContent(message.content, message.parts);
    parsed.push({ role, content });
  }

  return parsed;
}

function parseMessageContent(content: unknown, parts: unknown): string {
  if (typeof content === "string" && content.trim().length > 0) {
    return content;
  }

  if (!Array.isArray(parts)) {
    throw new Error("content is required");
  }

  const textParts: string[] = [];
  for (const item of parts) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const part = item as { type?: unknown; text?: unknown };
    if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
      textParts.push(part.text);
    }
  }

  const merged = textParts.join("\n");
  if (merged.trim().length === 0) {
    throw new Error("content is required");
  }
  return merged;
}

function parseMessageRole(value: unknown): ChatMessage["role"] {
  if (value === "system" || value === "user" || value === "assistant") {
    return value;
  }
  throw new Error(`invalid message role: ${String(value)}`);
}

function parseProviderKind(value: unknown): ProviderKind {
  if (
    value === "claude-code" ||
    value === "opencode" ||
    value === "codex-cli" ||
    value === "codex-app-server"
  ) {
    return value;
  }
  throw new Error(`invalid provider: ${String(value)}`);
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}
