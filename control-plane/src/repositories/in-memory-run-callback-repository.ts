import type {
  HumanLoopRequestRecord,
  HumanLoopRequestStatus,
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
  readonly status: HumanLoopRequestStatus;
  readonly requestedAt: Date;
  readonly resolvedAt: Date | null;
}

interface InMemoryHumanLoopResponse {
  readonly questionId: string;
  readonly runId: string;
  readonly answer: string;
  readonly createdAt: Date;
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
  private readonly humanLoopResponses = new Map<string, InMemoryHumanLoopResponse>();

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

  getTodoEvents(runId: string): InMemoryTodoEvent[] {
    return this.todoEvents.filter((item) => item.runId === runId);
  }

  async listTodoItems(input: {
    runId: string;
    limit?: number;
  }): Promise<readonly InMemoryTodoItem[]> {
    const items = Array.from(this.todoItems.values())
      .filter((item) => item.runId === input.runId)
      .sort((a, b) => {
        if (a.order !== b.order) {
          return a.order - b.order;
        }
        return a.updatedAt.getTime() - b.updatedAt.getTime();
      });

    const limit = input.limit ?? items.length;
    return items.slice(0, limit);
  }

  async listTodoEvents(input: {
    runId: string;
    limit?: number;
  }): Promise<readonly InMemoryTodoEvent[]> {
    const events = this.todoEvents
      .filter((item) => item.runId === input.runId)
      .sort((a, b) => a.eventTs.getTime() - b.eventTs.getTime());
    const limit = input.limit ?? events.length;
    return events.slice(0, limit);
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
    await this.markRequestStatus({
      questionId: input.questionId,
      runId: input.runId,
      status: "resolved",
      resolvedAt: input.resolvedAt,
    });
  }

  async markRequestStatus(input: {
    questionId: string;
    runId: string;
    status: Exclude<HumanLoopRequestStatus, "pending">;
    resolvedAt: Date;
  }): Promise<void> {
    const existing = this.humanLoopRequests.get(input.questionId);
    if (!existing || existing.runId !== input.runId) {
      return;
    }

    this.humanLoopRequests.set(input.questionId, {
      ...existing,
      status: input.status,
      resolvedAt: input.resolvedAt,
    });
  }

  async listPendingRequests(input: {
    runId?: string;
    limit?: number;
  }): Promise<readonly HumanLoopRequestRecord[]> {
    return this.listRequests({
      runId: input.runId,
      limit: input.limit,
      status: "pending",
    });
  }

  async listRequests(input: {
    runId?: string;
    limit?: number;
    status?: HumanLoopRequestStatus;
  }): Promise<readonly HumanLoopRequestRecord[]> {
    const requests = Array.from(this.humanLoopRequests.values())
      .filter((item) => (input.status ? item.status === input.status : true))
      .filter((item) => (input.runId ? item.runId === input.runId : true))
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());

    const limit = input.limit ?? requests.length;
    return requests.slice(0, limit);
  }

  async findRequest(questionId: string): Promise<HumanLoopRequestRecord | null> {
    return this.humanLoopRequests.get(questionId) ?? null;
  }

  async saveResponse(input: {
    questionId: string;
    runId: string;
    answer: string;
    createdAt: Date;
  }): Promise<{ readonly inserted: boolean }> {
    const key = this.responseKey(input.runId, input.questionId);
    if (this.humanLoopResponses.has(key)) {
      return { inserted: false };
    }

    this.humanLoopResponses.set(key, {
      questionId: input.questionId,
      runId: input.runId,
      answer: input.answer,
      createdAt: input.createdAt,
    });
    return { inserted: true };
  }

  private todoKey(runId: string, todoId: string): string {
    return `${runId}:${todoId}`;
  }

  private responseKey(runId: string, questionId: string): string {
    return `${runId}:${questionId}`;
  }
}
