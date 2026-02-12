import { Router } from "express";
import { z } from "zod";
import type { RbacRepository } from "../repositories/rbac-repository.js";

const listStoreSchema = z.object({
  userId: z.string().min(1),
});

export function createAppsRouter(rbacRepository: RbacRepository): Router {
  const router = Router();

  router.get("/apps/store", async (req, res) => {
    const parsed = listStoreSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const all = await rbacRepository.listStoreAppsForUser(parsed.data.userId);
    const visible = all.filter((item) => item.canView);
    return res.json({
      total: visible.length,
      apps: visible,
    });
  });

  return router;
}
