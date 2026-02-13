import { Router } from "express";
import { z } from "zod";
import type { RunQueueManager } from "../services/run-queue-manager.js";

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1),
});

const enqueueSchema = z.object({
  runId: z.string().optional(),
  sessionId: z.string().min(1),
  provider: z.enum(["claude-code", "opencode", "codex-cli", "codex-app-server"]),
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  resumeSessionId: z.string().optional(),
  executionProfile: z.string().optional(),
  tools: z.record(z.string(), z.unknown()).optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  requireHumanLoop: z.boolean().optional(),
  maxAttempts: z.number().int().positive().max(20).optional(),
});

const drainSchema = z.object({
  owner: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
  lockMs: z.number().int().positive().max(120_000).optional(),
  retryDelayMs: z.number().int().nonnegative().max(300_000).optional(),
});

export function createRunQueueRouter(queueManager: RunQueueManager): Router {
  const router = Router();

  router.post("/runs/queue/enqueue", async (req, res) => {
    const parsed = enqueueSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const result = await queueManager.enqueueRun(parsed.data);
    if (!result.accepted) {
      return res.status(409).json(result);
    }
    return res.status(202).json(result);
  });

  router.post("/runs/queue/drain", async (req, res) => {
    const parsed = drainSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const result = await queueManager.drainOnce(parsed.data);
    return res.json(result);
  });

  router.get("/runs/queue/:runId", async (req, res) => {
    const item = await queueManager.getQueueItem(req.params.runId);
    if (!item) {
      return res.status(404).json({ error: "run queue item not found" });
    }
    return res.json(item);
  });

  return router;
}
