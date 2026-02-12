import { Router } from "express";
import { z } from "zod";
import type { RunCallbackRepository } from "../repositories/run-callback-repository.js";
import type { CallbackHandler } from "../services/callback-handler.js";

const bindRunSchema = z.object({
  sessionId: z.string().min(1),
});

const baseSchema = z.object({
  eventId: z.string().min(1),
  occurredAt: z.coerce.date().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const messageStopSchema = baseSchema.extend({
  type: z.literal("message.stop"),
});

const todoSchema = baseSchema.extend({
  type: z.literal("todo.update"),
  todo: z.object({
    todoId: z.string().min(1),
    content: z.string().min(1),
    status: z.enum(["todo", "doing", "done", "canceled"]),
    order: z.number().int().nonnegative(),
    updatedAt: z.coerce.date(),
  }),
});

const humanLoopRequestedSchema = baseSchema.extend({
  type: z.literal("human_loop.requested"),
  questionId: z.string().min(1),
  prompt: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const humanLoopResolvedSchema = baseSchema.extend({
  type: z.literal("human_loop.resolved"),
  questionId: z.string().min(1),
});

const runFinishedSchema = baseSchema.extend({
  type: z.literal("run.finished"),
  status: z.enum(["succeeded", "failed", "canceled"]),
  usage: z.record(z.string(), z.unknown()).optional(),
});

const callbackSchema = z.discriminatedUnion("type", [
  messageStopSchema,
  todoSchema,
  humanLoopRequestedSchema,
  humanLoopResolvedSchema,
  runFinishedSchema,
]);

export function createRunCallbacksRouter(input: {
  callbackHandler: CallbackHandler;
  callbackRepo: RunCallbackRepository;
}): Router {
  const router = Router();

  router.post("/runs/:runId/bind", async (req, res) => {
    const parsed = bindRunSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    await input.callbackRepo.bindRun(req.params.runId, parsed.data.sessionId);
    return res.json({ ok: true });
  });

  router.post("/runs/:runId/callbacks", async (req, res) => {
    const parsed = callbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const occurredAt = parsed.data.occurredAt ?? new Date();
    const event = {
      ...parsed.data,
      runId: req.params.runId,
      occurredAt,
    };

    const result = await input.callbackHandler.handle(event);
    return res.json(result);
  });

  return router;
}
