import { describe, expect, test } from "vitest";
import { workspaceS3Prefix } from "../src/services/workspace-path.js";

describe("workspaceS3Prefix", () => {
  test("should use default project when project name is empty", () => {
    const value = workspaceS3Prefix({
      appId: "code-assistant",
      projectName: " ",
      userLoginName: "alice",
      sessionId: "sess-1",
    });

    expect(value).toBe(
      "app/code-assistant/project/default/alice/session/sess-1/workspace",
    );
  });

  test("should normalize slash around path segments", () => {
    const value = workspaceS3Prefix({
      appId: "/app-a/",
      projectName: "/proj-a/",
      userLoginName: "/bob/",
      sessionId: "/sess-2/",
    });

    expect(value).toBe("app/app-a/project/proj-a/bob/session/sess-2/workspace");
  });
});
