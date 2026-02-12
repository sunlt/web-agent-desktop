import express, { type Express } from "express";
import { NoopExecutorClient } from "./adapters/noop-executor-client.js";
import { NoopDockerClient } from "./adapters/noop-docker-client.js";
import { NoopWorkspaceSyncClient } from "./adapters/noop-workspace-sync-client.js";
import { createLogger, type Logger } from "./observability/logger.js";
import { ClaudeCodeProviderAdapter } from "./providers/claude-code-provider.js";
import { CodexCliProviderAdapter } from "./providers/codex-cli-provider.js";
import { OpencodeProviderAdapter } from "./providers/opencode-provider.js";
import { ProviderRegistry } from "./providers/provider-registry.js";
import type { AgentProviderAdapter } from "./providers/types.js";
import type { DockerClient } from "./ports/docker-client.js";
import type { ExecutorClient } from "./ports/executor-client.js";
import type { WorkspaceSyncClient } from "./ports/workspace-sync-client.js";
import { InMemoryRunCallbackRepository } from "./repositories/in-memory-run-callback-repository.js";
import { InMemoryRunQueueRepository } from "./repositories/in-memory-run-queue-repository.js";
import type { RunCallbackRepository } from "./repositories/run-callback-repository.js";
import type { RunQueueRepository } from "./repositories/run-queue-repository.js";
import { InMemorySessionWorkerRepository } from "./repositories/in-memory-session-worker-repository.js";
import type { SessionWorkerRepository } from "./repositories/session-worker-repository.js";
import { createHealthRouter } from "./routes/health.js";
import { createRunQueueRouter } from "./routes/run-queue.js";
import { createRunCallbacksRouter } from "./routes/run-callbacks.js";
import { createReconcileRouter } from "./routes/reconcile.js";
import { createRunsRouter } from "./routes/runs.js";
import { createSessionWorkersRouter } from "./routes/session-workers.js";
import { CallbackHandler } from "./services/callback-handler.js";
import { LifecycleManager } from "./services/lifecycle-manager.js";
import type { DrainQueueInput } from "./services/run-queue-manager.js";
import { RunQueueManager } from "./services/run-queue-manager.js";
import { Reconciler } from "./services/reconciler.js";
import { RunOrchestrator } from "./services/run-orchestrator.js";

export interface CreateControlPlaneAppOptions {
  readonly providerAdapters?: readonly AgentProviderAdapter[];
  readonly sessionWorkerRepository?: SessionWorkerRepository;
  readonly dockerClient?: DockerClient;
  readonly workspaceSyncClient?: WorkspaceSyncClient;
  readonly executorClient?: ExecutorClient;
  readonly callbackRepository?: RunCallbackRepository;
  readonly runQueueRepository?: RunQueueRepository;
  readonly runQueueManagerOptions?: {
    owner?: DrainQueueInput["owner"];
    lockMs?: DrainQueueInput["lockMs"];
    retryDelayMs?: DrainQueueInput["retryDelayMs"];
  };
  readonly logger?: Logger;
}

export function createControlPlaneApp(
  options: CreateControlPlaneAppOptions = {},
): Express {
  const app = express();
  app.use(express.json());

  const sessionWorkerRepository =
    options.sessionWorkerRepository ?? new InMemorySessionWorkerRepository();
  const dockerClient = options.dockerClient ?? new NoopDockerClient();
  const workspaceSyncClient =
    options.workspaceSyncClient ?? new NoopWorkspaceSyncClient();
  const executorClient = options.executorClient ?? new NoopExecutorClient();
  const callbackRepository =
    options.callbackRepository ?? new InMemoryRunCallbackRepository();
  const runQueueRepository =
    options.runQueueRepository ?? new InMemoryRunQueueRepository();
  const logger = options.logger ?? createLogger({ component: "control-plane" });

  const lifecycleManager = new LifecycleManager(
    sessionWorkerRepository,
    dockerClient,
    workspaceSyncClient,
    executorClient,
  );

  const providerRegistry = new ProviderRegistry(
    options.providerAdapters ?? [
      new OpencodeProviderAdapter(),
      new ClaudeCodeProviderAdapter(),
      new CodexCliProviderAdapter(),
    ],
  );

  const runOrchestrator = new RunOrchestrator(providerRegistry);
  const runQueueManager = new RunQueueManager(
    runQueueRepository,
    runOrchestrator,
    {
      ...options.runQueueManagerOptions,
      logger,
    },
  );
  const reconciler = new Reconciler(
    runQueueRepository,
    sessionWorkerRepository,
    lifecycleManager,
    {
      logger,
    },
  );
  const callbackHandler = new CallbackHandler({
    eventRepo: callbackRepository,
    runContextRepo: callbackRepository,
    runStateRepo: callbackRepository,
    todoRepo: callbackRepository,
    humanLoopRepo: callbackRepository,
    sessionSyncService: lifecycleManager,
  });

  app.use(createHealthRouter());
  app.use("/api", createSessionWorkersRouter(lifecycleManager));
  app.use("/api", createRunsRouter(runOrchestrator));
  app.use("/api", createRunQueueRouter(runQueueManager));
  app.use("/api", createReconcileRouter(reconciler));
  app.use(
    "/api",
    createRunCallbacksRouter({
      callbackHandler,
      callbackRepo: callbackRepository,
    }),
  );

  return app;
}
