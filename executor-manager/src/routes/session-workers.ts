import { Router } from "express";
import { z } from "zod";
import type { LifecycleManager } from "../services/lifecycle-manager.js";

const activateSchema = z.object({
  appId: z.string().min(1),
  projectName: z.string().optional(),
  userLoginName: z.string().min(1),
  runtimeVersion: z.string().optional(),
  manifest: z
    .object({
      appId: z.string().min(1),
      runtimeVersion: z.string().min(1),
      workspaceTemplatePrefix: z.string().min(1),
      requiredPaths: z.array(z.string().min(1)).default([]),
      seedFiles: z
        .array(
          z.object({
            from: z.string().min(1),
            to: z.string().min(1),
            ifMissingOnly: z.boolean(),
          }),
        )
        .default([]),
      mountPoints: z
        .array(
          z.object({
            name: z.enum(["app_kb", "project_kb", "user_files", "agent_data"]),
            targetPath: z.string().min(1),
            readOnly: z.boolean(),
          }),
        )
        .default([]),
      conflictPolicy: z
        .enum(["keep_session", "prefer_registry", "merge"])
        .optional(),
      protectedPaths: z.array(z.string().min(1)).optional(),
      cleanupRules: z
        .array(
          z.object({
            action: z.enum(["remove_if_exists", "truncate_if_exists"]),
            path: z.string().min(1),
          }),
        )
        .default([]),
    })
    .optional(),
});

const cleanupIdleSchema = z.object({
  idleTimeoutMs: z.number().int().positive().default(15 * 60 * 1000),
  limit: z.number().int().positive().max(200).default(20),
});

const cleanupStoppedSchema = z.object({
  removeAfterMs: z.number().int().positive().default(24 * 60 * 60 * 1000),
  limit: z.number().int().positive().max(200).default(20),
});

const syncSessionSchema = z.object({
  reason: z.enum(["message.stop", "run.finished", "pre.stop", "pre.remove"]),
  runId: z.string().min(1).optional(),
});

export function createSessionWorkersRouter(
  lifecycleManager: LifecycleManager,
): Router {
  const router = Router();

  router.post("/session-workers/:sessionId/activate", async (req, res) => {
    const payload = activateSchema.safeParse(req.body);
    if (!payload.success) {
      return res.status(400).json({ error: payload.error.flatten() });
    }

    const result = await lifecycleManager.activateSession({
      ...payload.data,
      sessionId: req.params.sessionId,
    });

    return res.json(result);
  });

  router.get("/session-workers/:sessionId", async (req, res) => {
    const worker = await lifecycleManager.getSessionWorker(req.params.sessionId);
    if (!worker) {
      return res.status(404).json({ error: "session worker not found" });
    }
    return res.json(worker);
  });

  router.post("/session-workers/:sessionId/sync", async (req, res) => {
    const payload = syncSessionSchema.safeParse(req.body ?? {});
    if (!payload.success) {
      return res.status(400).json({ error: payload.error.flatten() });
    }

    const synced = await lifecycleManager.syncSessionWorkspace(
      req.params.sessionId,
      payload.data.reason,
      new Date(),
      payload.data.runId,
    );

    return res.json({ synced });
  });

  router.post("/session-workers/cleanup/idle", async (req, res) => {
    const payload = cleanupIdleSchema.safeParse(req.body);
    if (!payload.success) {
      return res.status(400).json({ error: payload.error.flatten() });
    }

    const result = await lifecycleManager.stopIdleWorkers({
      ...payload.data,
      now: new Date(),
    });

    return res.json(result);
  });

  router.post("/session-workers/cleanup/stopped", async (req, res) => {
    const payload = cleanupStoppedSchema.safeParse(req.body);
    if (!payload.success) {
      return res.status(400).json({ error: payload.error.flatten() });
    }

    const result = await lifecycleManager.removeLongStoppedWorkers({
      ...payload.data,
      now: new Date(),
    });

    return res.json(result);
  });

  return router;
}
