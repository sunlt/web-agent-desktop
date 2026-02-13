import { Router } from "express";
import { z } from "zod";
import type { ChatHistoryRepository } from "../repositories/chat-history-repository.js";

const listHistorySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  userId: z.string().min(1).optional(),
});

const createSessionSchema = z
  .object({
    chatId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    userId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict()
  .default({});

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
  createdAt: z.coerce.date().optional(),
});

const replaceMessagesSchema = z
  .object({
    title: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    messages: z.array(messageSchema),
  })
  .strict();

export function createChatHistoryRouter(
  historyRepo: ChatHistoryRepository,
): Router {
  const router = Router();

  router.get("/chat-opencode-history", async (req, res) => {
    const parsed = listHistorySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const chats = await historyRepo.listSessions({
      limit: parsed.data.limit,
      userId: parsed.data.userId ?? resolveUserId(req),
    });

    return res.json({
      total: chats.length,
      chats,
    });
  });

  router.post("/chat-opencode-history", async (req, res) => {
    const parsed = createSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const chat = await historyRepo.createSession({
      ...parsed.data,
      userId: parsed.data.userId ?? resolveUserId(req),
    });
    return res.status(201).json({ chat });
  });

  router.get("/chat-opencode-history/:chatId", async (req, res) => {
    const userId = resolveUserId(req);
    const chat = await historyRepo.findSession(req.params.chatId, userId);
    if (!chat) {
      return res.status(404).json({ error: "chat session not found" });
    }

    const messages = await historyRepo.listMessages({
      chatId: req.params.chatId,
      userId,
    });

    return res.json({
      chat,
      total: messages.length,
      messages,
    });
  });

  router.put("/chat-opencode-history/:chatId", async (req, res) => {
    const parsed = replaceMessagesSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const userId = resolveUserId(req);
    const existing = await historyRepo.findSession(req.params.chatId, userId);
    if (!existing) {
      return res.status(404).json({ error: "chat session not found" });
    }

    await historyRepo.replaceMessages({
      chatId: req.params.chatId,
      userId,
      title: parsed.data.title,
      provider: parsed.data.provider,
      model: parsed.data.model,
      updatedAt: new Date(),
      messages: parsed.data.messages,
    });

    const chat = await historyRepo.findSession(req.params.chatId, userId);
    const messages = await historyRepo.listMessages({
      chatId: req.params.chatId,
      userId,
    });

    return res.json({
      ok: true,
      chat,
      total: messages.length,
      messages,
    });
  });

  return router;
}

function resolveUserId(req: {
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}): string {
  const fromQuery =
    typeof req.query?.userId === "string" ? req.query.userId : undefined;
  const fromHeader =
    typeof req.headers?.["x-user-id"] === "string"
      ? req.headers["x-user-id"]
      : undefined;
  const value = fromQuery ?? fromHeader;
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "u-anon";
}
