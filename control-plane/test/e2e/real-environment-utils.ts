import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const execFileAsync = promisify(execFile);

export interface RustfsContainerHandle {
  readonly containerName: string;
  readonly endpoint: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly stop: () => Promise<void>;
}

export interface ExecutorFixtureHandle {
  readonly mode: "fixture" | "external";
  readonly baseUrl: string;
  readonly bucket: string;
  readonly token?: string;
  readonly getEvents: () => readonly ExecutorFixtureEvent[];
  readonly stop: () => Promise<void>;
}

export interface ExecutorFixtureFailureRule {
  readonly times: number;
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface ExecutorFixtureEvent {
  readonly path: string;
  readonly ts: string;
  readonly traceId?: string;
  readonly operation?: string;
  readonly sessionId?: string;
  readonly executorId?: string;
  readonly runId?: string;
}

export async function startRustfsContainer(): Promise<RustfsContainerHandle> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const containerName = `rustfs-e2e-${suffix}`;
  const accessKey = process.env.RUSTFS_ACCESS_KEY ?? "rustfsadmin";
  const secretKey = process.env.RUSTFS_SECRET_KEY ?? "rustfsadmin";

  await runDocker([
    "run",
    "-d",
    "--name",
    containerName,
    "-P",
    "-e",
    `RUSTFS_ACCESS_KEY=${accessKey}`,
    "-e",
    `RUSTFS_SECRET_KEY=${secretKey}`,
    "rustfs/rustfs:latest",
    "/data",
  ]);

  const endpoint = await resolveMappedEndpoint(containerName, "9000/tcp");
  await waitForRustfs(endpoint);

  return {
    containerName,
    endpoint,
    accessKey,
    secretKey,
    stop: async () => {
      await runDocker(["rm", "-f", containerName], true);
    },
  };
}

export async function startExecutorFixture(input: {
  rustfsEndpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  failureRules?: Partial<
    Record<
      "/workspace/restore" | "/workspace/link-agent-data" | "/workspace/validate" | "/workspace/sync",
      ExecutorFixtureFailureRule
    >
  >;
}): Promise<ExecutorFixtureHandle> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "executor-fixture-"));
  const client = createS3Client({
    endpoint: input.rustfsEndpoint,
    accessKey: input.accessKey,
    secretKey: input.secretKey,
  });
  const failureRules = new Map(
    Object.entries(input.failureRules ?? {}) as Array<
      [
        "/workspace/restore" | "/workspace/link-agent-data" | "/workspace/validate" | "/workspace/sync",
        ExecutorFixtureFailureRule,
      ]
    >,
  );
  const events: ExecutorFixtureEvent[] = [];

  await ensureBucket(client, input.bucket);

  const server = createServer(async (req, res) => {
    try {
      const path = req.url ?? "/";
      if (req.method !== "POST") {
        send(res, 404, { error: "not_found" });
        return;
      }

      const body = await readJson(req);
      events.push({
        path,
        ts: new Date().toISOString(),
        traceId: headerValue(req.headers["x-trace-id"]),
        operation: headerValue(req.headers["x-trace-operation"]),
        sessionId: headerValue(req.headers["x-trace-session-id"]),
        executorId: headerValue(req.headers["x-trace-executor-id"]),
        runId: headerValue(req.headers["x-trace-run-id"]),
      });

      const failure = failureRules.get(
        path as
          | "/workspace/restore"
          | "/workspace/link-agent-data"
          | "/workspace/validate"
          | "/workspace/sync",
      );
      if (failure && failure.times > 0) {
        failureRules.set(path as any, {
          ...failure,
          times: failure.times - 1,
        });
        send(res, failure.status, failure.body);
        return;
      }

      if (path === "/workspace/restore") {
        await handleRestore(workspaceRoot, body);
        send(res, 200, { ok: true });
        return;
      }

      if (path === "/workspace/link-agent-data") {
        await handleLinkAgentData(workspaceRoot, body);
        send(res, 200, { ok: true });
        return;
      }

      if (path === "/workspace/validate") {
        const result = await handleValidate(workspaceRoot, body);
        send(res, 200, result);
        return;
      }

      if (path === "/workspace/sync") {
        await handleSync(workspaceRoot, client, input.bucket, body);
        send(res, 200, { ok: true });
        return;
      }

      send(res, 404, { error: "not_found" });
    } catch (error) {
      send(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await listenServer(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind executor fixture");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    mode: "fixture",
    baseUrl,
    bucket: input.bucket,
    getEvents: () => events.slice(),
    stop: async () => {
      await closeServer(server);
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

export function createS3Client(input: {
  endpoint: string;
  accessKey: string;
  secretKey: string;
}): S3Client {
  return new S3Client({
    region: "us-east-1",
    endpoint: input.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: input.accessKey,
      secretAccessKey: input.secretKey,
    },
  });
}

export async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export async function objectExists(input: {
  client: S3Client;
  bucket: string;
  key: string;
}): Promise<boolean> {
  try {
    await input.client.send(
      new HeadObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

async function handleRestore(workspaceRoot: string, body: any): Promise<void> {
  const containerId = String(body.containerId ?? "");
  const plan = body.plan ?? {};
  const requiredPaths: string[] = Array.isArray(plan.requiredPaths)
    ? plan.requiredPaths
    : [];
  const mountPoints: Array<{ targetPath: string }> = Array.isArray(plan.mountPoints)
    ? plan.mountPoints
    : [];
  const seedFiles: Array<{ to: string }> = Array.isArray(plan.seedFiles)
    ? plan.seedFiles
    : [];

  const root = containerWorkspace(workspaceRoot, containerId);
  await mkdir(root, { recursive: true });

  for (const requiredPath of requiredPaths) {
    await mkdir(toFsPath(root, requiredPath), { recursive: true });
  }

  for (const mountPoint of mountPoints) {
    await mkdir(toFsPath(root, mountPoint.targetPath), { recursive: true });
  }

  for (const seed of seedFiles) {
    const target = toFsPath(root, seed.to);
    await mkdir(dirname(target), { recursive: true });
    try {
      await stat(target);
    } catch {
      await writeFile(target, `seed:${seed.to}\n`, "utf8");
    }
  }
}

async function handleLinkAgentData(workspaceRoot: string, body: any): Promise<void> {
  const containerId = String(body.containerId ?? "");
  const root = containerWorkspace(workspaceRoot, containerId);
  await mkdir(join(root, ".agent_data", "codex"), { recursive: true });
  await mkdir(join(root, ".agent_data", "claude"), { recursive: true });
  await mkdir(join(root, ".agent_data", "opencode"), { recursive: true });
}

async function handleValidate(
  workspaceRoot: string,
  body: any,
): Promise<{ ok: boolean; missingRequiredPaths: string[] }> {
  const containerId = String(body.containerId ?? "");
  const requiredPaths: string[] = Array.isArray(body.requiredPaths)
    ? body.requiredPaths
    : [];
  const root = containerWorkspace(workspaceRoot, containerId);
  const missing: string[] = [];

  for (const requiredPath of requiredPaths) {
    const path = toFsPath(root, requiredPath);
    try {
      await stat(path);
    } catch {
      missing.push(requiredPath);
    }
  }

  return {
    ok: missing.length === 0,
    missingRequiredPaths: missing,
  };
}

async function handleSync(
  workspaceRoot: string,
  client: S3Client,
  bucket: string,
  body: any,
): Promise<void> {
  const containerId = String(body.containerId ?? "");
  const workspaceS3Prefix = String(body.workspaceS3Prefix ?? "");
  const root = containerWorkspace(workspaceRoot, containerId);
  const files = await listFiles(root);

  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, "/");
    const key = `${workspaceS3Prefix}/${rel}`;
    const data = await readFile(file);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: data,
      }),
    );
  }
}

function containerWorkspace(workspaceRoot: string, containerId: string): string {
  if (!containerId.trim()) {
    throw new Error("containerId is required");
  }
  return join(workspaceRoot, containerId, "workspace");
}

function toFsPath(root: string, workspacePath: string): string {
  if (!workspacePath.startsWith("/workspace")) {
    throw new Error(`invalid workspace path: ${workspacePath}`);
  }
  const rel = workspacePath.slice("/workspace".length).replace(/^\/+/, "");
  return join(root, rel);
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, out);
  return out;
}

async function walk(path: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
      continue;
    }
    out.push(full);
  }
}

async function runDocker(args: string[], ignoreError = false): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", args, {
      encoding: "utf8",
    });
    return stdout.trim();
  } catch (error) {
    if (ignoreError) {
      return "";
    }
    throw error;
  }
}

async function resolveMappedEndpoint(
  containerName: string,
  containerPort: string,
): Promise<string> {
  const output = await runDocker(["port", containerName, containerPort]);
  const line = output.split("\n")[0] ?? "";
  const port = Number(line.split(":").at(-1));
  if (!port) {
    throw new Error(`unable to resolve mapped port: ${containerName} ${containerPort}`);
  }
  return `http://127.0.0.1:${port}`;
}

async function waitForRustfs(endpoint: string): Promise<void> {
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const response = await fetch(`${endpoint}/`);
      if (response.status === 403 || response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(500);
  }
  throw new Error(`rustfs not ready: ${endpoint}`);
}

async function readJson(req: import("node:http").IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim().length > 0 ? JSON.parse(raw) : {};
}

function send(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(data));
  res.end(data);
}

async function listenServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
