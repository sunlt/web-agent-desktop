import { Router } from "express";
import { z } from "zod";
import type { RunOrchestrator } from "../services/run-orchestrator.js";
import {
  buildRestorePlan,
  RestorePlanValidationError,
  validateRequiredPaths,
} from "../services/restore-plan.js";

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1),
});

const startRunSchema = z.object({
  runId: z.string().optional(),
  provider: z.enum(["claude-code", "opencode", "codex-cli"]),
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  resumeSessionId: z.string().optional(),
  executionProfile: z.string().optional(),
  tools: z.record(z.string(), z.unknown()).optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  requireHumanLoop: z.boolean().optional(),
});

const runtimeManifestSchema = z.object({
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
  conflictPolicy: z.enum(["keep_session", "prefer_registry", "merge"]).optional(),
  protectedPaths: z.array(z.string().min(1)).optional(),
  cleanupRules: z
    .array(
      z.object({
        action: z.enum(["remove_if_exists", "truncate_if_exists"]),
        path: z.string().min(1),
      }),
    )
    .default([]),
});

const restorePlanSchema = z.object({
  appId: z.string().min(1),
  projectName: z.string().optional(),
  userLoginName: z.string().min(1),
  sessionId: z.string().min(1),
  runtimeVersion: z.string().min(1),
  manifest: runtimeManifestSchema,
  existingPaths: z.array(z.string().min(1)).optional(),
});

export function createRunsRouter(orchestrator: RunOrchestrator): Router {
  const router = Router();

  router.post("/runs/restore-plan", async (req, res) => {
    const parsed = restorePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    try {
      const plan = buildRestorePlan(parsed.data);
      if (parsed.data.existingPaths) {
        const validation = validateRequiredPaths(
          plan.requiredPaths,
          parsed.data.existingPaths,
        );
        if (!validation.ok) {
          return res.status(422).json({
            ok: false,
            reason: "required_paths_missing",
            missingRequiredPaths: validation.missingRequiredPaths,
            plan,
          });
        }
      }

      return res.json({
        ok: true,
        plan,
      });
    } catch (error) {
      if (error instanceof RestorePlanValidationError) {
        return res.status(400).json({
          error: error.message,
          details: error.details,
        });
      }

      throw error;
    }
  });

  router.post("/runs/start", async (req, res) => {
    const parsed = startRunSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const started = await orchestrator.startRun(parsed.data);

    if (!started.accepted) {
      return res.status(409).json(started);
    }

    const events = [];
    for await (const event of orchestrator.streamRun(started.runId)) {
      events.push(event);
    }

    return res.json({
      ...started,
      events,
      snapshot: orchestrator.getRunSnapshot(started.runId),
    });
  });

  router.post("/runs/:runId/stop", async (req, res) => {
    const stopped = await orchestrator.stopRun(req.params.runId);
    if (!stopped) {
      return res.status(404).json({ error: "run not found or not running" });
    }
    return res.json({ ok: true });
  });

  router.get("/runs/:runId", async (req, res) => {
    const snapshot = orchestrator.getRunSnapshot(req.params.runId);
    if (!snapshot) {
      return res.status(404).json({ error: "run not found" });
    }
    return res.json(snapshot);
  });

  return router;
}
