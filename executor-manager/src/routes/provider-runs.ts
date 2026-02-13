import { Readable } from "node:stream";
import { Router, type Request, type Response as ExpressResponse } from "express";
import { z } from "zod";
import type {
  ProviderTimeoutTemplate,
} from "../config/provider-timeout-template.js";
import { resolveRunTimeoutMs } from "../config/provider-timeout-template.js";

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1),
});

const startRunSchema = z.object({
  runId: z.string().min(1),
  provider: z.enum(["claude-code", "opencode", "codex-cli", "codex-app-server"]),
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  resumeSessionId: z.string().optional(),
  executionProfile: z.string().optional(),
  tools: z.record(z.string(), z.unknown()).optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  requireHumanLoop: z.boolean().optional(),
});

const replySchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().min(1),
});

const FORWARDED_TRACE_HEADERS = [
  "x-trace-id",
  "x-trace-operation",
  "x-trace-session-id",
  "x-trace-executor-id",
  "x-trace-run-id",
  "last-event-id",
] as const;

export interface CreateProviderRunsRouterOptions {
  readonly executorBaseUrl: string;
  readonly executorToken?: string;
  readonly defaultTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly timeoutTemplate?: ProviderTimeoutTemplate;
  readonly maxTrackedRuns?: number;
}

export function createProviderRunsRouter(
  options: CreateProviderRunsRouterOptions,
): Router {
  const router = Router();
  const baseUrl = options.executorBaseUrl.replace(/\/+$/, "");
  const defaultTimeoutMs = normalizeTimeoutMs(
    options.defaultTimeoutMs ?? options.timeoutMs,
    1_800_000,
  );
  const timeoutTemplate = options.timeoutTemplate ?? {};
  const maxTrackedRuns = Math.max(
    200,
    normalizeTimeoutMs(options.maxTrackedRuns, 2_000),
  );
  const runTimeoutById = new Map<string, number>();
  const runOrder: string[] = [];

  router.post("/provider-runs/start", async (req, res) => {
    const parsed = startRunSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const runTimeoutMs = resolveRunTimeoutMs({
      provider: parsed.data.provider,
      model: parsed.data.model,
      providerOptions: parsed.data.providerOptions,
      fallbackTimeoutMs: defaultTimeoutMs,
      template: timeoutTemplate,
    });
    rememberRunTimeout({
      runId: parsed.data.runId,
      timeoutMs: runTimeoutMs,
      runTimeoutById,
      runOrder,
      maxTrackedRuns,
    });

    return proxyJsonRequest({
      req,
      res,
      method: "POST",
      timeoutMs: runTimeoutMs,
      url: `${baseUrl}/provider-runs/start`,
      body: parsed.data,
      token: options.executorToken,
    });
  });

  router.get("/provider-runs/:runId/stream", async (req, res) => {
    const runId = req.params.runId;
    const query = new URLSearchParams();
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    if (cursor) {
      query.set("cursor", cursor);
    }

    const url = `${baseUrl}/provider-runs/${encodeURIComponent(runId)}/stream${
      query.toString().length > 0 ? `?${query.toString()}` : ""
    }`;

    return proxySseRequest({
      req,
      res,
      timeoutMs: runTimeoutById.get(runId) ?? defaultTimeoutMs,
      url,
      token: options.executorToken,
    });
  });

  router.post("/provider-runs/:runId/stop", async (req, res) => {
    const runId = req.params.runId;
    const response = await proxyJsonRequest({
      req,
      res,
      method: "POST",
      timeoutMs: runTimeoutById.get(runId) ?? defaultTimeoutMs,
      url: `${baseUrl}/provider-runs/${encodeURIComponent(runId)}/stop`,
      body: {},
      token: options.executorToken,
    });
    runTimeoutById.delete(runId);
    return response;
  });

  router.post("/provider-runs/:runId/human-loop/reply", async (req, res) => {
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const runId = req.params.runId;
    return proxyJsonRequest({
      req,
      res,
      method: "POST",
      timeoutMs: runTimeoutById.get(runId) ?? defaultTimeoutMs,
      url: `${baseUrl}/provider-runs/${encodeURIComponent(runId)}/human-loop/reply`,
      body: parsed.data,
      token: options.executorToken,
    });
  });

  return router;
}

function rememberRunTimeout(input: {
  runId: string;
  timeoutMs: number;
  runTimeoutById: Map<string, number>;
  runOrder: string[];
  maxTrackedRuns: number;
}): void {
  const { runId, timeoutMs, runTimeoutById, runOrder, maxTrackedRuns } = input;
  if (!runTimeoutById.has(runId)) {
    runOrder.push(runId);
  }
  runTimeoutById.set(runId, timeoutMs);

  while (runOrder.length > maxTrackedRuns) {
    const staleRunId = runOrder.shift();
    if (!staleRunId) {
      continue;
    }
    runTimeoutById.delete(staleRunId);
  }
}

async function proxyJsonRequest(input: {
  req: Request;
  res: ExpressResponse;
  method: "POST";
  timeoutMs: number;
  url: string;
  body: unknown;
  token?: string;
}): Promise<ExpressResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: input.method,
      headers: buildForwardHeaders({
        req: input.req,
        token: input.token,
        contentType: "application/json",
        accept: "application/json",
      }),
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });

    const text = await response.text();
    input.res.status(response.status);

    const contentType = response.headers.get("content-type");
    if (contentType) {
      input.res.setHeader("content-type", contentType);
    }

    if (text.length === 0) {
      return input.res.end();
    }

    return input.res.send(text);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return input.res.status(504).json({ error: "executor request timeout" });
    }
    return input.res.status(502).json({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function proxySseRequest(input: {
  req: Request;
  res: ExpressResponse;
  timeoutMs: number;
  url: string;
  token?: string;
}): Promise<ExpressResponse | void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  input.req.on("close", () => controller.abort());

  try {
    const response = await fetch(input.url, {
      method: "GET",
      headers: buildForwardHeaders({
        req: input.req,
        token: input.token,
        accept: "text/event-stream",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      return input.res.status(response.status).send(text);
    }

    if (!response.body) {
      return input.res.status(502).json({ error: "executor stream body missing" });
    }

    input.res.status(response.status);
    copySseHeaders(response, input.res);

    const stream = Readable.fromWeb(response.body as any);
    stream.on("error", () => {
      if (!input.res.writableEnded) {
        input.res.end();
      }
    });
    stream.pipe(input.res);

    input.req.on("close", () => {
      stream.destroy();
      controller.abort();
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (!input.res.headersSent) {
        input.res.status(504).json({ error: "executor stream timeout" });
      } else {
        input.res.end();
      }
      return;
    }

    if (!input.res.headersSent) {
      input.res.status(502).json({
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    input.res.end();
  } finally {
    clearTimeout(timeout);
  }
}

function buildForwardHeaders(input: {
  req: Request;
  token?: string;
  contentType?: string;
  accept?: string;
}): Headers {
  const headers = new Headers();

  for (const header of FORWARDED_TRACE_HEADERS) {
    const value = input.req.header(header);
    if (value) {
      headers.set(header, value);
    }
  }

  if (input.contentType) {
    headers.set("content-type", input.contentType);
  }
  if (input.accept) {
    headers.set("accept", input.accept);
  }
  if (input.token) {
    headers.set("authorization", `Bearer ${input.token}`);
  }

  return headers;
}

function copySseHeaders(
  from: globalThis.Response,
  to: import("express").Response,
): void {
  const contentType = from.headers.get("content-type") ?? "text/event-stream; charset=utf-8";
  const cacheControl = from.headers.get("cache-control") ?? "no-cache";
  const connection = from.headers.get("connection") ?? "keep-alive";

  to.setHeader("content-type", contentType);
  to.setHeader("cache-control", cacheControl);
  to.setHeader("connection", connection);
  to.flushHeaders?.();
}

function normalizeTimeoutMs(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.floor(raw);
}
