import type { Pool } from "pg";
import express, { type Express } from "express";
import { DockerCliClient } from "./adapters/docker-cli-client.js";
import { ExecutorHttpClient } from "./adapters/executor-http-client.js";
import { NoopDockerClient } from "./adapters/noop-docker-client.js";
import { NoopExecutorClient } from "./adapters/noop-executor-client.js";
import { NoopWorkspaceSyncClient } from "./adapters/noop-workspace-sync-client.js";
import { createPostgresPool } from "./adapters/postgres-pool.js";
import type { DockerClient } from "./ports/docker-client.js";
import type { ExecutorClient } from "./ports/executor-client.js";
import type { WorkspaceSyncClient } from "./ports/workspace-sync-client.js";
import { InMemorySessionWorkerRepository } from "./repositories/in-memory-session-worker-repository.js";
import { PostgresSessionWorkerRepository } from "./repositories/postgres-session-worker-repository.js";
import type { SessionWorkerRepository } from "./repositories/session-worker-repository.js";
import { createProviderRunsRouter } from "./routes/provider-runs.js";
import { createSessionWorkersRouter } from "./routes/session-workers.js";
import { LifecycleManager } from "./services/lifecycle-manager.js";

export interface CreateExecutorManagerAppOptions {
  readonly pool?: Pool | null;
  readonly usePostgres?: boolean;
  readonly useDockerCli?: boolean;
  readonly executorBaseUrl?: string;
  readonly sessionWorkerRepository?: SessionWorkerRepository;
  readonly dockerClient?: DockerClient;
  readonly workspaceSyncClient?: WorkspaceSyncClient;
  readonly executorClient?: ExecutorClient;
}

export function createExecutorManagerApp(
  options: CreateExecutorManagerAppOptions = {},
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  const usePostgres =
    options.usePostgres ?? process.env.EXECUTOR_MANAGER_STORAGE === "postgres";
  const useDockerCli =
    options.useDockerCli ?? process.env.EXECUTOR_MANAGER_DOCKER === "cli";
  const executorBaseUrl =
    options.executorBaseUrl ?? process.env.EXECUTOR_BASE_URL;

  const pool = options.pool ?? (usePostgres ? createPostgresPool() : null);

  const sessionWorkerRepository =
    options.sessionWorkerRepository ??
    (pool
      ? new PostgresSessionWorkerRepository(pool)
      : new InMemorySessionWorkerRepository());
  const dockerClient =
    options.dockerClient ??
    (useDockerCli
      ? new DockerCliClient({
          containerImage:
            process.env.EXECUTOR_CONTAINER_IMAGE ?? "executor:latest",
          containerCommand: parseCommand(
            process.env.EXECUTOR_CONTAINER_COMMAND_JSON,
          ),
          network: process.env.EXECUTOR_CONTAINER_NETWORK,
        })
      : new NoopDockerClient());

  const executorClient =
    options.executorClient ??
    (executorBaseUrl
      ? new ExecutorHttpClient({
          baseUrl: executorBaseUrl,
          timeoutMs: parseNumber(process.env.EXECUTOR_TIMEOUT_MS, 30_000),
          token: process.env.EXECUTOR_AUTH_TOKEN,
          maxRetries: parseNumber(process.env.EXECUTOR_MAX_RETRIES, 0),
          retryDelayMs: parseNumber(process.env.EXECUTOR_RETRY_DELAY_MS, 200),
          retryStatusCodes: parseStatusCodes(
            process.env.EXECUTOR_RETRY_STATUS_CODES,
          ),
        })
      : new NoopExecutorClient());

  const workspaceSyncClient =
    options.workspaceSyncClient ??
    (isWorkspaceSyncClient(executorClient)
      ? executorClient
      : new NoopWorkspaceSyncClient());

  const lifecycleManager = new LifecycleManager(
    sessionWorkerRepository,
    dockerClient,
    workspaceSyncClient,
    executorClient,
  );

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      const payload = {
        ts: new Date().toISOString(),
        component: "executor-manager",
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
      service: "executor-manager",
      mode: "native",
      usePostgres,
      useDockerCli,
      executorBaseUrl: executorBaseUrl ?? null,
    });
  });

  if (executorBaseUrl) {
    app.use(
      "/api",
      createProviderRunsRouter({
        executorBaseUrl,
        executorToken: process.env.EXECUTOR_AUTH_TOKEN,
        timeoutMs: parseNumber(process.env.EXECUTOR_RUN_TIMEOUT_MS, 1_800_000),
      }),
    );
  }

  app.use("/api", createSessionWorkersRouter(lifecycleManager));

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  return app;
}

function parseCommand(raw?: string): readonly string[] | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function parseStatusCodes(raw?: string): readonly number[] | undefined {
  if (!raw) {
    return undefined;
  }
  const codes = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((code) => Number.isInteger(code) && code >= 100 && code <= 599);
  return codes.length > 0 ? codes : undefined;
}

function isWorkspaceSyncClient(
  client: ExecutorClient | WorkspaceSyncClient,
): client is WorkspaceSyncClient {
  return "syncWorkspace" in client;
}
