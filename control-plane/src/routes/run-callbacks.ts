import { Router } from "express";
import { z } from "zod";
import type { RunCallbackRepository } from "../repositories/run-callback-repository.js";
import type { CallbackHandler } from "../services/callback-handler.js";
import type { RunOrchestrator } from "../services/run-orchestrator.js";

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

const listPendingSchema = z.object({
  runId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const replySchema = z.object({
  runId: z.string().min(1),
  questionId: z.string().min(1),
  answer: z.string().min(1),
});

export function createRunCallbacksRouter(input: {
  callbackHandler: CallbackHandler;
  callbackRepo: RunCallbackRepository;
  runOrchestrator: RunOrchestrator;
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

  router.get("/human-loop/pending", async (req, res) => {
    const parsed = listPendingSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const requests = await input.callbackRepo.listPendingRequests({
      runId: parsed.data.runId,
      limit: parsed.data.limit,
    });

    return res.json({
      total: requests.length,
      requests,
    });
  });

  router.post("/human-loop/reply", async (req, res) => {
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const request = await input.callbackRepo.findRequest(parsed.data.questionId);
    if (!request || request.runId !== parsed.data.runId) {
      return res.status(404).json({ error: "human-loop request not found" });
    }

    if (request.status !== "pending") {
      return res.json({
        ok: true,
        duplicate: true,
        status: request.status,
      });
    }

    const replied = await input.runOrchestrator.replyHumanLoop({
      runId: parsed.data.runId,
      questionId: parsed.data.questionId,
      answer: parsed.data.answer,
    });

    if (!replied.accepted) {
      return res.status(409).json({
        ok: false,
        reason: replied.reason,
      });
    }

    const now = new Date();
    await input.callbackRepo.saveResponse({
      questionId: parsed.data.questionId,
      runId: parsed.data.runId,
      answer: parsed.data.answer,
      createdAt: now,
    });
    await input.callbackRepo.markResolved({
      questionId: parsed.data.questionId,
      runId: parsed.data.runId,
      resolvedAt: now,
    });
    await input.callbackRepo.updateRunStatus({
      runId: parsed.data.runId,
      status: "running",
      updatedAt: now,
    });

    return res.json({
      ok: true,
      status: "resolved",
    });
  });

  return router;
}
