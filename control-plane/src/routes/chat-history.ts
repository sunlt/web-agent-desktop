import { Router } from "express";
import { z } from "zod";
import type { ChatHistoryRepository } from "../repositories/chat-history-repository.js";

const listHistorySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const createSessionSchema = z
  .object({
    chatId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
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

    const chat = await historyRepo.createSession(parsed.data);
    return res.status(201).json({ chat });
  });

  router.get("/chat-opencode-history/:chatId", async (req, res) => {
    const chat = await historyRepo.findSession(req.params.chatId);
    if (!chat) {
      return res.status(404).json({ error: "chat session not found" });
    }

    const messages = await historyRepo.listMessages({
      chatId: req.params.chatId,
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

    const existing = await historyRepo.findSession(req.params.chatId);
    if (!existing) {
      return res.status(404).json({ error: "chat session not found" });
    }

    await historyRepo.replaceMessages({
      chatId: req.params.chatId,
      title: parsed.data.title,
      provider: parsed.data.provider,
      model: parsed.data.model,
      updatedAt: new Date(),
      messages: parsed.data.messages,
    });

    const chat = await historyRepo.findSession(req.params.chatId);
    const messages = await historyRepo.listMessages({
      chatId: req.params.chatId,
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
