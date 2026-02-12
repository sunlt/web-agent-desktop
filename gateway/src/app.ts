import express, { type Express } from "express";
import { createProxyHandler } from "./proxy.js";

export interface CreateGatewayAppOptions {
  readonly controlPlaneBaseUrl?: string;
  readonly upstreamTimeoutMs?: number;
}

export function createGatewayApp(options: CreateGatewayAppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");

  const controlPlaneBaseUrl =
    options.controlPlaneBaseUrl ?? process.env.GATEWAY_CONTROL_PLANE_URL ?? "http://127.0.0.1:3000";
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
      upstreamTimeoutMs,
    });
  });

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
