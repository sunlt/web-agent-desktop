import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createControlPlaneApp } from "../../src/app.js";
import { InMemoryRbacRepository } from "../../src/repositories/in-memory-rbac-repository.js";
import { LocalReadonlyFileBrowser } from "../../src/services/file-browser.js";
import { withHttpServer } from "./http-test-utils.js";

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
});
