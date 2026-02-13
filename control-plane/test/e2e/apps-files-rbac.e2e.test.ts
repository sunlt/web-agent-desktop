import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createControlPlaneApp } from "../../src/app.js";
import type {
  AgentProviderAdapter,
  ProviderRunHandle,
  ProviderRunInput,
  ProviderStreamChunk,
} from "../../src/providers/types.js";
import { InMemoryRbacRepository } from "../../src/repositories/in-memory-rbac-repository.js";
import { LocalReadonlyFileBrowser } from "../../src/services/file-browser.js";
import { withHttpServer } from "./http-test-utils.js";

class CaptureClaudeProviderAdapter implements AgentProviderAdapter {
  readonly kind = "claude-code" as const;
  readonly capabilities = {
    resume: true,
    humanLoop: false,
    todoStream: false,
    buildPlanMode: false,
  };

  public lastInput: ProviderRunInput | null = null;

  async run(input: ProviderRunInput): Promise<ProviderRunHandle> {
    this.lastInput = input;
    const chunks: ProviderStreamChunk[] = [
      { type: "message.delta", text: "runtime-profile-ok" },
      { type: "run.finished", status: "succeeded" },
    ];
    return {
      stream: async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
      stop: async () => {},
    };
  }
}

describe("Apps + Files RBAC E2E", () => {
  let rootDir = "";

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "cp-rbac-"));
    await mkdir(join(rootDir, "workspace", "public"), { recursive: true });
    await mkdir(join(rootDir, "workspace", "private"), { recursive: true });
    await writeFile(
      join(rootDir, "workspace", "public", "readme.txt"),
      "hello-public",
      "utf8",
    );
    await writeFile(
      join(rootDir, "workspace", "private", "secret.txt"),
      "hello-secret",
      "utf8",
    );
  });

  afterAll(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("should enforce app visibility/use and file read permissions", async () => {
    const rbac = new InMemoryRbacRepository();
    rbac.addUser({ userId: "u-alice", departmentId: "dep-eng" });
    rbac.bindUserRole({ userId: "u-alice", roleKey: "member" });

    rbac.addApp({ appId: "app-eng", name: "Eng App", enabled: true });
    rbac.addApp({ appId: "app-sales", name: "Sales App", enabled: true });
    rbac.addApp({ appId: "app-public", name: "Public App", enabled: true });

    rbac.addVisibilityRule({
      appId: "app-eng",
      scope: "department",
      value: "dep-eng",
    });
    rbac.addVisibilityRule({
      appId: "app-sales",
      scope: "department",
      value: "dep-sales",
    });
    rbac.addVisibilityRule({
      appId: "app-public",
      scope: "all",
    });

    rbac.addAppMember({
      appId: "app-eng",
      userId: "u-alice",
      canUse: true,
    });

    rbac.addFilePolicy({
      pathPrefix: "/workspace/public",
      principalType: "user",
      principalId: "u-alice",
      canRead: true,
    });

    const app = createControlPlaneApp({
      rbacRepository: rbac,
      fileBrowser: new LocalReadonlyFileBrowser(rootDir),
    });

    await withHttpServer(app, async (baseUrl) => {
      const store = await fetch(`${baseUrl}/api/apps/store?userId=u-alice`);
      expect(store.status).toBe(200);
      const storeBody = (await store.json()) as {
        total: number;
        apps: Array<{ appId: string; canView: boolean; canUse: boolean }>;
      };

      expect(storeBody.total).toBe(2);
      expect(storeBody.apps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            appId: "app-eng",
            canView: true,
            canUse: true,
          }),
          expect.objectContaining({
            appId: "app-public",
            canView: true,
            canUse: false,
          }),
        ]),
      );

      const tree = await fetch(
        `${baseUrl}/api/files/tree?userId=u-alice&path=${encodeURIComponent("/workspace/public")}`,
      );
      expect(tree.status).toBe(200);
      const treeBody = (await tree.json()) as {
        path: string;
        entries: Array<{ name: string }>;
      };
      expect(treeBody.path).toBe("/workspace/public");
      expect(treeBody.entries.some((item) => item.name === "readme.txt")).toBe(true);

      const downloadOk = await fetch(
        `${baseUrl}/api/files/download?userId=u-alice&path=${encodeURIComponent("/workspace/public/readme.txt")}`,
      );
      expect(downloadOk.status).toBe(200);
      expect(await downloadOk.text()).toBe("hello-public");

      const downloadForbidden = await fetch(
        `${baseUrl}/api/files/download?userId=u-alice&path=${encodeURIComponent("/workspace/private/secret.txt")}`,
      );
      expect(downloadForbidden.status).toBe(403);
    });

    const audit = rbac.getAuditLogs();
    expect(audit.length).toBe(3);
    expect(audit.some((item) => item.allowed === false)).toBe(true);
  });

  test("should enforce file write permissions and persist mutations", async () => {
    const rbac = new InMemoryRbacRepository();
    rbac.addUser({ userId: "u-alice", departmentId: "dep-eng" });
    rbac.bindUserRole({ userId: "u-alice", roleKey: "member" });

    rbac.addFilePolicy({
      pathPrefix: "/workspace/public",
      principalType: "user",
      principalId: "u-alice",
      canRead: true,
      canWrite: true,
    });

    const app = createControlPlaneApp({
      rbacRepository: rbac,
      fileBrowser: new LocalReadonlyFileBrowser(rootDir),
    });

    await withHttpServer(app, async (baseUrl) => {
      const writeResponse = await fetch(`${baseUrl}/api/files/file`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: "u-alice",
          path: "/workspace/public/notes.md",
          content: "# hello from write",
        }),
      });
      expect(writeResponse.status).toBe(200);

      const readResponse = await fetch(
        `${baseUrl}/api/files/file?userId=u-alice&path=${encodeURIComponent("/workspace/public/notes.md")}`,
      );
      expect(readResponse.status).toBe(200);
      const readBody = (await readResponse.json()) as {
        path: string;
        encoding: string;
        content: string;
      };
      expect(readBody.path).toBe("/workspace/public/notes.md");
      expect(readBody.encoding).toBe("utf8");
      expect(readBody.content).toContain("hello from write");

      const mkdirResponse = await fetch(`${baseUrl}/api/files/mkdir`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: "u-alice",
          path: "/workspace/public/assets",
        }),
      });
      expect(mkdirResponse.status).toBe(201);

      const uploadResponse = await fetch(`${baseUrl}/api/files/upload`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: "u-alice",
          path: "/workspace/public/assets/raw.bin",
          contentBase64: Buffer.from("binary-content", "utf8").toString("base64"),
        }),
      });
      expect(uploadResponse.status).toBe(201);

      const renameResponse = await fetch(`${baseUrl}/api/files/rename`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: "u-alice",
          path: "/workspace/public/assets/raw.bin",
          newPath: "/workspace/public/assets/raw-renamed.bin",
        }),
      });
      expect(renameResponse.status).toBe(200);

      const renamedDownload = await fetch(
        `${baseUrl}/api/files/download?userId=u-alice&path=${encodeURIComponent("/workspace/public/assets/raw-renamed.bin")}`,
      );
      expect(renamedDownload.status).toBe(200);
      expect(await renamedDownload.text()).toBe("binary-content");

      const deleteResponse = await fetch(
        `${baseUrl}/api/files/file?userId=u-alice&path=${encodeURIComponent("/workspace/public/assets/raw-renamed.bin")}`,
        {
          method: "DELETE",
        },
      );
      expect(deleteResponse.status).toBe(200);

      const deletedRead = await fetch(
        `${baseUrl}/api/files/file?userId=u-alice&path=${encodeURIComponent("/workspace/public/assets/raw-renamed.bin")}`,
      );
      expect(deletedRead.status).toBe(404);

      const forbiddenWrite = await fetch(`${baseUrl}/api/files/file`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: "u-alice",
          path: "/workspace/private/deny.txt",
          content: "forbidden",
        }),
      });
      expect(forbiddenWrite.status).toBe(403);
    });

    const audit = rbac.getAuditLogs();
    expect(audit.some((item) => item.action === "write" && item.allowed)).toBe(true);
    expect(audit.some((item) => item.action === "upload" && item.allowed)).toBe(true);
    expect(audit.some((item) => item.action === "rename" && item.allowed)).toBe(true);
    expect(audit.some((item) => item.action === "delete" && item.allowed)).toBe(true);
    expect(audit.some((item) => item.action === "mkdir" && item.allowed)).toBe(true);
    expect(audit.some((item) => item.action === "write" && !item.allowed)).toBe(true);
  });

  test("should allow app register runtime defaults and apply them on run start", async () => {
    const rbac = new InMemoryRbacRepository();
    rbac.addUser({ userId: "u-alice", departmentId: "dep-eng" });
    rbac.bindUserRole({ userId: "u-alice", roleKey: "member" });

    const provider = new CaptureClaudeProviderAdapter();
    const app = createControlPlaneApp({
      providerAdapters: [provider],
      rbacRepository: rbac,
      fileBrowser: new LocalReadonlyFileBrowser(rootDir),
    });

    await withHttpServer(app, async (baseUrl) => {
      const registerResponse = await fetch(`${baseUrl}/api/apps/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          appId: "app-runtime",
          name: "Runtime Config App",
          enabled: true,
          visibilityRules: [{ scopeType: "all" }],
          members: [{ userId: "u-alice", canUse: true }],
          runtimeDefaults: {
            provider: "claude-code",
            model: "claude-sonnet-4-20250514",
            timeoutMs: 120000,
            credentialEnv: {
              ANTHROPIC_AUTH_TOKEN: "token-value",
              ANTHROPIC_BASE_URL: "https://example.invalid",
            },
            providerOptions: {
              settingSources: ["user", "project"],
            },
          },
        }),
      });
      expect(registerResponse.status).toBe(201);

      const storeResponse = await fetch(`${baseUrl}/api/apps/store?userId=u-alice`);
      expect(storeResponse.status).toBe(200);
      const storeBody = (await storeResponse.json()) as {
        apps: Array<{
          appId: string;
          runtimeDefaults: {
            provider: string;
            model: string;
            timeoutMs: number | null;
            credentialEnvKeys: string[];
          } | null;
        }>;
      };
      const registeredApp = storeBody.apps.find((item) => item.appId === "app-runtime");
      expect(registeredApp).toBeTruthy();
      expect(registeredApp?.runtimeDefaults).toEqual({
        provider: "claude-code",
        model: "claude-sonnet-4-20250514",
        timeoutMs: 120000,
        credentialEnvKeys: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
      });

      const runResponse = await fetch(`${baseUrl}/api/runs/start`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          runId: "run-app-runtime-1",
          provider: "opencode",
          model: "openai/gpt-5.1-codex",
          executionProfile: "app-runtime",
          messages: [{ role: "user", content: "hello-runtime" }],
          providerOptions: {
            timeoutMs: 90000,
            env: {
              ANTHROPIC_BASE_URL: "https://override.example.invalid",
            },
          },
        }),
      });
      expect(runResponse.status).toBe(200);
      const runBody = (await runResponse.json()) as {
        accepted: boolean;
      };
      expect(runBody.accepted).toBe(true);

      expect(provider.lastInput?.provider).toBe("claude-code");
      expect(provider.lastInput?.model).toBe("claude-sonnet-4-20250514");
      expect(provider.lastInput?.providerOptions).toMatchObject({
        timeoutMs: 90000,
        settingSources: ["user", "project"],
        env: {
          ANTHROPIC_AUTH_TOKEN: "token-value",
          ANTHROPIC_BASE_URL: "https://override.example.invalid",
        },
      });
    });
  });
});
