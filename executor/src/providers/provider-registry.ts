import { ProviderNotFoundError } from "./errors.js";
import {
  normalizeProviderKind,
  type AgentProviderAdapter,
  type CanonicalProviderKind,
  type ProviderKind,
} from "./types.js";

export class ProviderRegistry {
  private readonly adapters = new Map<CanonicalProviderKind, AgentProviderAdapter>();

  constructor(adapters: readonly AgentProviderAdapter[]) {
    for (const adapter of adapters) {
      this.adapters.set(normalizeProviderKind(adapter.kind), adapter);
    }
  }

  get(kind: ProviderKind): AgentProviderAdapter {
    const adapter = this.adapters.get(normalizeProviderKind(kind));
    if (!adapter) {
      throw new ProviderNotFoundError(kind);
    }
    return adapter;
  }

  listKinds(): CanonicalProviderKind[] {
    return Array.from(this.adapters.keys());
  }
}
