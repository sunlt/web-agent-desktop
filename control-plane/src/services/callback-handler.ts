import type { SyncReason } from "../ports/workspace-sync-client.js";

export type RunCompletionStatus = "succeeded" | "failed" | "canceled";
export type RunStatus =
  | "running"
  | "waiting_human"
  | RunCompletionStatus;
export type TodoStatus = "todo" | "doing" | "done" | "canceled";

export interface TodoPayload {
  readonly todoId: string;
  readonly content: string;
  readonly status: TodoStatus;
  readonly order: number;
  readonly updatedAt: Date;
}

export type CallbackEvent =
  | {
      readonly eventId: string;
      readonly runId: string;
      readonly type: "message.stop";
      readonly occurredAt: Date;
      readonly payload?: Record<string, unknown>;
    }
  | {
      readonly eventId: string;
      readonly runId: string;
      readonly type: "todo.update";
      readonly occurredAt: Date;
      readonly todo: TodoPayload;
      readonly payload?: Record<string, unknown>;
    }
  | {
      readonly eventId: string;
      readonly runId: string;
      readonly type: "human_loop.requested";
      readonly occurredAt: Date;
      readonly questionId: string;
      readonly prompt: string;
      readonly metadata?: Record<string, unknown>;
      readonly payload?: Record<string, unknown>;
    }
  | {
      readonly eventId: string;
      readonly runId: string;
      readonly type: "human_loop.resolved";
      readonly occurredAt: Date;
      readonly questionId: string;
      readonly payload?: Record<string, unknown>;
    }
  | {
      readonly eventId: string;
      readonly runId: string;
      readonly type: "run.finished";
      readonly occurredAt: Date;
      readonly status: RunCompletionStatus;
      readonly usage?: Record<string, unknown>;
      readonly payload?: Record<string, unknown>;
    };

export interface RunEventRepository {
  recordEventIfNew(input: {
    readonly eventId: string;
    readonly runId: string;
    readonly eventType: string;
    readonly payload: Record<string, unknown>;
    readonly eventTs: Date;
  }): Promise<boolean>;
}

export interface RunContextRepository {
  findRunContext(runId: string): Promise<{ runId: string; sessionId: string } | null>;
}

export interface RunStateRepository {
  updateRunStatus(input: {
    readonly runId: string;
    readonly status: RunStatus;
    readonly updatedAt: Date;
  }): Promise<void>;

  finalizeUsage(input: {
    readonly runId: string;
    readonly usage: Record<string, unknown>;
    readonly finalizedAt: Date;
  }): Promise<void>;
}

export interface TodoRepository {
  upsertTodo(input: {
    readonly runId: string;
    readonly todoId: string;
    readonly content: string;
    readonly status: TodoStatus;
    readonly order: number;
    readonly updatedAt: Date;
  }): Promise<void>;

  appendTodoEvent(input: {
    readonly eventId: string;
    readonly runId: string;
    readonly todoId: string;
    readonly content: string;
    readonly status: TodoStatus;
    readonly order: number;
    readonly eventTs: Date;
    readonly payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface HumanLoopRepository {
  upsertPendingRequest(input: {
    readonly questionId: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly prompt: string;
    readonly metadata: Record<string, unknown>;
    readonly requestedAt: Date;
  }): Promise<void>;

  markResolved(input: {
    readonly questionId: string;
    readonly runId: string;
    readonly resolvedAt: Date;
  }): Promise<void>;
}

export interface SessionSyncService {
  syncSessionWorkspace(
    sessionId: string,
    reason: SyncReason,
    now: Date,
    runId?: string,
  ): Promise<boolean>;
}

export interface CallbackHandlerDeps {
  readonly eventRepo: RunEventRepository;
  readonly runContextRepo: RunContextRepository;
  readonly runStateRepo: RunStateRepository;
  readonly todoRepo: TodoRepository;
  readonly humanLoopRepo: HumanLoopRepository;
  readonly sessionSyncService: SessionSyncService;
}

export interface CallbackHandleResult {
  readonly processed: boolean;
  readonly duplicate: boolean;
  readonly action:
    | "duplicate_ignored"
    | "message_stop_synced"
    | "message_stop_missing_run"
    | "todo_upserted"
    | "human_loop_requested"
    | "human_loop_resolved"
    | "human_loop_missing_run"
    | "run_finished";
}

export class CallbackHandler {
  constructor(private readonly deps: CallbackHandlerDeps) {}

  async handle(event: CallbackEvent): Promise<CallbackHandleResult> {
    const payload = event.payload ?? this.defaultPayload(event);

    const accepted = await this.deps.eventRepo.recordEventIfNew({
      eventId: event.eventId,
      runId: event.runId,
      eventType: event.type,
      payload,
      eventTs: event.occurredAt,
    });

    if (!accepted) {
      return {
        processed: false,
        duplicate: true,
        action: "duplicate_ignored",
      };
    }

    if (event.type === "message.stop") {
      const context = await this.deps.runContextRepo.findRunContext(event.runId);
      if (!context) {
        return {
          processed: true,
          duplicate: false,
          action: "message_stop_missing_run",
        };
      }

      await this.deps.sessionSyncService.syncSessionWorkspace(
        context.sessionId,
        "message.stop",
        event.occurredAt,
        event.runId,
      );

      return {
        processed: true,
        duplicate: false,
        action: "message_stop_synced",
      };
    }

    if (event.type === "todo.update") {
      await this.deps.todoRepo.upsertTodo({
        runId: event.runId,
        todoId: event.todo.todoId,
        content: event.todo.content,
        status: event.todo.status,
        order: event.todo.order,
        updatedAt: event.todo.updatedAt,
      });

      await this.deps.todoRepo.appendTodoEvent({
        eventId: event.eventId,
        runId: event.runId,
        todoId: event.todo.todoId,
        content: event.todo.content,
        status: event.todo.status,
        order: event.todo.order,
        eventTs: event.occurredAt,
        payload,
      });

      return {
        processed: true,
        duplicate: false,
        action: "todo_upserted",
      };
    }

    if (event.type === "human_loop.requested") {
      const context = await this.deps.runContextRepo.findRunContext(event.runId);
      if (!context) {
        return {
          processed: true,
          duplicate: false,
          action: "human_loop_missing_run",
        };
      }

      await this.deps.humanLoopRepo.upsertPendingRequest({
        questionId: event.questionId,
        runId: event.runId,
        sessionId: context.sessionId,
        prompt: event.prompt,
        metadata: event.metadata ?? {},
        requestedAt: event.occurredAt,
      });

      await this.deps.runStateRepo.updateRunStatus({
        runId: event.runId,
        status: "waiting_human",
        updatedAt: event.occurredAt,
      });

      return {
        processed: true,
        duplicate: false,
        action: "human_loop_requested",
      };
    }

    if (event.type === "human_loop.resolved") {
      await this.deps.humanLoopRepo.markResolved({
        questionId: event.questionId,
        runId: event.runId,
        resolvedAt: event.occurredAt,
      });

      await this.deps.runStateRepo.updateRunStatus({
        runId: event.runId,
        status: "running",
        updatedAt: event.occurredAt,
      });

      return {
        processed: true,
        duplicate: false,
        action: "human_loop_resolved",
      };
    }

    await this.deps.runStateRepo.updateRunStatus({
      runId: event.runId,
      status: event.status,
      updatedAt: event.occurredAt,
    });

    if (event.usage) {
      await this.deps.runStateRepo.finalizeUsage({
        runId: event.runId,
        usage: event.usage,
        finalizedAt: event.occurredAt,
      });
    }

    return {
      processed: true,
      duplicate: false,
      action: "run_finished",
    };
  }

  private defaultPayload(event: CallbackEvent): Record<string, unknown> {
    if (event.type === "todo.update") {
      return {
        todoId: event.todo.todoId,
        status: event.todo.status,
      };
    }

    if (event.type === "run.finished") {
      return {
        status: event.status,
      };
    }

    if (event.type === "human_loop.requested") {
      return {
        questionId: event.questionId,
      };
    }

    if (event.type === "human_loop.resolved") {
      return {
        questionId: event.questionId,
      };
    }

    return {};
  }
}
