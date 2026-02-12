import { describe, expect, test } from "vitest";
import { ClaudeCodeProviderAdapter } from "../src/providers/claude-code-provider.js";
import { CodexCliProviderAdapter } from "../src/providers/codex-cli-provider.js";
import { OpencodeProviderAdapter } from "../src/providers/opencode-provider.js";
import { ProviderRegistry } from "../src/providers/provider-registry.js";

describe("ProviderRegistry", () => {
  test("should return adapter by provider kind", () => {
    const registry = new ProviderRegistry([
      new OpencodeProviderAdapter(),
      new ClaudeCodeProviderAdapter(),
      new CodexCliProviderAdapter(),
    ]);

    const adapter = registry.get("opencode");
    expect(adapter.kind).toBe("opencode");
  });

  test("should expose all registered provider kinds", () => {
    const registry = new ProviderRegistry([
      new OpencodeProviderAdapter(),
      new ClaudeCodeProviderAdapter(),
      new CodexCliProviderAdapter(),
    ]);

    expect(registry.listKinds().sort()).toEqual([
      "claude-code",
      "codex-cli",
      "opencode",
    ]);
  });
});
