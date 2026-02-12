import express, { type Request, type Response } from "express";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  WorkspaceFileBrowser,
  WorkspaceFileError,
} from "./workspace-files.js";
import { execWorkspaceCommand } from "./workspace-terminal.js";

type TodoStatus = "todo" | "doing" | "done" | "canceled";

type RestorePlan = {
  requiredPaths?: string[];
  mountPoints?: Array<{ targetPath: string }>;
  seedFiles?: Array<{ from: string; to: string; ifMissingOnly?: boolean }>;
};

type TraceMeta = {
  traceId?: string;
  operation?: string;
  sessionId?: string;
  executorId?: string;
  runId?: string;
};

type EventItem = {
  ts: string;
  path: string;
  trace: TraceMeta;
};

const app = express();
app.use(express.json({ limit: "2mb" }));

const port = Number(process.env.EXECUTOR_PORT ?? 8090);
const token = (process.env.EXECUTOR_AUTH_TOKEN ?? "").trim();
const workspaceRoot = resolve(
  process.env.EXECUTOR_WORKSPACE_ROOT ?? "/tmp/executor-workspaces",
);
const s3Bucket = process.env.EXECUTOR_S3_BUCKET ?? "app";

const s3Client = new S3Client({
  region: process.env.EXECUTOR_S3_REGION ?? "us-east-1",
  endpoint: process.env.EXECUTOR_S3_ENDPOINT ?? "http://rustfs:9000",
  forcePathStyle: parseBoolean(process.env.EXECUTOR_S3_FORCE_PATH_STYLE, true),
  credentials: {
    accessKeyId: process.env.EXECUTOR_S3_ACCESS_KEY ?? "rustfsadmin",
    secretAccessKey: process.env.EXECUTOR_S3_SECRET_KEY ?? "rustfsadmin",
  },
});

const events: EventItem[] = [];
const maxEvents = 2000;
let ensureBucketPromise: Promise<void> | null = null;

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    bucket: s3Bucket,
  });
});

app.get("/events", (_req, res) => {
  res.json({
    total: events.length,
    items: events,
  });
});

app.post("/workspace/restore", withAuth, async (req, res) => {
  try {
    const body = req.body as {
      containerId?: string;
      plan?: RestorePlan;
    };
    const containerId = requireString(body.containerId, "containerId");
    const root = await ensureWorkspaceRoot(containerId);
    const plan = body.plan ?? {};

    for (const path of plan.requiredPaths ?? []) {
      await mkdir(toWorkspacePath(root, path), { recursive: true });
    }

    for (const mountPoint of plan.mountPoints ?? []) {
      await mkdir(toWorkspacePath(root, mountPoint.targetPath), {
        recursive: true,
      });
    }

    for (const seed of plan.seedFiles ?? []) {
      const filePath = toWorkspacePath(root, seed.to);
      await mkdir(dirname(filePath), { recursive: true });

      if (seed.ifMissingOnly) {
        try {
          await stat(filePath);
          continue;
        } catch {
          // noop
        }
      }

      await writeFile(filePath, `seed:${seed.from}\n`, "utf8");
    }

    recordEvent(req, "/workspace/restore");
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/workspace/link-agent-data", withAuth, async (req, res) => {
  try {
    const body = req.body as { containerId?: string };
    const containerId = requireString(body.containerId, "containerId");
    const root = await ensureWorkspaceRoot(containerId);

    await mkdir(join(root, ".agent_data", "codex"), { recursive: true });
    await mkdir(join(root, ".agent_data", "claude"), { recursive: true });
    await mkdir(join(root, ".agent_data", "opencode"), { recursive: true });

    recordEvent(req, "/workspace/link-agent-data");
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/workspace/validate", withAuth, async (req, res) => {
  try {
    const body = req.body as {
      containerId?: string;
      requiredPaths?: string[];
    };
    const containerId = requireString(body.containerId, "containerId");
    const root = await ensureWorkspaceRoot(containerId);

    const missingRequiredPaths: string[] = [];
    for (const requiredPath of body.requiredPaths ?? []) {
      const path = toWorkspacePath(root, requiredPath);
      try {
        await stat(path);
      } catch {
        missingRequiredPaths.push(requiredPath);
      }
    }

    recordEvent(req, "/workspace/validate");
    res.json({
      ok: missingRequiredPaths.length === 0,
      missingRequiredPaths,
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/workspace/tree", withAuth, async (req, res) => {
  try {
    const containerId = requireString(req.query.containerId, "containerId");
    const path = optionalString(req.query.path) ?? "/workspace";
    const root = await ensureWorkspaceRoot(containerId);
    const browser = new WorkspaceFileBrowser(root);
    const tree = await browser.listTree(path);

    recordEvent(req, "/workspace/tree");
    res.json(tree);
  } catch (error) {
    handleWorkspaceError(res, error);
  }
});

app.get("/workspace/file", withAuth, async (req, res) => {
  try {
    const containerId = requireString(req.query.containerId, "containerId");
    const path = requireString(req.query.path, "path");
    const offset = optionalInteger(req.query.offset);
    const limit = optionalInteger(req.query.limit);

    const root = await ensureWorkspaceRoot(containerId);
    const browser = new WorkspaceFileBrowser(root);
    const file = await browser.readFile(path, {
      ...(typeof offset === "number" ? { offset } : {}),
      ...(typeof limit === "number" ? { limit } : {}),
    });

    recordEvent(req, "/workspace/file:read");
    res.json(file);
  } catch (error) {
    handleWorkspaceError(res, error);
  }
});

app.put("/workspace/file", withAuth, async (req, res) => {
  try {
    const body = req.body as {
      containerId?: string;
      path?: string;
      content?: string;
      encoding?: "utf8" | "base64";
    };

    const containerId = requireString(body.containerId, "containerId");
    const path = requireString(body.path, "path");
    const content = requireString(body.content, "content");

    const root = await ensureWorkspaceRoot(containerId);
    const browser = new WorkspaceFileBrowser(root);
    const result = await browser.writeFile({
      path,
      content,
      encoding: body.encoding,
    });

    recordEvent(req, "/workspace/file:write");
    res.json({ ok: true, ...result });
  } catch (error) {
    handleWorkspaceError(res, error);
  }
});

app.post("/workspace/upload", withAuth, async (req, res) => {
  try {
    const body = req.body as {
      containerId?: string;
      path?: string;
      contentBase64?: string;
    };

    const containerId = requireString(body.containerId, "containerId");
    const path = requireString(body.path, "path");
    const contentBase64 = requireString(body.contentBase64, "contentBase64");

    const root = await ensureWorkspaceRoot(containerId);
    const browser = new WorkspaceFileBrowser(root);
    const result = await browser.writeFile({
      path,
      content: contentBase64,
      encoding: "base64",
    });

    recordEvent(req, "/workspace/upload");
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    handleWorkspaceError(res, error);
  }
});

app.post("/workspace/rename", withAuth, async (req, res) => {
  try {
    const body = req.body as {
      containerId?: string;
      path?: string;
      newPath?: string;
    };

    const containerId = requireString(body.containerId, "containerId");
    const path = requireString(body.path, "path");
    const newPath = requireString(body.newPath, "newPath");

    const root = await ensureWorkspaceRoot(containerId);
    const browser = new WorkspaceFileBrowser(root);
    const result = await browser.rename(path, newPath);

    recordEvent(req, "/workspace/rename");
    res.json({ ok: true, ...result });
  } catch (error) {
    handleWorkspaceError(res, error);
  }
});

app.delete("/workspace/file", withAuth, async (req, res) => {
  try {
    const containerId = requireString(req.query.containerId, "containerId");
    const path = requireString(req.query.path, "path");

    const root = await ensureWorkspaceRoot(containerId);
    const browser = new WorkspaceFileBrowser(root);
    const result = await browser.deletePath(path);

    recordEvent(req, "/workspace/file:delete");
    res.json({ ok: true, ...result });
  } catch (error) {
    handleWorkspaceError(res, error);
  }
});

app.post("/workspace/mkdir", withAuth, async (req, res) => {
  try {
    const body = req.body as {
      containerId?: string;
      path?: string;
    };

    const containerId = requireString(body.containerId, "containerId");
    const path = requireString(body.path, "path");

    const root = await ensureWorkspaceRoot(containerId);
    const browser = new WorkspaceFileBrowser(root);
    const result = await browser.mkdir(path);

    recordEvent(req, "/workspace/mkdir");
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    handleWorkspaceError(res, error);
  }
});

app.get("/workspace/download", withAuth, async (req, res) => {
  try {
    const containerId = requireString(req.query.containerId, "containerId");
    const path = requireString(req.query.path, "path");
    const inline = parseBoolean(optionalString(req.query.inline), false);

    const root = await ensureWorkspaceRoot(containerId);
    const browser = new WorkspaceFileBrowser(root);
    const file = await browser.download(path);

    recordEvent(req, "/workspace/download");
    res.setHeader("content-type", file.contentType);
    res.setHeader(
      "content-disposition",
      `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(file.fileName)}"`,
    );
    res.status(200).send(file.content);
  } catch (error) {
    handleWorkspaceError(res, error);
  }
});

app.post("/tty/exec", withAuth, async (req, res) => {
  try {
    const body = req.body as {
      containerId?: string;
      command?: string;
      cwd?: string;
      timeoutMs?: number;
      maxOutputBytes?: number;
    };

    const containerId = requireString(body.containerId, "containerId");
    const command = requireString(body.command, "command");
    const root = await ensureWorkspaceRoot(containerId);

    const result = await execWorkspaceCommand({
      root,
      command,
      cwd: body.cwd,
      timeoutMs: body.timeoutMs,
      maxOutputBytes: body.maxOutputBytes,
    });

    recordEvent(req, "/tty/exec");
    res.json({ ok: true, ...result });
  } catch (error) {
    handleWorkspaceError(res, error);
  }
});

app.post("/workspace/sync", withAuth, async (req, res) => {
  try {
    const body = req.body as {
      containerId?: string;
      workspaceS3Prefix?: string;
      reason?: string;
      include?: string[];
      exclude?: string[];
      runId?: string;
      todo?: { status: TodoStatus };
    };
    const containerId = requireString(body.containerId, "containerId");
    const prefix = requireString(body.workspaceS3Prefix, "workspaceS3Prefix");
    const root = await ensureWorkspaceRoot(containerId);

    await ensureBucket();
    const files = await listFiles(root);

    for (const file of files) {
      const rel = relative(root, file).replace(/\\/g, "/");
      const key = `${prefix}/${rel}`;
      const data = await readFile(file);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: s3Bucket,
          Key: key,
          Body: data,
        }),
      );
    }

    recordEvent(req, "/workspace/sync");
    res.json({
      ok: true,
      syncedFiles: files.length,
      bucket: s3Bucket,
      prefix,
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.listen(port, () => {
  console.log(`[executor] listening on ${port}`);
});

function withAuth(req: Request, res: Response, next: () => void): void {
  if (!token) {
    next();
    return;
  }

  const auth = req.header("authorization");
  if (auth !== `Bearer ${token}`) {
    res.status(401).json({
      error: "unauthorized",
    });
    return;
  }

  next();
}

function recordEvent(req: Request, path: string): void {
  events.push({
    ts: new Date().toISOString(),
    path,
    trace: {
      traceId: req.header("x-trace-id") ?? undefined,
      operation: req.header("x-trace-operation") ?? undefined,
      sessionId: req.header("x-trace-session-id") ?? undefined,
      executorId: req.header("x-trace-executor-id") ?? undefined,
      runId: req.header("x-trace-run-id") ?? undefined,
    },
  });

  if (events.length > maxEvents) {
    events.splice(0, events.length - maxEvents);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function optionalInteger(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("invalid integer value");
  }
  return Math.max(0, Math.floor(parsed));
}

async function ensureWorkspaceRoot(containerId: string): Promise<string> {
  const root = join(workspaceRoot, containerId, "workspace");
  await mkdir(root, { recursive: true });
  return root;
}

function toWorkspacePath(root: string, workspacePath: string): string {
  if (!workspacePath.startsWith("/workspace")) {
    throw new Error(`invalid workspace path: ${workspacePath}`);
  }
  const relPath = workspacePath.slice("/workspace".length).replace(/^\/+/, "");
  const resolved = resolve(root, relPath);
  const expectedPrefix = `${resolve(root)}${resolved === resolve(root) ? "" : "/"}`;
  if (!(resolved === resolve(root) || resolved.startsWith(expectedPrefix))) {
    throw new Error(`workspace path escapes root: ${workspacePath}`);
  }
  return resolved;
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, files);
  return files;
}

async function walk(path: string, out: string[]): Promise<void> {
  let entries: Array<import("node:fs").Dirent<string>>;
  try {
    entries = await readdir(path, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }

  for (const entry of entries) {
    const abs = join(path, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, out);
      continue;
    }
    if (entry.isFile()) {
      out.push(abs);
    }
  }
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function handleWorkspaceError(res: Response, error: unknown): void {
  if (error instanceof WorkspaceFileError) {
    switch (error.code) {
      case "invalid_path":
      case "not_directory":
        res.status(400).json({
          error: error.message,
          code: error.code,
        });
        return;
      case "not_found":
        res.status(404).json({
          error: error.message,
          code: error.code,
        });
        return;
      case "already_exists":
      case "is_directory":
        res.status(409).json({
          error: error.message,
          code: error.code,
        });
        return;
      default:
        res.status(500).json({
          error: error.message,
          code: error.code,
        });
        return;
    }
  }

  handleError(res, error);
}

function handleError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({
    error: message,
  });
}

async function ensureBucket(): Promise<void> {
  if (!ensureBucketPromise) {
    ensureBucketPromise = (async () => {
      try {
        await s3Client.send(new HeadBucketCommand({ Bucket: s3Bucket }));
      } catch {
        await s3Client.send(new CreateBucketCommand({ Bucket: s3Bucket }));
      }
    })();
  }

  return ensureBucketPromise;
}
