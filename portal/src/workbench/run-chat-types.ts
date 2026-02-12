import type { UIMessage } from "ai";

import type { PortalMessageMetadata } from "./transport";

export type TodoStatus = "todo" | "doing" | "done" | "canceled";

export type HistoryStatus = "idle" | "loading" | "error";

export type StreamConnectionState =
  | "idle"
  | "connected"
  | "reconnecting"
  | "recover_failed";

export type PortalUiMessage = UIMessage<PortalMessageMetadata>;

export interface TodoItem {
  readonly runId: string;
  readonly todoId: string;
  readonly content: string;
  readonly status: TodoStatus;
  readonly order: number;
  readonly updatedAt: string;
}

export interface TodoEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly todoId: string;
  readonly content: string;
  readonly status: TodoStatus;
  readonly order: number;
  readonly eventTs: string;
}

export interface HumanLoopRequest {
  readonly questionId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly metadata: Record<string, unknown>;
  readonly status: "pending" | "resolved";
  readonly requestedAt: string;
  readonly resolvedAt: string | null;
}

export interface TimelineEntry {
  readonly id: string;
  readonly ts: string;
  readonly label: string;
}

export interface StreamConnection {
  readonly state: StreamConnectionState;
  readonly attempt: number;
  readonly cursor: number;
  readonly reason: string;
}
