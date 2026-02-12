import type { UIMessage } from "ai";

export const DEFAULT_HUMAN_LOOP_TIMEOUT_MS = 5 * 60 * 1000;

export type FilePreviewMode = "none" | "text" | "image" | "pdf" | "binary";

export type HistoryMessageRole = "system" | "user" | "assistant";

export interface HistoryMessage {
  readonly role: HistoryMessageRole;
  readonly content: string;
  readonly createdAt: string;
}

export interface HistoryStoredMessage {
  readonly id: string;
  readonly chatId: string;
  readonly role: HistoryMessageRole;
  readonly content: string;
  readonly createdAt: string;
}

export interface HistorySummary {
  readonly chatId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastMessageAt: string | null;
}

export interface HumanLoopTimeoutInput {
  readonly requestedAt: string;
  readonly metadata: Record<string, unknown>;
}

export function extractMessageText<TMeta>(
  message: UIMessage<TMeta>,
): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function toHistoryMessages<TMeta>(
  messages: readonly UIMessage<TMeta>[],
): HistoryMessage[] {
  return messages
    .map((message) => ({
      role: message.role,
      content: extractMessageText(message).trim(),
      createdAt: getMessageCreatedAt(message),
    }))
    .filter((item) => item.content.length > 0);
}

export function toPortalMessages<TMeta>(
  messages: readonly HistoryStoredMessage[],
  buildMetadata: (createdAt: string) => TMeta,
): UIMessage<TMeta>[] {
  return messages.map((message) => ({
    id: `h-${message.id}`,
    role: message.role,
    metadata: buildMetadata(message.createdAt),
    parts: [
      {
        type: "text",
        text: message.content,
        state: "done",
      },
    ],
  }));
}

export function sortHistorySummaries(
  chats: readonly HistorySummary[],
): HistorySummary[] {
  return Array.from(
    chats
      .reduce((map, item) => map.set(item.chatId, item), new Map<string, HistorySummary>())
      .values(),
  ).sort((a, b) => {
    const aTs = new Date(a.lastMessageAt ?? a.updatedAt).getTime();
    const bTs = new Date(b.lastMessageAt ?? b.updatedAt).getTime();
    return bTs - aTs;
  });
}

export async function resolveResponseError(response: Response): Promise<string> {
  const text = await response.text();
  let message = `请求失败(${response.status})`;
  if (!text) {
    return message;
  }

  try {
    const parsed = JSON.parse(text) as { error?: string; reason?: string };
    return parsed.error ?? parsed.reason ?? text;
  } catch {
    message = text;
  }

  return message;
}

export function normalizeUiPath(path: string): string {
  if (!path.trim()) {
    return "/";
  }
  return path.startsWith("/") ? path : `/${path}`;
}

export function joinUiPath(base: string, child: string): string {
  const normalizedBase = normalizeUiPath(base);
  if (normalizedBase === "/") {
    return `/${child}`;
  }
  return `${normalizedBase}/${child}`.replace(/\/+/g, "/");
}

export function parentUiPath(path: string): string {
  const normalized = normalizeUiPath(path);
  if (normalized === "/") {
    return "/";
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return "/";
  }
  return `/${parts.slice(0, -1).join("/")}`;
}

export function resolveFilePreviewMode(
  path: string,
  contentType: string,
  encoding: "utf8" | "base64",
): FilePreviewMode {
  if (encoding === "utf8") {
    return "text";
  }

  const lowerPath = path.toLowerCase();
  if (contentType.startsWith("image/")) {
    return "image";
  }
  if (contentType === "application/pdf" || lowerPath.endsWith(".pdf")) {
    return "pdf";
  }
  return "binary";
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) {
    return "-";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function uint8ArrayToBase64(input: Uint8Array): string {
  let binary = "";
  for (const item of input) {
    binary += String.fromCharCode(item);
  }
  return btoa(binary);
}

export function resolveHumanLoopTimeoutState(
  input: HumanLoopTimeoutInput,
  nowMs: number,
): {
  timedOut: boolean;
  text: string;
} {
  const requestedMs = new Date(input.requestedAt).getTime();
  if (!Number.isFinite(requestedMs)) {
    return {
      timedOut: false,
      text: "等待中",
    };
  }

  const deadlineMs = resolveHumanLoopDeadlineMs(input, requestedMs);
  const remainingMs = deadlineMs - nowMs;
  if (remainingMs <= 0) {
    return {
      timedOut: true,
      text: `已超时 ${formatDuration(Math.abs(remainingMs))}（仅提示，不自动完成）`,
    };
  }

  return {
    timedOut: false,
    text: `剩余 ${formatDuration(remainingMs)}`,
  };
}

function resolveHumanLoopDeadlineMs(
  input: HumanLoopTimeoutInput,
  requestedMs: number,
): number {
  const deadlineAt = asString(input.metadata.deadlineAt);
  if (deadlineAt) {
    const deadlineMs = new Date(deadlineAt).getTime();
    if (Number.isFinite(deadlineMs)) {
      return deadlineMs;
    }
  }

  const timeoutMs = asNumber(input.metadata.timeoutMs);
  if (timeoutMs && timeoutMs > 0) {
    return requestedMs + timeoutMs;
  }

  return requestedMs + DEFAULT_HUMAN_LOOP_TIMEOUT_MS;
}

function getMessageCreatedAt<TMeta>(message: UIMessage<TMeta>): string {
  const metadata = message.metadata as { createdAt?: unknown } | undefined;
  if (metadata?.createdAt && typeof metadata.createdAt === "string") {
    return metadata.createdAt;
  }
  return new Date().toISOString();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes.toString().padStart(2, "0")}m`;
  }
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
