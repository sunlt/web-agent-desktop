import { expect, test } from "@playwright/test";

import { buildSseBody, mockPortalApi, type MockApiState } from "./support/mock-portal-api";

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

  test("流式中断后可自动重连并恢复输出", async ({ page }) => {
    const runId = "run-e2e-reconnect-1";
    const now = "2026-02-12T14:35:00.000Z";

    const mockState: MockApiState = {
      runId,
      pendingRequests: [],
      resolvedRequests: [],
      todoItems: [],
      todoEvents: [],
      replyPayloads: [],
      historyChats: [
        {
          chatId: "chat-e2e-reconnect-1",
          sessionId: "chat-e2e-reconnect-1",
          title: "重连会话",
          provider: "codex-cli",
          model: "gpt-5.1-codex",
          createdAt: now,
          updatedAt: now,
          lastMessageAt: null,
        },
      ],
      historyMessages: {
        "chat-e2e-reconnect-1": [],
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
      ]),
      streamReconnectBody: buildSseBody([
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

    await page.getByPlaceholder("输入消息，Enter 发送，Shift+Enter 换行").fill("测试重连");
    await page.getByRole("button", { name: "发送" }).click();

    await expect(page.locator(".bubble-assistant pre").last()).toContainText("你好，世界");
    await expect(page.locator(".timeline-list")).toContainText("stream.reconnecting");
    await expect(page.locator(".timeline-list")).toContainText("stream.reconnected");
    await expect(page.locator(".run-chip")).toContainText("succeeded");
    expect(mockState.streamReconnectCalls).toBeGreaterThan(0);
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
    await expect(page.locator(".resolved-list")).toContainText("q-1");
    await expect(page.locator(".resolved-list")).toContainText("请选择部署环境");
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
