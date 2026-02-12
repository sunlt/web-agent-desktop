import type { Page } from "@playwright/test";

export type PendingRequest = {
  questionId: string;
  runId: string;
  sessionId: string;
  prompt: string;
  metadata: Record<string, unknown>;
  status: "pending" | "resolved";
  requestedAt: string;
  resolvedAt: string | null;
};

export type TodoItem = {
  runId: string;
  todoId: string;
  content: string;
  status: "todo" | "doing" | "done" | "canceled";
  order: number;
  updatedAt: string;
};

export type TodoEvent = {
  eventId: string;
  runId: string;
  todoId: string;
  content: string;
  status: "todo" | "doing" | "done" | "canceled";
  order: number;
  eventTs: string;
};

export type ChatSummary = {
  chatId: string;
  sessionId: string;
  title: string;
  provider: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
};

export type ChatMessage = {
  id: string;
  chatId: string;
  role: "system" | "user" | "assistant";
  content: string;
  createdAt: string;
};

export type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

export type FileReadPayload = {
  path: string;
  content: string;
  contentType: string;
  encoding: "utf8" | "base64";
  size: number;
  nextOffset: number | null;
  truncated: boolean;
};

export type StoreApp = {
  appId: string;
  name: string;
  enabled: boolean;
  canView: boolean;
  canUse: boolean;
};

export type MockApiState = {
  runId: string;
  pendingRequests: PendingRequest[];
  resolvedRequests?: PendingRequest[];
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
  streamReconnectBody?: string;
  streamReconnectCalls?: number;
  replyResultByQuestion?: Record<
    string,
    {
      duplicate?: boolean;
      status?: string;
    }
  >;
};

export async function mockPortalApi(page: Page, state: MockApiState): Promise<void> {
  let chatSequence = state.historyChats.length;
  state.fileEntries ??= [];
  state.fileReadByPath ??= {};
  state.fileWrites ??= [];
  state.storeApps ??= [];
  state.runStartPayloads ??= [];
  state.streamReconnectCalls ??= 0;
  state.replyResultByQuestion ??= {};
  state.resolvedRequests ??= [];

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

    if (path === `/api/runs/${state.runId}/stream` && method === "GET") {
      state.streamReconnectCalls += 1;
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        },
        body: state.streamReconnectBody ?? state.sseBody,
      });
    }

    if (path === `/api/runs/${state.runId}/todos` && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: state.todoItems }),
      });
    }

    if (path === `/api/runs/${state.runId}/todos/events` && method === "GET") {
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

    if (path === "/api/human-loop/requests" && method === "GET") {
      const runId = url.searchParams.get("runId");
      const status = url.searchParams.get("status");
      const requests =
        runId === state.runId && status === "resolved" ? state.resolvedRequests : [];
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
        const resolvedAt = new Date().toISOString();
        const resolvedItem = state.pendingRequests.find(
          (requestItem) => requestItem.questionId === payload.questionId,
        );
        state.pendingRequests = state.pendingRequests.filter(
          (requestItem) => requestItem.questionId !== payload.questionId,
        );
        if (resolvedItem) {
          state.resolvedRequests = [
            {
              ...resolvedItem,
              status: "resolved",
              resolvedAt,
            },
            ...(state.resolvedRequests ?? []),
          ];
        }
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

export function buildSseBody(entries: Array<{ event: string; data: unknown }>): string {
  return entries
    .map((entry) => `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`)
    .join("");
}
