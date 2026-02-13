import { Router } from "express";
import { z } from "zod";
import type { RbacRepository } from "../repositories/rbac-repository.js";

const providerSchema = z.enum([
  "claude-code",
  "opencode",
  "codex-cli",
  "codex-app-server",
]);

const listStoreSchema = z.object({
  userId: z.string().min(1),
});

const registerStoreSchema = z.object({
  appId: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  visibilityRules: z
    .array(
      z.object({
        scopeType: z.enum(["all", "department", "user"]),
        scopeValue: z.string().min(1).optional(),
      }),
    )
    .optional(),
  members: z
    .array(
      z.object({
        userId: z.string().min(1),
        canUse: z.boolean(),
      }),
    )
    .optional(),
  runtimeDefaults: z
    .object({
      provider: providerSchema,
      model: z.string().min(1),
      timeoutMs: z.number().int().positive().optional(),
      credentialEnv: z.record(z.string(), z.string()).optional(),
      providerOptions: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
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

  router.post("/apps/register", async (req, res) => {
    const parsed = registerStoreSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    await rbacRepository.upsertStoreApp(parsed.data);
    return res.status(201).json({
      ok: true,
      appId: parsed.data.appId,
    });
  });

  return router;
}
