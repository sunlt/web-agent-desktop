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

type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

type FileReadPayload = {
  path: string;
  content: string;
  contentType: string;
  encoding: "utf8" | "base64";
  size: number;
  nextOffset: number | null;
  truncated: boolean;
};

type StoreApp = {
  appId: string;
  name: string;
  enabled: boolean;
  canView: boolean;
  canUse: boolean;
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
  fileTreePath?: string;
  fileEntries?: FileEntry[];
  fileReadByPath?: Record<string, FileReadPayload>;
  fileWrites?: Array<{ path: string; content: string }>;
  storeApps?: StoreApp[];
  runStartPayloads?: Array<Record<string, unknown>>;
  replyResultByQuestion?: Record<
    string,
    {
      duplicate?: boolean;
      status?: string;
    }
  >;
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

  test("应用商店选择可联动 runs/start 参数", async ({ page }) => {
    const runId = "run-e2e-store-1";
    const now = "2026-02-12T14:40:00.000Z";

    const mockState: MockApiState = {
      runId,
      pendingRequests: [],
      todoItems: [],
      todoEvents: [],
      replyPayloads: [],
      historyChats: [
        {
          chatId: "chat-e2e-store-1",
          sessionId: "chat-e2e-store-1",
          title: "商店会话",
          provider: "codex-cli",
          model: "gpt-5.1-codex",
          createdAt: now,
          updatedAt: now,
          lastMessageAt: null,
        },
      ],
      historyMessages: {
        "chat-e2e-store-1": [],
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
            text: "ok",
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
      storeApps: [
        {
          appId: "app-alpha",
          name: "Alpha App",
          enabled: true,
          canView: true,
          canUse: true,
        },
        {
          appId: "app-beta",
          name: "Beta App",
          enabled: true,
          canView: true,
          canUse: true,
        },
      ],
      runStartPayloads: [],
    };

    await mockPortalApi(page, mockState);
    await page.goto("/");

    const storePanel = page.locator(".panel").filter({ hasText: "应用商店" });
    await expect(storePanel.getByText("Alpha App")).toBeVisible();
    await storePanel.getByRole("button", { name: /Beta App/ }).click();

    await page.getByPlaceholder("输入消息，Enter 发送，Shift+Enter 换行").fill("运行应用任务");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.locator(".run-chip")).toContainText("succeeded");

    expect(mockState.runStartPayloads).toHaveLength(1);
    const payload = mockState.runStartPayloads[0] as {
      executionProfile?: string;
      providerOptions?: { storeAppId?: string };
    };
    expect(payload.executionProfile).toBe("app-beta");
    expect(payload.providerOptions?.storeAppId).toBe("app-beta");
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
          requestedAt: "2026-02-10T10:00:00.000Z",
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
    await expect(pendingCard).toContainText("仅提示，不自动完成");

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

  test("human-loop 重复回复显示幂等提示且不自动完成", async ({ page }) => {
    const runId = "run-e2e-dup-1";
    const now = "2026-02-12T14:50:00.000Z";

    const mockState: MockApiState = {
      runId,
      pendingRequests: [
        {
          questionId: "q-dup",
          runId,
          sessionId: "sess-dup",
          prompt: "请确认参数",
          metadata: {},
          status: "pending",
          requestedAt: "2026-02-10T10:00:00.000Z",
          resolvedAt: null,
        },
      ],
      todoItems: [],
      todoEvents: [],
      replyPayloads: [],
      historyChats: [
        {
          chatId: "chat-e2e-dup-1",
          sessionId: "chat-e2e-dup-1",
          title: "会话 dup",
          provider: "codex-cli",
          model: "gpt-5.1-codex",
          createdAt: now,
          updatedAt: now,
          lastMessageAt: null,
        },
      ],
      historyMessages: {
        "chat-e2e-dup-1": [],
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
            text: "需要确认参数。",
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
      replyResultByQuestion: {
        "q-dup": {
          duplicate: true,
          status: "resolved",
        },
      },
    };

    await mockPortalApi(page, mockState);
    await page.goto("/");
    await page.getByPlaceholder("输入消息，Enter 发送，Shift+Enter 换行").fill("继续执行");
    await page.getByRole("button", { name: "发送" }).click();

    const pendingCard = page.locator(".pending-card").first();
    await pendingCard.getByRole("textbox").fill("参数确认");
    await pendingCard.getByRole("button", { name: "提交回复" }).click();

    await expect(pendingCard).toContainText("该问题已处理（幂等返回）");
    await expect(pendingCard).toContainText("请确认参数");
  });

  test("Files 面板支持读取与保存文本文件", async ({ page }) => {
    const runId = "run-e2e-file-1";
    const now = "2026-02-12T15:00:00.000Z";

    const mockState: MockApiState = {
      runId,
      pendingRequests: [],
      todoItems: [],
      todoEvents: [],
      replyPayloads: [],
      historyChats: [
        {
          chatId: "chat-e2e-file-1",
          sessionId: "chat-e2e-file-1",
          title: "文件会话",
          provider: "codex-cli",
          model: "gpt-5.1-codex",
          createdAt: now,
          updatedAt: now,
          lastMessageAt: null,
        },
      ],
      historyMessages: {
        "chat-e2e-file-1": [],
      },
      sseBody: "",
      fileTreePath: "/workspace/public",
      fileEntries: [
        {
          name: "readme.txt",
          path: "/workspace/public/readme.txt",
          isDirectory: false,
          size: 12,
        },
      ],
      fileReadByPath: {
        "/workspace/public/readme.txt": {
          path: "/workspace/public/readme.txt",
          content: "hello file",
          contentType: "text/plain; charset=utf-8",
          encoding: "utf8",
          size: 12,
          nextOffset: null,
          truncated: false,
        },
      },
      fileWrites: [],
    };

    await mockPortalApi(page, mockState);
    await page.goto("/");

    const filesPanel = page.locator(".panel").filter({ hasText: "Files" });
    await filesPanel.getByRole("button", { name: "刷新" }).click();
    await filesPanel.getByRole("button", { name: /readme.txt/i }).click();

    const preview = page.locator(".panel").filter({ hasText: "Preview" });
    const editor = preview.locator(".file-editor");
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue("hello file");

    await editor.fill("hello updated file");
    await preview.getByRole("button", { name: "保存" }).click();

    expect(mockState.fileWrites).toEqual([
      {
        path: "/workspace/public/readme.txt",
        content: "hello updated file",
      },
    ]);
    await expect(editor).toHaveValue("hello updated file");
  });
});

async function mockPortalApi(page: Page, state: MockApiState): Promise<void> {
  let chatSequence = state.historyChats.length;
  state.fileEntries ??= [];
  state.fileReadByPath ??= {};
  state.fileWrites ??= [];
  state.storeApps ??= [];
  state.runStartPayloads ??= [];
  state.replyResultByQuestion ??= {};

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

    if (path === "/api/apps/store" && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          total: state.storeApps.length,
          apps: state.storeApps,
        }),
      });
    }

    if (path === "/api/files/tree" && method === "GET") {
      const targetPath = url.searchParams.get("path") ?? state.fileTreePath ?? "/";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          path: targetPath,
          entries: state.fileEntries,
        }),
      });
    }

    if (path === "/api/files/file" && method === "GET") {
      const filePath = url.searchParams.get("path");
      const filePayload = filePath ? state.fileReadByPath[filePath] : undefined;
      if (!filePayload || !filePath) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "file not found" }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...filePayload,
          fileName: filePath.split("/").at(-1) ?? "unknown",
          offset: 0,
          limit: filePayload.size,
          readBytes: filePayload.size,
        }),
      });
    }

    if (path === "/api/files/file" && method === "PUT") {
      const raw = request.postData() ?? "{}";
      const payload = JSON.parse(raw) as {
        path: string;
        content: string;
      };
      state.fileWrites.push({
        path: payload.path,
        content: payload.content,
      });
      state.fileReadByPath[payload.path] = {
        path: payload.path,
        content: payload.content,
        contentType: "text/plain; charset=utf-8",
        encoding: "utf8",
        size: payload.content.length,
        nextOffset: null,
        truncated: false,
      };
      if (!state.fileEntries.some((entry) => entry.path === payload.path)) {
        state.fileEntries.push({
          name: payload.path.split("/").at(-1) ?? payload.path,
          path: payload.path,
          isDirectory: false,
          size: payload.content.length,
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          path: payload.path,
          size: payload.content.length,
        }),
      });
    }

    if (path === "/api/files/upload" && method === "POST") {
      const raw = request.postData() ?? "{}";
      const payload = JSON.parse(raw) as {
        path: string;
        contentBase64: string;
      };
      const decoded = Buffer.from(payload.contentBase64, "base64").toString("utf8");
      state.fileReadByPath[payload.path] = {
        path: payload.path,
        content: decoded,
        contentType: "application/octet-stream",
        encoding: "base64",
        size: decoded.length,
        nextOffset: null,
        truncated: false,
      };
      if (!state.fileEntries.some((entry) => entry.path === payload.path)) {
        state.fileEntries.push({
          name: payload.path.split("/").at(-1) ?? payload.path,
          path: payload.path,
          isDirectory: false,
          size: decoded.length,
        });
      }
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, path: payload.path }),
      });
    }

    if (path === "/api/files/rename" && method === "POST") {
      const raw = request.postData() ?? "{}";
      const payload = JSON.parse(raw) as {
        path: string;
        newPath: string;
      };
      const filePayload = state.fileReadByPath[payload.path];
      if (filePayload) {
        state.fileReadByPath[payload.newPath] = {
          ...filePayload,
          path: payload.newPath,
        };
        delete state.fileReadByPath[payload.path];
      }
      state.fileEntries = state.fileEntries.map((entry) =>
        entry.path === payload.path
          ? {
              ...entry,
              path: payload.newPath,
              name: payload.newPath.split("/").at(-1) ?? payload.newPath,
            }
          : entry,
      );
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, path: payload.path, newPath: payload.newPath }),
      });
    }

    if (path === "/api/files/file" && method === "DELETE") {
      const filePath = url.searchParams.get("path") ?? "";
      delete state.fileReadByPath[filePath];
      state.fileEntries = state.fileEntries.filter((entry) => entry.path !== filePath);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, path: filePath, deleted: true }),
      });
    }

    if (path === "/api/files/mkdir" && method === "POST") {
      const raw = request.postData() ?? "{}";
      const payload = JSON.parse(raw) as {
        path: string;
      };
      if (!state.fileEntries.some((entry) => entry.path === payload.path)) {
        state.fileEntries.push({
          name: payload.path.split("/").at(-1) ?? payload.path,
          path: payload.path,
          isDirectory: true,
          size: 0,
        });
      }
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, path: payload.path }),
      });
    }

    if (path === "/api/files/download" && method === "GET") {
      const filePath = url.searchParams.get("path");
      const filePayload = filePath ? state.fileReadByPath[filePath] : undefined;
      if (!filePath || !filePayload) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "file not found" }),
        });
      }
      if (filePayload.encoding === "base64") {
        return route.fulfill({
          status: 200,
          headers: {
            "content-type": filePayload.contentType,
          },
          body: Buffer.from(filePayload.content, "utf8"),
        });
      }
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": filePayload.contentType,
        },
        body: filePayload.content,
      });
    }

    if (path === "/api/runs/start" && method === "POST") {
      const raw = request.postData() ?? "{}";
      try {
        state.runStartPayloads.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        state.runStartPayloads.push({ raw });
      }
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
      const replyPreset = state.replyResultByQuestion[payload.questionId] ?? null;
      state.replyPayloads.push(payload);
      if (!replyPreset?.duplicate) {
        state.pendingRequests = state.pendingRequests.filter(
          (requestItem) => requestItem.questionId !== payload.questionId,
        );
      }

      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          status: replyPreset?.status ?? "resolved",
          duplicate: replyPreset?.duplicate ?? false,
        }),
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
