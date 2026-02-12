import { describe, expect, test } from "vitest";
import { createControlPlaneApp } from "../../src/app.js";
import { withHttpServer } from "./http-test-utils.js";

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

describe("Chat History API E2E", () => {
  test("should create/list/load/persist chat history", async () => {
    const app = createControlPlaneApp();

    await withHttpServer(app, async (baseUrl) => {
      const createRes = await fetch(`${baseUrl}/api/chat-opencode-history`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "历史会话一",
          provider: "codex-cli",
          model: "gpt-5.1-codex",
        }),
      });
      expect(createRes.status).toBe(201);

      const created = (await createRes.json()) as {
        chat: ChatSummary;
      };
      expect(created.chat.chatId.length).toBeGreaterThan(0);
      expect(created.chat.sessionId).toBe(created.chat.chatId);
      expect(created.chat.title).toBe("历史会话一");

      const putRes = await fetch(
        `${baseUrl}/api/chat-opencode-history/${encodeURIComponent(created.chat.chatId)}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: "历史会话一（已更新）",
            provider: "codex-cli",
            model: "gpt-5.1-codex",
            messages: [
              {
                role: "user",
                content: "你好",
                createdAt: "2026-02-12T15:00:00.000Z",
              },
              {
                role: "assistant",
                content: "你好，我在。",
                createdAt: "2026-02-12T15:00:01.000Z",
              },
            ],
          }),
        },
      );
      expect(putRes.status).toBe(200);
      const updated = (await putRes.json()) as {
        ok: boolean;
        chat: ChatSummary;
        total: number;
        messages: ChatMessage[];
      };
      expect(updated.ok).toBe(true);
      expect(updated.chat.title).toBe("历史会话一（已更新）");
      expect(updated.total).toBe(2);
      expect(updated.messages.map((item) => item.content)).toEqual([
        "你好",
        "你好，我在。",
      ]);

      const listRes = await fetch(`${baseUrl}/api/chat-opencode-history`);
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        total: number;
        chats: ChatSummary[];
      };
      expect(listBody.total).toBeGreaterThanOrEqual(1);
      expect(listBody.chats[0]?.chatId).toBe(created.chat.chatId);
      expect(listBody.chats[0]?.lastMessageAt).toBe("2026-02-12T15:00:01.000Z");

      const detailRes = await fetch(
        `${baseUrl}/api/chat-opencode-history/${encodeURIComponent(created.chat.chatId)}`,
      );
      expect(detailRes.status).toBe(200);
      const detailBody = (await detailRes.json()) as {
        chat: ChatSummary;
        total: number;
        messages: ChatMessage[];
      };
      expect(detailBody.chat.chatId).toBe(created.chat.chatId);
      expect(detailBody.total).toBe(2);
      expect(detailBody.messages[0]?.role).toBe("user");
      expect(detailBody.messages[1]?.role).toBe("assistant");
    });
  });
});
