import { type Response, Router } from "express";
import { z } from "zod";
import {
  SessionWorkerNotFoundError,
  type LifecycleManager,
} from "../services/lifecycle-manager.js";

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

const workspaceTreeSchema = z.object({
  path: z.string().optional(),
});

const workspaceReadSchema = z.object({
  path: z.string().min(1),
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(1024 * 1024).optional(),
});

const workspaceWriteSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).optional(),
  })
  .strict();

const workspaceUploadSchema = z
  .object({
    path: z.string().min(1),
    contentBase64: z.string(),
  })
  .strict();

const workspaceRenameSchema = z
  .object({
    path: z.string().min(1),
    newPath: z.string().min(1),
  })
  .strict();

const workspaceDeleteSchema = z.object({
  path: z.string().min(1),
});

const workspaceMkdirSchema = z
  .object({
    path: z.string().min(1),
  })
  .strict();

const workspaceDownloadSchema = z.object({
  path: z.string().min(1),
  inline: z.string().optional(),
});

const ttyExecSchema = z
  .object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
    maxOutputBytes: z.number().int().positive().max(2 * 1024 * 1024).optional(),
  })
  .strict();

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

  router.get("/session-workers/:sessionId/workspace/tree", async (req, res) => {
    const payload = workspaceTreeSchema.safeParse(req.query);
    if (!payload.success) {
      return res.status(400).json({ error: payload.error.flatten() });
    }

    try {
      const result = await lifecycleManager.listWorkspaceTree(
        req.params.sessionId,
        payload.data.path ?? "/workspace",
      );
      return res.json(result);
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.get("/session-workers/:sessionId/workspace/file", async (req, res) => {
    const payload = workspaceReadSchema.safeParse(req.query);
    if (!payload.success) {
      return res.status(400).json({ error: payload.error.flatten() });
    }

    try {
      const result = await lifecycleManager.readWorkspaceFile(req.params.sessionId, {
        path: payload.data.path,
        offset: payload.data.offset,
        limit: payload.data.limit,
      });
      return res.json(result);
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.put("/session-workers/:sessionId/workspace/file", async (req, res) => {
    const payload = workspaceWriteSchema.safeParse(req.body ?? {});
    if (!payload.success) {
      return res.status(400).json({ error: payload.error.flatten() });
    }

    try {
      const result = await lifecycleManager.writeWorkspaceFile(req.params.sessionId, {
        path: payload.data.path,
        content: payload.data.content,
        encoding: payload.data.encoding,
      });
      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.post("/session-workers/:sessionId/workspace/upload", async (req, res) => {
    const payload = workspaceUploadSchema.safeParse(req.body ?? {});
    if (!payload.success) {
      return res.status(400).json({ error: payload.error.flatten() });
    }

    try {
      const result = await lifecycleManager.uploadWorkspaceFile(req.params.sessionId, {
        path: payload.data.path,
        contentBase64: payload.data.contentBase64,
      });
      return res.status(201).json({
        ok: true,
        ...result,
      });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.post("/session-workers/:sessionId/workspace/rename", async (req, res) => {
    const payload = workspaceRenameSchema.safeParse(req.body ?? {});
    if (!payload.success) {
      return res.status(400).json({ error: payload.error.flatten() });
    }

    try {
      const result = await lifecycleManager.renameWorkspacePath(req.params.sessionId, {
        path: payload.data.path,
        newPath: payload.data.newPath,
      });
      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.delete("/session-workers/:sessionId/workspace/file", async (req, res) => {
    const payload = workspaceDeleteSchema.safeParse(req.query);
    if (!payload.success) {
      return res.status(400).json({ error: payload.error.flatten() });
    }

    try {
      const result = await lifecycleManager.deleteWorkspacePath(
        req.params.sessionId,
        payload.data.path,
      );
      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.post("/session-workers/:sessionId/workspace/mkdir", async (req, res) => {
    const payload = workspaceMkdirSchema.safeParse(req.body ?? {});
    if (!payload.success) {
      return res.status(400).json({ error: payload.error.flatten() });
    }

    try {
      const result = await lifecycleManager.mkdirWorkspacePath(
        req.params.sessionId,
        payload.data.path,
      );
      return res.status(201).json({
        ok: true,
        ...result,
      });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.get("/session-workers/:sessionId/workspace/download", async (req, res) => {
    const payload = workspaceDownloadSchema.safeParse(req.query);
    if (!payload.success) {
      return res.status(400).json({ error: payload.error.flatten() });
    }

    try {
      const file = await lifecycleManager.downloadWorkspaceFile(
        req.params.sessionId,
        payload.data.path,
      );
      const inline = payload.data.inline === "1" || payload.data.inline === "true";

      res.setHeader("content-type", file.contentType);
      res.setHeader(
        "content-disposition",
        `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(file.fileName)}"`,
      );
      return res.status(200).send(file.content);
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.post("/session-workers/:sessionId/tty/exec", async (req, res) => {
    const payload = ttyExecSchema.safeParse(req.body ?? {});
    if (!payload.success) {
      return res.status(400).json({ error: payload.error.flatten() });
    }

    try {
      const result = await lifecycleManager.executeWorkspaceCommand(
        req.params.sessionId,
        payload.data,
      );
      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  return router;
}

function sendRouteError(res: Response, error: unknown) {
  if (error instanceof SessionWorkerNotFoundError) {
    return res.status(404).json({ error: error.message });
  }

  const withStatus = error as {
    status?: unknown;
    responseBody?: unknown;
    message?: unknown;
  };
  if (typeof withStatus.status === "number" && withStatus.status >= 400) {
    const message =
      typeof withStatus.responseBody === "string" && withStatus.responseBody.length > 0
        ? withStatus.responseBody
        : typeof withStatus.message === "string" && withStatus.message.length > 0
          ? withStatus.message
          : "executor request failed";
    return res.status(withStatus.status).json({ error: message });
  }

  return res.status(500).json({
    error: error instanceof Error ? error.message : String(error),
  });
}
