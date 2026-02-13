import { describe, expect, test } from "vitest";
import { ProviderRegistry } from "../src/providers/provider-registry.js";
import { createScriptedProviderAdapters } from "../src/providers/scripted-provider.js";

describe("ProviderRegistry", () => {
  test("should return adapter by provider kind", () => {
    const registry = new ProviderRegistry(createScriptedProviderAdapters());

    const adapter = registry.get("opencode");
    expect(adapter.kind).toBe("opencode");
  });

  test("should expose all registered provider kinds", () => {
    const registry = new ProviderRegistry(createScriptedProviderAdapters());

    expect(registry.listKinds().sort()).toEqual([
      "claude-code",
      "codex-cli",
      "opencode",
    ]);
  });
});
