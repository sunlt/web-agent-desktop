import { Router } from "express";
import { z } from "zod";
import type { Reconciler } from "../services/reconciler.js";

const reconcileRunsSchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
  retryDelayMs: z.number().int().nonnegative().max(300_000).optional(),
});

const reconcileSyncSchema = z.object({
  staleAfterMs: z.number().int().positive(),
  limit: z.number().int().positive().max(500).optional(),
});

export function createReconcileRouter(reconciler: Reconciler): Router {
  const router = Router();

  router.post("/reconcile/runs", async (req, res) => {
    const parsed = reconcileRunsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const result = await reconciler.reconcileStaleRuns(parsed.data);
    return res.json(result);
  });

  router.post("/reconcile/sync", async (req, res) => {
    const parsed = reconcileSyncSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const result = await reconciler.reconcileStaleSync(parsed.data);
    return res.json(result);
  });

  return router;
}
