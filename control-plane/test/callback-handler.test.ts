import { describe, expect, test } from "vitest";
import { CallbackHandler } from "../src/services/callback-handler.js";
import { InMemoryRunCallbackRepository } from "../src/repositories/in-memory-run-callback-repository.js";

class FakeSessionSyncService {
  public readonly calls: Array<{
    sessionId: string;
    reason: string;
    now: Date;
    runId?: string;
  }> = [];

  async syncSessionWorkspace(
    sessionId: string,
    reason: "message.stop" | "run.finished" | "pre.stop" | "pre.remove",
    now: Date,
    runId?: string,
  ): Promise<boolean> {
    this.calls.push({ sessionId, reason, now, runId });
    return true;
  }
}

describe("CallbackHandler", () => {
  test("should trigger session sync when message.stop arrives", async () => {
    const repo = new InMemoryRunCallbackRepository();
    const sync = new FakeSessionSyncService();
    repo.bindRun("run-1", "sess-1");

    const handler = new CallbackHandler({
      eventRepo: repo,
      runContextRepo: repo,
      runStateRepo: repo,
      todoRepo: repo,
      humanLoopRepo: repo,
      sessionSyncService: sync,
    });

    const now = new Date("2026-02-11T12:00:00.000Z");

    const result = await handler.handle({
      eventId: "evt-1",
      runId: "run-1",
      type: "message.stop",
      occurredAt: now,
    });

    expect(result).toEqual({
      processed: true,
      duplicate: false,
      action: "message_stop_synced",
    });
    expect(sync.calls).toHaveLength(1);
    expect(sync.calls[0]).toEqual({
      sessionId: "sess-1",
      reason: "message.stop",
      now,
      runId: "run-1",
    });
  });

  test("should ignore duplicated callback event by event_id", async () => {
    const repo = new InMemoryRunCallbackRepository();
    const sync = new FakeSessionSyncService();
    repo.bindRun("run-2", "sess-2");

    const handler = new CallbackHandler({
      eventRepo: repo,
      runContextRepo: repo,
      runStateRepo: repo,
      todoRepo: repo,
      humanLoopRepo: repo,
      sessionSyncService: sync,
    });

    const event = {
      eventId: "evt-dup",
      runId: "run-2",
      type: "message.stop" as const,
      occurredAt: new Date("2026-02-11T12:01:00.000Z"),
    };

    await handler.handle(event);
    const second = await handler.handle(event);

    expect(second).toEqual({
      processed: false,
      duplicate: true,
      action: "duplicate_ignored",
    });
    expect(sync.calls).toHaveLength(1);
  });

  test("should upsert todo and append timeline event", async () => {
    const repo = new InMemoryRunCallbackRepository();
    const handler = new CallbackHandler({
      eventRepo: repo,
      runContextRepo: repo,
      runStateRepo: repo,
      todoRepo: repo,
      humanLoopRepo: repo,
      sessionSyncService: new FakeSessionSyncService(),
    });

    const updatedAt = new Date("2026-02-11T12:02:00.000Z");

    const result = await handler.handle({
      eventId: "evt-todo-1",
      runId: "run-3",
      type: "todo.update",
      occurredAt: updatedAt,
      todo: {
        todoId: "todo-1",
        content: "实现清理任务",
        status: "doing",
        order: 1,
        updatedAt,
      },
    });

    expect(result.action).toBe("todo_upserted");

    const todo = repo.getTodoItem("run-3", "todo-1");
    expect(todo?.status).toBe("doing");
    expect(repo.getTodoEvents("run-3")).toHaveLength(1);
  });

  test("should persist waiting_human request and resolve later", async () => {
    const repo = new InMemoryRunCallbackRepository();
    repo.bindRun("run-5", "sess-5");

    const handler = new CallbackHandler({
      eventRepo: repo,
      runContextRepo: repo,
      runStateRepo: repo,
      todoRepo: repo,
      humanLoopRepo: repo,
      sessionSyncService: new FakeSessionSyncService(),
    });

    const requestedAt = new Date("2026-02-11T12:03:00.000Z");

    const requested = await handler.handle({
      eventId: "evt-hl-1",
      runId: "run-5",
      type: "human_loop.requested",
      occurredAt: requestedAt,
      questionId: "q-1",
      prompt: "请确认是否继续执行",
    });

    expect(requested.action).toBe("human_loop_requested");
    expect(repo.getRunStatus("run-5")).toBe("waiting_human");
    expect(repo.getHumanLoopRequest("q-1")?.status).toBe("pending");

    const resolved = await handler.handle({
      eventId: "evt-hl-2",
      runId: "run-5",
      type: "human_loop.resolved",
      occurredAt: new Date("2026-02-11T12:04:00.000Z"),
      questionId: "q-1",
    });

    expect(resolved.action).toBe("human_loop_resolved");
    expect(repo.getRunStatus("run-5")).toBe("running");
    expect(repo.getHumanLoopRequest("q-1")?.status).toBe("resolved");
  });

  test("should finalize usage only once even if run.finished repeated", async () => {
    const repo = new InMemoryRunCallbackRepository();
    const handler = new CallbackHandler({
      eventRepo: repo,
      runContextRepo: repo,
      runStateRepo: repo,
      todoRepo: repo,
      humanLoopRepo: repo,
      sessionSyncService: new FakeSessionSyncService(),
    });

    const usageA = { inputTokens: 10, outputTokens: 20 };
    const usageB = { inputTokens: 100, outputTokens: 200 };
    const now = new Date("2026-02-11T12:05:00.000Z");

    await handler.handle({
      eventId: "evt-finish-1",
      runId: "run-4",
      type: "run.finished",
      occurredAt: now,
      status: "succeeded",
      usage: usageA,
    });

    await handler.handle({
      eventId: "evt-finish-2",
      runId: "run-4",
      type: "run.finished",
      occurredAt: new Date("2026-02-11T12:06:00.000Z"),
      status: "succeeded",
      usage: usageB,
    });

    expect(repo.getRunStatus("run-4")).toBe("succeeded");
    expect(repo.getUsage("run-4")).toEqual(usageA);
  });
});
