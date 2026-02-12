import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { RunCallbackRepository } from "../repositories/run-callback-repository.js";
import type {
  RunOrchestrator,
  RunOrchestratorEvent,
} from "../services/run-orchestrator.js";
import {
  buildRestorePlan,
  RestorePlanValidationError,
  validateRequiredPaths,
} from "../services/restore-plan.js";
import { StreamBus } from "../services/stream-bus.js";

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

export function createRunsRouter(input: {
  orchestrator: RunOrchestrator;
  callbackRepo?: RunCallbackRepository;
}): Router {
  const router = Router();
  const streamBus = new StreamBus<RunOrchestratorEvent>(2000);
  const pumpingRuns = new Set<string>();

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

    const sseRequested = wantsSse(req.headers.accept);
    if (sseRequested) {
      const started = await input.orchestrator.startRun(parsed.data);
      if (!started.accepted) {
        return res.status(409).json(started);
      }
      startRunPump(input.orchestrator, streamBus, pumpingRuns, started.runId);
      return streamRunAsSse({
        req,
        res,
        runId: started.runId,
        streamBus,
      });
    }

    const started = await input.orchestrator.startRun(parsed.data);

    if (!started.accepted) {
      return res.status(409).json(started);
    }

    const events = [];
    for await (const event of input.orchestrator.streamRun(started.runId)) {
      events.push(event);
    }

    return res.json({
      ...started,
      events,
      snapshot: input.orchestrator.getRunSnapshot(started.runId),
    });
  });

  router.post("/runs/:runId/stop", async (req, res) => {
    const stopped = await input.orchestrator.stopRun(req.params.runId);
    if (!stopped) {
      return res.status(404).json({ error: "run not found or not running" });
    }

    if (input.callbackRepo) {
      const callbackRepo = input.callbackRepo;
      const now = new Date();
      const pendingRequests = await callbackRepo.listPendingRequests({
        runId: req.params.runId,
        limit: 500,
      });

      await Promise.all(
        pendingRequests.map((request) =>
          callbackRepo.markRequestStatus({
            questionId: request.questionId,
            runId: request.runId,
            status: "canceled",
            resolvedAt: now,
          }),
        ),
      );

      await callbackRepo.updateRunStatus({
        runId: req.params.runId,
        status: "canceled",
        updatedAt: now,
      });
    }

    return res.json({ ok: true });
  });

  router.get("/runs/:runId", async (req, res) => {
    const snapshot = input.orchestrator.getRunSnapshot(req.params.runId);
    if (!snapshot) {
      return res.status(404).json({ error: "run not found" });
    }
    return res.json(snapshot);
  });

  router.get("/runs/:runId/stream", async (req, res) => {
    const snapshot = input.orchestrator.getRunSnapshot(req.params.runId);
    if (!snapshot) {
      return res.status(404).json({ error: "run not found" });
    }

    if (snapshot.status === "running") {
      startRunPump(input.orchestrator, streamBus, pumpingRuns, req.params.runId);
    }

    return streamRunAsSse({
      req,
      res,
      runId: req.params.runId,
      streamBus,
    });
  });

  return router;
}

function wantsSse(acceptHeader: string | undefined): boolean {
  return (acceptHeader ?? "").includes("text/event-stream");
}

function startRunPump(
  orchestrator: RunOrchestrator,
  streamBus: StreamBus<RunOrchestratorEvent>,
  pumpingRuns: Set<string>,
  runId: string,
): void {
  if (pumpingRuns.has(runId)) {
    return;
  }

  pumpingRuns.add(runId);

  void (async () => {
    try {
      for await (const event of orchestrator.streamRun(runId)) {
        streamBus.publish(runId, event);
      }
    } catch (error) {
      const snapshot = orchestrator.getRunSnapshot(runId);
      streamBus.publish(runId, {
        type: "run.status",
        runId,
        provider: snapshot?.provider ?? "opencode",
        status: "failed",
        ts: new Date().toISOString(),
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      streamBus.close(runId);
      pumpingRuns.delete(runId);
    }
  })();
}

function streamRunAsSse(input: {
  req: Request;
  res: Response;
  runId: string;
  streamBus: StreamBus<RunOrchestratorEvent>;
}) {
  input.res.status(200);
  input.res.setHeader("content-type", "text/event-stream; charset=utf-8");
  input.res.setHeader("cache-control", "no-cache");
  input.res.setHeader("connection", "keep-alive");
  input.res.flushHeaders?.();

  const afterSeq = parseAfterSeq(input.req);

  const unsubscribe = input.streamBus.subscribe({
    streamId: input.runId,
    afterSeq,
    onEvent: (entry) => {
      input.res.write(`id: ${entry.seq}\n`);
      input.res.write(`event: ${entry.event.type}\n`);
      input.res.write(`data: ${JSON.stringify(entry.event)}\n\n`);
    },
    onClose: () => {
      input.res.write(
        `event: run.closed\ndata: ${JSON.stringify({ runId: input.runId })}\n\n`,
      );
      input.res.end();
    },
  });

  const heartbeat = setInterval(() => {
    input.res.write(": heartbeat\n\n");
  }, 15_000);

  input.req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function parseAfterSeq(req: Request): number {
  const queryCursor =
    typeof req.query?.cursor === "string" ? req.query.cursor : undefined;
  const lastEventId = req.headers["last-event-id"];
  const headerCursor =
    typeof lastEventId === "string"
      ? lastEventId
      : Array.isArray(lastEventId)
        ? lastEventId[0]
        : undefined;
  const raw = queryCursor ?? headerCursor;
  if (!raw) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}
