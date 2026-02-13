import { ProviderNotFoundError } from "./errors.js";
import type { AgentProviderAdapter, ProviderKind } from "./types.js";

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderKind, AgentProviderAdapter>();

  constructor(adapters: readonly AgentProviderAdapter[]) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.kind, adapter);
    }
  }

  get(kind: ProviderKind): AgentProviderAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      throw new ProviderNotFoundError(kind);
    }
    return adapter;
  }

  listKinds(): ProviderKind[] {
    return Array.from(this.adapters.keys());
  }
}
