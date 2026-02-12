import { createControlPlaneApp } from "./app.js";
import { DockerCliClient } from "./adapters/docker-cli-client.js";
import { ExecutorHttpClient } from "./adapters/executor-http-client.js";
import { createPostgresPool } from "./adapters/postgres-pool.js";
import { PostgresRunCallbackRepository } from "./repositories/postgres-run-callback-repository.js";
import { PostgresSessionWorkerRepository } from "./repositories/postgres-session-worker-repository.js";

const usePostgres = process.env.CONTROL_PLANE_STORAGE === "postgres";
const useDockerCli = process.env.CONTROL_PLANE_DOCKER === "cli";
const executorBaseUrl = process.env.EXECUTOR_BASE_URL;

const pool = usePostgres ? createPostgresPool() : null;

const sessionWorkerRepository = pool
  ? new PostgresSessionWorkerRepository(pool)
  : undefined;
const callbackRepository = pool
  ? new PostgresRunCallbackRepository(pool)
  : undefined;

const dockerClient = useDockerCli
  ? new DockerCliClient({
      containerImage:
        process.env.EXECUTOR_CONTAINER_IMAGE ?? "agent-runtime:latest",
      containerCommand: parseCommand(
        process.env.EXECUTOR_CONTAINER_COMMAND_JSON,
      ),
      network: process.env.EXECUTOR_CONTAINER_NETWORK,
    })
  : undefined;

const executorClient = executorBaseUrl
  ? new ExecutorHttpClient({
      baseUrl: executorBaseUrl,
      timeoutMs: Number(process.env.EXECUTOR_TIMEOUT_MS ?? 30_000),
      token: process.env.EXECUTOR_AUTH_TOKEN,
    })
  : undefined;

const app = createControlPlaneApp({
  sessionWorkerRepository,
  callbackRepository,
  dockerClient,
  workspaceSyncClient: executorClient,
  executorClient,
});

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`[control-plane] listening on ${port}`);
});

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
