import type {
  RunStatus,
  TodoStatus,
} from "../services/callback-handler.js";
import type { RunCallbackRepository } from "./run-callback-repository.js";

export interface InMemoryTodoItem {
  readonly runId: string;
  readonly todoId: string;
  readonly content: string;
  readonly status: TodoStatus;
  readonly order: number;
  readonly updatedAt: Date;
}

export interface InMemoryTodoEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly todoId: string;
  readonly content: string;
  readonly status: TodoStatus;
  readonly order: number;
  readonly eventTs: Date;
  readonly payload: Record<string, unknown>;
}

export interface InMemoryHumanLoopRequest {
  readonly questionId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly metadata: Record<string, unknown>;
  readonly status: "pending" | "resolved";
  readonly requestedAt: Date;
  readonly resolvedAt: Date | null;
}

export class InMemoryRunCallbackRepository
  implements RunCallbackRepository
{
  private readonly eventIds = new Set<string>();
  private readonly runContexts = new Map<string, { runId: string; sessionId: string }>();
  private readonly runStatuses = new Map<string, RunStatus>();
  private readonly usageByRun = new Map<string, Record<string, unknown>>();
  private readonly todoItems = new Map<string, InMemoryTodoItem>();
  private readonly todoEvents: InMemoryTodoEvent[] = [];
  private readonly humanLoopRequests = new Map<string, InMemoryHumanLoopRequest>();

  bindRun(runId: string, sessionId: string): void {
    this.runContexts.set(runId, { runId, sessionId });
  }

  getRunStatus(runId: string): RunStatus | undefined {
    return this.runStatuses.get(runId);
  }

  getUsage(runId: string): Record<string, unknown> | undefined {
    return this.usageByRun.get(runId);
  }

  getTodoItem(runId: string, todoId: string): InMemoryTodoItem | undefined {
    return this.todoItems.get(this.todoKey(runId, todoId));
  }

  listTodoEvents(runId: string): InMemoryTodoEvent[] {
    return this.todoEvents.filter((item) => item.runId === runId);
  }

  getHumanLoopRequest(questionId: string): InMemoryHumanLoopRequest | undefined {
    return this.humanLoopRequests.get(questionId);
  }

  async recordEventIfNew(input: { eventId: string }): Promise<boolean> {
    if (this.eventIds.has(input.eventId)) {
      return false;
    }
    this.eventIds.add(input.eventId);
    return true;
  }

  async findRunContext(
    runId: string,
  ): Promise<{ runId: string; sessionId: string } | null> {
    return this.runContexts.get(runId) ?? null;
  }

  async updateRunStatus(input: {
    runId: string;
    status: RunStatus;
  }): Promise<void> {
    this.runStatuses.set(input.runId, input.status);
  }

  async finalizeUsage(input: {
    runId: string;
    usage: Record<string, unknown>;
  }): Promise<void> {
    if (!this.usageByRun.has(input.runId)) {
      this.usageByRun.set(input.runId, input.usage);
    }
  }

  async upsertTodo(input: {
    runId: string;
    todoId: string;
    content: string;
    status: TodoStatus;
    order: number;
    updatedAt: Date;
  }): Promise<void> {
    const key = this.todoKey(input.runId, input.todoId);
    this.todoItems.set(key, {
      runId: input.runId,
      todoId: input.todoId,
      content: input.content,
      status: input.status,
      order: input.order,
      updatedAt: input.updatedAt,
    });
  }

  async appendTodoEvent(input: {
    eventId: string;
    runId: string;
    todoId: string;
    content: string;
    status: TodoStatus;
    order: number;
    eventTs: Date;
    payload: Record<string, unknown>;
  }): Promise<void> {
    this.todoEvents.push({
      eventId: input.eventId,
      runId: input.runId,
      todoId: input.todoId,
      content: input.content,
      status: input.status,
      order: input.order,
      eventTs: input.eventTs,
      payload: input.payload,
    });
  }

  async upsertPendingRequest(input: {
    questionId: string;
    runId: string;
    sessionId: string;
    prompt: string;
    metadata: Record<string, unknown>;
    requestedAt: Date;
  }): Promise<void> {
    const existing = this.humanLoopRequests.get(input.questionId);
    if (existing) {
      this.humanLoopRequests.set(input.questionId, {
        ...existing,
        prompt: input.prompt,
        metadata: input.metadata,
      });
      return;
    }

    this.humanLoopRequests.set(input.questionId, {
      questionId: input.questionId,
      runId: input.runId,
      sessionId: input.sessionId,
      prompt: input.prompt,
      metadata: input.metadata,
      status: "pending",
      requestedAt: input.requestedAt,
      resolvedAt: null,
    });
  }

  async markResolved(input: {
    questionId: string;
    runId: string;
    resolvedAt: Date;
  }): Promise<void> {
    const existing = this.humanLoopRequests.get(input.questionId);
    if (!existing || existing.runId !== input.runId) {
      return;
    }

    this.humanLoopRequests.set(input.questionId, {
      ...existing,
      status: "resolved",
      resolvedAt: input.resolvedAt,
    });
  }

  private todoKey(runId: string, todoId: string): string {
    return `${runId}:${todoId}`;
  }
}
