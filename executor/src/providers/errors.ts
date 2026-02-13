import type { ProviderKind } from "./types.js";

export class ProviderNotFoundError extends Error {
  constructor(kind: ProviderKind) {
    super(`provider not found: ${kind}`);
    this.name = "ProviderNotFoundError";
  }
}
