import { type Response, Router } from "express";
import { z } from "zod";
import type {
  FileAuditLogInput,
  RbacRepository,
} from "../repositories/rbac-repository.js";
import {
  FileBrowserError,
  type FileBrowser,
} from "../services/file-browser.js";

const treeSchema = z.object({
  userId: z.string().min(1),
  path: z.string().optional(),
});

const downloadSchema = z.object({
  userId: z.string().min(1),
  path: z.string().min(1),
});

const readFileSchema = z.object({
  userId: z.string().min(1),
  path: z.string().min(1),
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(1024 * 1024).optional(),
});

const writeFileSchema = z
  .object({
    userId: z.string().min(1),
    path: z.string().min(1),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).optional(),
  })
  .strict();

const uploadSchema = z
  .object({
    userId: z.string().min(1),
    path: z.string().min(1),
    contentBase64: z.string(),
  })
  .strict();

const renameSchema = z
  .object({
    userId: z.string().min(1),
    path: z.string().min(1),
    newPath: z.string().min(1),
  })
  .strict();

const deleteSchema = z.object({
  userId: z.string().min(1),
  path: z.string().min(1),
});

const mkdirSchema = z
  .object({
    userId: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();

export function createFilesRouter(input: {
  rbacRepository: RbacRepository;
  fileBrowser: FileBrowser;
}): Router {
  const router = Router();

  router.get("/files/tree", async (req, res) => {
    const parsed = treeSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const path = parsed.data.path ?? "/";
    const allowed = await input.rbacRepository.canReadPath(parsed.data.userId, path);
    await recordAudit(input.rbacRepository, {
      userId: parsed.data.userId,
      action: "tree",
      path,
      allowed,
      reason: allowed ? undefined : "forbidden",
      ts: new Date(),
    });

    if (!allowed) {
      return res.status(403).json({ error: "forbidden" });
    }

    try {
      const result = await input.fileBrowser.listTree(path);
      return res.json(result);
    } catch (error) {
      return sendFileError(res, error);
    }
  });

  router.get("/files/download", async (req, res) => {
    const parsed = downloadSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const allowed = await input.rbacRepository.canReadPath(
      parsed.data.userId,
      parsed.data.path,
    );

    await recordAudit(input.rbacRepository, {
      userId: parsed.data.userId,
      action: "download",
      path: parsed.data.path,
      allowed,
      reason: allowed ? undefined : "forbidden",
      ts: new Date(),
    });

    if (!allowed) {
      return res.status(403).json({ error: "forbidden" });
    }

    try {
      const file = await input.fileBrowser.download(parsed.data.path);
      res.setHeader("content-type", file.contentType);
      res.setHeader(
        "content-disposition",
        `attachment; filename="${encodeURIComponent(file.fileName)}"`,
      );
      return res.status(200).send(file.content);
    } catch (error) {
      return sendFileError(res, error);
    }
  });

  router.get("/files/file", async (req, res) => {
    const parsed = readFileSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const allowed = await input.rbacRepository.canReadPath(
      parsed.data.userId,
      parsed.data.path,
    );
    await recordAudit(input.rbacRepository, {
      userId: parsed.data.userId,
      action: "read",
      path: parsed.data.path,
      allowed,
      reason: allowed ? undefined : "forbidden",
      ts: new Date(),
    });

    if (!allowed) {
      return res.status(403).json({ error: "forbidden" });
    }

    try {
      const file = await input.fileBrowser.readFile(parsed.data.path, {
        offset: parsed.data.offset,
        limit: parsed.data.limit,
      });
      return res.json(file);
    } catch (error) {
      return sendFileError(res, error);
    }
  });

  router.put("/files/file", async (req, res) => {
    const parsed = writeFileSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const allowed = await input.rbacRepository.canWritePath(
      parsed.data.userId,
      parsed.data.path,
    );
    await recordAudit(input.rbacRepository, {
      userId: parsed.data.userId,
      action: "write",
      path: parsed.data.path,
      allowed,
      reason: allowed ? undefined : "forbidden",
      ts: new Date(),
    });

    if (!allowed) {
      return res.status(403).json({ error: "forbidden" });
    }

    try {
      const result = await input.fileBrowser.writeFile(parsed.data.path, {
        content: parsed.data.content,
        encoding: parsed.data.encoding,
      });
      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      return sendFileError(res, error);
    }
  });

  router.post("/files/upload", async (req, res) => {
    const parsed = uploadSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const allowed = await input.rbacRepository.canWritePath(
      parsed.data.userId,
      parsed.data.path,
    );
    await recordAudit(input.rbacRepository, {
      userId: parsed.data.userId,
      action: "upload",
      path: parsed.data.path,
      allowed,
      reason: allowed ? undefined : "forbidden",
      ts: new Date(),
    });

    if (!allowed) {
      return res.status(403).json({ error: "forbidden" });
    }

    try {
      const result = await input.fileBrowser.writeFile(parsed.data.path, {
        content: parsed.data.contentBase64,
        encoding: "base64",
      });
      return res.status(201).json({
        ok: true,
        ...result,
      });
    } catch (error) {
      return sendFileError(res, error);
    }
  });

  router.post("/files/rename", async (req, res) => {
    const parsed = renameSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const [allowSource, allowTarget] = await Promise.all([
      input.rbacRepository.canWritePath(parsed.data.userId, parsed.data.path),
      input.rbacRepository.canWritePath(parsed.data.userId, parsed.data.newPath),
    ]);
    const allowed = allowSource && allowTarget;
    await recordAudit(input.rbacRepository, {
      userId: parsed.data.userId,
      action: "rename",
      path: `${parsed.data.path} => ${parsed.data.newPath}`,
      allowed,
      reason: allowed ? undefined : "forbidden",
      ts: new Date(),
    });

    if (!allowed) {
      return res.status(403).json({ error: "forbidden" });
    }

    try {
      const result = await input.fileBrowser.rename(
        parsed.data.path,
        parsed.data.newPath,
      );
      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      return sendFileError(res, error);
    }
  });

  router.delete("/files/file", async (req, res) => {
    const parsed = deleteSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const allowed = await input.rbacRepository.canWritePath(
      parsed.data.userId,
      parsed.data.path,
    );
    await recordAudit(input.rbacRepository, {
      userId: parsed.data.userId,
      action: "delete",
      path: parsed.data.path,
      allowed,
      reason: allowed ? undefined : "forbidden",
      ts: new Date(),
    });

    if (!allowed) {
      return res.status(403).json({ error: "forbidden" });
    }

    try {
      const result = await input.fileBrowser.deletePath(parsed.data.path);
      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      return sendFileError(res, error);
    }
  });

  router.post("/files/mkdir", async (req, res) => {
    const parsed = mkdirSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const allowed = await input.rbacRepository.canWritePath(
      parsed.data.userId,
      parsed.data.path,
    );
    await recordAudit(input.rbacRepository, {
      userId: parsed.data.userId,
      action: "mkdir",
      path: parsed.data.path,
      allowed,
      reason: allowed ? undefined : "forbidden",
      ts: new Date(),
    });

    if (!allowed) {
      return res.status(403).json({ error: "forbidden" });
    }

    try {
      const result = await input.fileBrowser.mkdir(parsed.data.path);
      return res.status(201).json({
        ok: true,
        ...result,
      });
    } catch (error) {
      return sendFileError(res, error);
    }
  });

  return router;
}

async function recordAudit(
  rbacRepository: RbacRepository,
  input: FileAuditLogInput,
): Promise<void> {
  await rbacRepository.recordFileAudit(input);
}

function sendFileError(
  res: Response,
  error: unknown,
) {
  const mapped = mapFileError(error);
  return res.status(mapped.status).json({
    error: mapped.message,
    code: mapped.code,
  });
}

function mapFileError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof FileBrowserError) {
    switch (error.code) {
      case "invalid_path":
      case "not_directory":
        return {
          status: 400,
          code: error.code,
          message: error.message,
        };
      case "not_found":
        return {
          status: 404,
          code: error.code,
          message: error.message,
        };
      case "already_exists":
      case "is_directory":
        return {
          status: 409,
          code: error.code,
          message: error.message,
        };
      default:
        return {
          status: 500,
          code: error.code,
          message: error.message,
        };
    }
  }

  return {
    status: 500,
    code: "unknown_error",
    message: error instanceof Error ? error.message : "internal_error",
  };
}
