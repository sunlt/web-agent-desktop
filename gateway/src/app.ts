import express, { type Express } from "express";
import { createProxyHandler } from "./proxy.js";

export interface CreateGatewayAppOptions {
  readonly controlPlaneBaseUrl?: string;
  readonly executorManagerBaseUrl?: string;
  readonly upstreamTimeoutMs?: number;
}

export function createGatewayApp(options: CreateGatewayAppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");

  const controlPlaneBaseUrl =
    options.controlPlaneBaseUrl ?? process.env.GATEWAY_CONTROL_PLANE_URL ?? "http://127.0.0.1:3000";
  const executorManagerBaseUrl =
    options.executorManagerBaseUrl ??
    process.env.GATEWAY_EXECUTOR_MANAGER_URL ??
    "http://127.0.0.1:3010";
  const upstreamTimeoutMs = Math.max(
    1,
    options.upstreamTimeoutMs ?? Number(process.env.GATEWAY_UPSTREAM_TIMEOUT_MS ?? 30_000),
  );

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      const payload = {
        ts: new Date().toISOString(),
        component: "gateway",
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      };
      if (res.statusCode >= 500) {
        console.error(JSON.stringify({ level: "error", ...payload }));
      } else if (res.statusCode >= 400) {
        console.warn(JSON.stringify({ level: "warn", ...payload }));
      } else {
        console.info(JSON.stringify({ level: "info", ...payload }));
      }
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "gateway",
      controlPlaneBaseUrl,
      executorManagerBaseUrl,
      upstreamTimeoutMs,
    });
  });

  app.post(
    "/alertmanager/webhook",
    express.json({ limit: "512kb" }),
    (req, res) => {
      const payload = req.body as {
        readonly receiver?: string;
        readonly status?: string;
        readonly alerts?: Array<{
          readonly status?: string;
          readonly labels?: Record<string, string>;
        }>;
      };
      const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
      const alertNames = alerts
        .map((item) => item.labels?.alertname)
        .filter((item): item is string => typeof item === "string")
        .slice(0, 12);

      console.warn(
        JSON.stringify({
          level: "warn",
          ts: new Date().toISOString(),
          component: "gateway",
          message: "alertmanager webhook received",
          receiver: payload?.receiver ?? "unknown",
          status: payload?.status ?? "unknown",
          alertCount: alerts.length,
          alertNames,
        }),
      );

      res.status(202).json({ ok: true });
    },
  );

  app.use(
    "/api/session-workers",
    createProxyHandler({
      name: "executor-manager",
      baseUrl: executorManagerBaseUrl,
      timeoutMs: upstreamTimeoutMs,
    }),
  );

  app.use(
    "/api",
    createProxyHandler({
      name: "control-plane",
      baseUrl: controlPlaneBaseUrl,
      timeoutMs: upstreamTimeoutMs,
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  return app;
}
