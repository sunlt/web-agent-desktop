import { Router } from "express";
import { z } from "zod";
import type { RbacRepository } from "../repositories/rbac-repository.js";
import type { FileBrowser } from "../services/file-browser.js";

const treeSchema = z.object({
  userId: z.string().min(1),
  path: z.string().optional(),
});

const downloadSchema = z.object({
  userId: z.string().min(1),
  path: z.string().min(1),
});

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
    await input.rbacRepository.recordFileAudit({
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

    const result = await input.fileBrowser.listTree(path);
    return res.json(result);
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

    await input.rbacRepository.recordFileAudit({
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

    const file = await input.fileBrowser.download(parsed.data.path);
    res.setHeader("content-type", file.contentType);
    res.setHeader(
      "content-disposition",
      `attachment; filename="${encodeURIComponent(file.fileName)}"`,
    );
    return res.status(200).send(file.content);
  });

  return router;
}
