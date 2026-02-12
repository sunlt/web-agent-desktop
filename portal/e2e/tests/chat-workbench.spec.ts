import { expect, test, type Page } from "@playwright/test";

type PendingRequest = {
  questionId: string;
  runId: string;
  sessionId: string;
  prompt: string;
  metadata: Record<string, unknown>;
  status: "pending" | "resolved";
  requestedAt: string;
  resolvedAt: string | null;
};

type TodoItem = {
  runId: string;
  todoId: string;
  content: string;
  status: "todo" | "doing" | "done" | "canceled";
  order: number;
  updatedAt: string;
};

type TodoEvent = {
  eventId: string;
  runId: string;
  todoId: string;
  content: string;
  status: "todo" | "doing" | "done" | "canceled";
  order: number;
  eventTs: string;
};

type ChatSummary = {
  chatId: string;
  sessionId: string;
  title: string;
  provider: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
};

type ChatMessage = {
  id: string;
  chatId: string;
  role: "system" | "user" | "assistant";
  content: string;
  createdAt: string;
};

type MockApiState = {
  runId: string;
  pendingRequests: PendingRequest[];
  todoItems: TodoItem[];
  todoEvents: TodoEvent[];
  replyPayloads: Array<{ runId: string; questionId: string; answer: string }>;
  sseBody: string;
  historyChats: ChatSummary[];
  historyMessages: Record<string, ChatMessage[]>;
};

test.describe("Portal Chat Workbench", () => {
  test("发送消息后可展示流式回复与 Todo 更新", async ({ page }) => {
    const runId = "run-e2e-1";
    const now = "2026-02-12T14:30:00.000Z";

    const mockState: MockApiState = {
      runId,
      pendingRequests: [],
      todoItems: [
        {
          runId,
          todoId: "todo-1",
          content: "实现前端 E2E",
          status: "done",
          order: 1,
          updatedAt: now,
        },
      ],
      todoEvents: [
        {
          eventId: "evt-1",
          runId,
          todoId: "todo-1",
          content: "实现前端 E2E",
          status: "done",
          order: 1,
          eventTs: now,
        },
      ],
      replyPayloads: [],
      historyChats: [
        {
          chatId: "chat-e2e-1",
          sessionId: "chat-e2e-1",
          title: "会话 1",
          provider: "codex-cli",
          model: "gpt-5.1-codex",
          createdAt: now,
          updatedAt: now,
          lastMessageAt: null,
        },
      ],
      historyMessages: {
        "chat-e2e-1": [],
      },
      sseBody: buildSseBody([
        {
          event: "run.status",
          data: {
            type: "run.status",
            runId,
            provider: "codex-cli",
            status: "started",
            ts: now,
          },
        },
        {
          event: "message.delta",
          data: {
            type: "message.delta",
            runId,
            provider: "codex-cli",
            text: "你好，",
            ts: now,
          },
        },
        {
          event: "message.delta",
          data: {
            type: "message.delta",
            runId,
            provider: "codex-cli",
            text: "世界",
            ts: now,
          },
        },
        {
          event: "todo.update",
          data: {
            type: "todo.update",
            runId,
            provider: "codex-cli",
            todo: {
              todoId: "todo-1",
              content: "实现前端 E2E",
              status: "done",
              order: 1,
            },
            ts: now,
          },
        },
        {
          event: "run.status",
          data: {
            type: "run.status",
            runId,
            provider: "codex-cli",
            status: "finished",
            detail: "succeeded",
            ts: now,
          },
        },
        {
          event: "run.closed",
          data: { runId },
        },
      ]),
    };

    await mockPortalApi(page, mockState);

    await page.goto("/");

    const composer = page.getByPlaceholder("输入消息，Enter 发送，Shift+Enter 换行");
    await composer.fill("请帮我输出问候语");
    await page.getByRole("button", { name: "发送" }).click();

    await expect(page.locator(".bubble-user pre").last()).toContainText(
      "请帮我输出问候语",
    );
    await expect(page.locator(".bubble-assistant pre").last()).toContainText(
      "你好，世界",
    );
    await expect(page.locator(".run-chip")).toContainText("succeeded");

    await expect(page.getByText("实现前端 E2E").first()).toBeVisible();
    await expect(page.locator(".todo-events")).toContainText("[done] #1 实现前端 E2E");
  });

  test("human-loop 待回复可提交并刷新为已清空", async ({ page }) => {
    const runId = "run-e2e-2";
    const now = "2026-02-12T14:45:00.000Z";

    const mockState: MockApiState = {
      runId,
      pendingRequests: [
        {
          questionId: "q-1",
          runId,
          sessionId: "sess-1",
          prompt: "请选择部署环境",
          metadata: { choices: ["staging", "prod"] },
          status: "pending",
          requestedAt: now,
          resolvedAt: null,
        },
      ],
      todoItems: [],
      todoEvents: [],
      replyPayloads: [],
      historyChats: [
        {
          chatId: "chat-e2e-2",
          sessionId: "chat-e2e-2",
          title: "会话 2",
          provider: "codex-cli",
          model: "gpt-5.1-codex",
          createdAt: now,
          updatedAt: now,
          lastMessageAt: null,
        },
      ],
      historyMessages: {
        "chat-e2e-2": [],
      },
      sseBody: buildSseBody([
        {
          event: "run.status",
          data: {
            type: "run.status",
            runId,
            provider: "codex-cli",
            status: "started",
            ts: now,
          },
        },
        {
          event: "message.delta",
          data: {
            type: "message.delta",
            runId,
            provider: "codex-cli",
            text: "需要你确认部署环境。",
            ts: now,
          },
        },
        {
          event: "run.status",
          data: {
            type: "run.status",
            runId,
            provider: "codex-cli",
            status: "finished",
            detail: "succeeded",
            ts: now,
          },
        },
        {
          event: "run.closed",
          data: { runId },
        },
      ]),
    };

    await mockPortalApi(page, mockState);

    await page.goto("/");
    await page.getByPlaceholder("输入消息，Enter 发送，Shift+Enter 换行").fill("继续执行");
    await page.getByRole("button", { name: "发送" }).click();

    const pendingCard = page.locator(".pending-card").first();
    await expect(pendingCard).toContainText("q-1");
    await expect(pendingCard).toContainText("请选择部署环境");

    await pendingCard.getByRole("textbox").fill("使用 staging 环境");
    await pendingCard.getByRole("button", { name: "提交回复" }).click();

    await expect(page.getByText("当前无待回复问题")).toBeVisible();
    await expect(page.locator(".timeline-list")).toContainText("human-loop resolved: q-1");

    expect(mockState.replyPayloads).toEqual([
      {
        runId,
        questionId: "q-1",
        answer: "使用 staging 环境",
      },
    ]);
  });
});

async function mockPortalApi(page: Page, state: MockApiState): Promise<void> {
  let chatSequence = state.historyChats.length;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();
    const path = url.pathname;

    if (path === "/api/chat-opencode-history" && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          total: state.historyChats.length,
          chats: state.historyChats,
        }),
      });
    }

    if (path === "/api/chat-opencode-history" && method === "POST") {
      const raw = request.postData() ?? "{}";
      const payload = JSON.parse(raw) as {
        chatId?: string;
        sessionId?: string;
        title?: string;
        provider?: string;
        model?: string;
      };
      chatSequence += 1;
      const chatId = payload.chatId ?? `chat-generated-${chatSequence}`;
      const now = new Date().toISOString();
      const chat: ChatSummary = {
        chatId,
        sessionId: payload.sessionId ?? chatId,
        title: payload.title ?? "新会话",
        provider: payload.provider ?? "codex-cli",
        model: payload.model ?? "gpt-5.1-codex",
        createdAt: now,
        updatedAt: now,
        lastMessageAt: null,
      };
      state.historyChats = [chat, ...state.historyChats];
      state.historyMessages[chatId] = [];
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ chat }),
      });
    }

    if (path.startsWith("/api/chat-opencode-history/")) {
      const chatId = decodeURIComponent(
        path.replace("/api/chat-opencode-history/", ""),
      );
      const chat = state.historyChats.find((item) => item.chatId === chatId);
      if (!chat) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "chat session not found" }),
        });
      }

      if (method === "GET") {
        const messages = state.historyMessages[chatId] ?? [];
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            chat,
            total: messages.length,
            messages,
          }),
        });
      }

      if (method === "PUT") {
        const raw = request.postData() ?? "{}";
        const payload = JSON.parse(raw) as {
          title?: string;
          provider?: string;
          model?: string;
          messages: Array<{
            role: "system" | "user" | "assistant";
            content: string;
            createdAt?: string;
          }>;
        };
        const now = new Date().toISOString();
        const messages = payload.messages.map((item, index) => ({
          id: `${chatId}:${index + 1}`,
          chatId,
          role: item.role,
          content: item.content,
          createdAt: item.createdAt ?? now,
        }));
        state.historyMessages[chatId] = messages;

        const updatedChat: ChatSummary = {
          ...chat,
          title: payload.title ?? chat.title,
          provider: payload.provider ?? chat.provider,
          model: payload.model ?? chat.model,
          updatedAt: now,
          lastMessageAt: messages.at(-1)?.createdAt ?? null,
        };
        state.historyChats = [
          updatedChat,
          ...state.historyChats.filter((item) => item.chatId !== chatId),
        ];

        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            chat: updatedChat,
            total: messages.length,
            messages,
          }),
        });
      }
    }

    if (path === "/api/runs/start" && method === "POST") {
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        },
        body: state.sseBody,
      });
    }

    if (
      path === `/api/runs/${state.runId}/todos` &&
      method === "GET"
    ) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: state.todoItems }),
      });
    }

    if (
      path === `/api/runs/${state.runId}/todos/events` &&
      method === "GET"
    ) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ events: state.todoEvents }),
      });
    }

    if (path === "/api/human-loop/pending" && method === "GET") {
      const runId = url.searchParams.get("runId");
      const requests = runId === state.runId ? state.pendingRequests : [];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ requests }),
      });
    }

    if (path === "/api/human-loop/reply" && method === "POST") {
      const raw = request.postData() ?? "{}";
      const payload = JSON.parse(raw) as {
        runId: string;
        questionId: string;
        answer: string;
      };
      state.replyPayloads.push(payload);
      state.pendingRequests = state.pendingRequests.filter(
        (requestItem) => requestItem.questionId !== payload.questionId,
      );

      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, status: "resolved", duplicate: false }),
      });
    }

    if (path === `/api/runs/${state.runId}/stop` && method === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }

    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: `Unhandled mock route: ${method} ${path}` }),
    });
  });
}

function buildSseBody(entries: Array<{ event: string; data: unknown }>): string {
  return entries
    .map((entry) => `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`)
    .join("");
}
