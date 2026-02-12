import { describe, expect, test } from "vitest";
import { createControlPlaneApp } from "../../src/app.js";
import { InMemoryRunCallbackRepository } from "../../src/repositories/in-memory-run-callback-repository.js";
import { withHttpServer } from "./http-test-utils.js";

describe("Todo Stream E2E", () => {
  test("should persist latest todo status and full timeline for replay", async () => {
    const callbackRepository = new InMemoryRunCallbackRepository();
    const app = createControlPlaneApp({
      callbackRepository,
      providerAdapters: [],
    });

    await withHttpServer(app, async (baseUrl) => {
      const bindResponse = await fetch(`${baseUrl}/api/runs/run-todo-e2e/bind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "sess-todo-e2e" }),
      });
      expect(bindResponse.status).toBe(200);

      const doingAt = "2026-02-12T14:00:00.000Z";
      const doing = await fetch(`${baseUrl}/api/runs/run-todo-e2e/callbacks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: "evt-todo-doing",
          type: "todo.update",
          todo: {
            todoId: "todo-1",
            content: "编译项目",
            status: "doing",
            order: 1,
            updatedAt: doingAt,
          },
        }),
      });
      expect(doing.status).toBe(200);
      expect(await doing.json()).toMatchObject({
        action: "todo_upserted",
      });

      const doneAt = "2026-02-12T14:01:00.000Z";
      const done = await fetch(`${baseUrl}/api/runs/run-todo-e2e/callbacks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: "evt-todo-done",
          type: "todo.update",
          todo: {
            todoId: "todo-1",
            content: "编译项目",
            status: "done",
            order: 1,
            updatedAt: doneAt,
          },
        }),
      });
      expect(done.status).toBe(200);
      expect(await done.json()).toMatchObject({
        action: "todo_upserted",
      });

      const todoList = await fetch(`${baseUrl}/api/runs/run-todo-e2e/todos`);
      expect(todoList.status).toBe(200);
      const todoListBody = (await todoList.json()) as {
        runId: string;
        total: number;
        items: Array<{ todoId: string; status: string; order: number }>;
      };
      expect(todoListBody).toMatchObject({
        runId: "run-todo-e2e",
        total: 1,
      });
      expect(todoListBody.items[0]).toMatchObject({
        todoId: "todo-1",
        status: "done",
        order: 1,
      });

      const todoEvents = await fetch(
        `${baseUrl}/api/runs/run-todo-e2e/todos/events`,
      );
      expect(todoEvents.status).toBe(200);
      const todoEventsBody = (await todoEvents.json()) as {
        runId: string;
        total: number;
        events: Array<{ eventId: string; todoId: string; status: string }>;
      };
      expect(todoEventsBody).toMatchObject({
        runId: "run-todo-e2e",
        total: 2,
      });
      expect(todoEventsBody.events.map((item) => item.eventId)).toEqual([
        "evt-todo-doing",
        "evt-todo-done",
      ]);
    });

    const latest = callbackRepository.getTodoItem("run-todo-e2e", "todo-1");
    expect(latest?.status).toBe("done");
    expect(latest?.content).toBe("编译项目");

    const timeline = callbackRepository.getTodoEvents("run-todo-e2e");
    expect(timeline).toHaveLength(2);
    expect(timeline.map((item) => item.status)).toEqual(["doing", "done"]);
    expect(timeline.map((item) => item.todoId)).toEqual(["todo-1", "todo-1"]);
  });
});
