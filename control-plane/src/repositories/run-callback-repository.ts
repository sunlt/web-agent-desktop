import type {
  HumanLoopRepository,
  RunContextRepository,
  RunEventRepository,
  RunStateRepository,
  TodoRepository,
  TodoStatus,
} from "../services/callback-handler.js";

export interface TodoItemRecord {
  readonly runId: string;
  readonly todoId: string;
  readonly content: string;
  readonly status: TodoStatus;
  readonly order: number;
  readonly updatedAt: Date;
}

export interface TodoEventRecord {
  readonly eventId: string;
  readonly runId: string;
  readonly todoId: string;
  readonly content: string;
  readonly status: TodoStatus;
  readonly order: number;
  readonly eventTs: Date;
  readonly payload: Record<string, unknown>;
}

export interface RunCallbackRepository
  extends RunEventRepository,
    RunContextRepository,
    RunStateRepository,
    TodoRepository,
    HumanLoopRepository {
  bindRun(runId: string, sessionId: string): Promise<void> | void;
  listTodoItems(input: {
    runId: string;
    limit?: number;
  }): Promise<readonly TodoItemRecord[]>;
  listTodoEvents(input: {
    runId: string;
    limit?: number;
  }): Promise<readonly TodoEventRecord[]>;
}
