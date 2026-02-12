import type {
  ConflictPolicy,
  RequiredPathValidation,
  RestorePlan,
  RuntimeManifest,
} from "../domain/runtime-manifest.js";
import { workspaceS3Prefix, type WorkspacePathInput } from "./workspace-path.js";

export interface RestorePlanInput extends WorkspacePathInput {
  readonly runtimeVersion: string;
  readonly manifest: RuntimeManifest;
}

export class RestorePlanValidationError extends Error {
  constructor(
    message: string,
    readonly details: {
      readonly field: string;
      readonly value: string;
    },
  ) {
    super(message);
    this.name = "RestorePlanValidationError";
  }
}

const DEFAULT_CONFLICT_POLICY: ConflictPolicy = "keep_session";
const PROJECT_DEFAULT = "default";

export function buildRestorePlan(input: RestorePlanInput): RestorePlan {
  const workspacePrefix = workspaceS3Prefix(input);
  const manifest = normalizeManifest(input.manifest, input.runtimeVersion);
  const project = input.projectName?.trim() || PROJECT_DEFAULT;

  return {
    appId: manifest.appId,
    runtimeVersion: manifest.runtimeVersion,
    workspaceS3Prefix: workspacePrefix,
    conflictPolicy: manifest.conflictPolicy,
    protectedPaths: manifest.protectedPaths,
    requiredPaths: manifest.requiredPaths,
    seedFiles: manifest.seedFiles,
    mountPoints: manifest.mountPoints,
    cleanupRules: manifest.cleanupRules,
    entries: [
      {
        layer: "registry_base",
        fromPrefix: manifest.workspaceTemplatePrefix,
        toPath: "/workspace",
        optional: false,
      },
      {
        layer: "session_overlay",
        fromPrefix: `${workspacePrefix}/`,
        toPath: "/workspace",
        optional: true,
      },
      {
        layer: "knowledge_overlay",
        fromPrefix: `app/${input.appId}/kb/`,
        toPath: "/workspace/.kb/app",
        optional: true,
      },
      {
        layer: "knowledge_overlay",
        fromPrefix: `app/${input.appId}/project/${project}/kb/`,
        toPath: "/workspace/.kb/project",
        optional: true,
      },
      {
        layer: "user_overlay",
        fromPrefix: `app/${input.appId}/project/${project}/${input.userLoginName}/files/`,
        toPath: "/workspace/.user-files",
        optional: true,
      },
      {
        layer: "runtime_fixups",
        fromPrefix: "runtime://link-agent-data",
        toPath: "/workspace/.agent_data",
        optional: false,
      },
    ],
  };
}

export function validateRequiredPaths(
  requiredPaths: readonly string[],
  existingPaths: readonly string[],
): RequiredPathValidation {
  const normalizedExisting = new Set(existingPaths.map(normalizePath));
  const missing = requiredPaths
    .map(normalizePath)
    .filter((requiredPath) => !normalizedExisting.has(requiredPath));

  return {
    ok: missing.length === 0,
    missingRequiredPaths: missing,
  };
}

function normalizeManifest(
  manifest: RuntimeManifest,
  requestedRuntimeVersion: string,
): {
  appId: string;
  runtimeVersion: string;
  workspaceTemplatePrefix: string;
  requiredPaths: readonly string[];
  seedFiles: RuntimeManifest["seedFiles"];
  mountPoints: RuntimeManifest["mountPoints"];
  conflictPolicy: ConflictPolicy;
  protectedPaths: readonly string[];
  cleanupRules: RuntimeManifest["cleanupRules"];
} {
  if (manifest.runtimeVersion !== requestedRuntimeVersion) {
    throw new RestorePlanValidationError("runtimeVersion mismatch", {
      field: "runtimeVersion",
      value: `${manifest.runtimeVersion} != ${requestedRuntimeVersion}`,
    });
  }

  validateAbsoluteWorkspacePaths(manifest.requiredPaths, "requiredPaths");
  validateAbsoluteWorkspacePaths(
    manifest.protectedPaths ?? [],
    "protectedPaths",
  );
  validateAbsoluteWorkspacePaths(
    manifest.mountPoints.map((item) => item.targetPath),
    "mountPoints.targetPath",
  );
  validateAbsoluteWorkspacePaths(
    manifest.seedFiles.map((item) => item.to),
    "seedFiles.to",
  );
  validateAbsoluteWorkspacePaths(
    manifest.cleanupRules.map((item) => item.path),
    "cleanupRules.path",
  );

  return {
    appId: manifest.appId,
    runtimeVersion: manifest.runtimeVersion,
    workspaceTemplatePrefix: normalizePrefix(manifest.workspaceTemplatePrefix),
    requiredPaths: manifest.requiredPaths.map(normalizePath),
    seedFiles: manifest.seedFiles.map((item) => ({
      ...item,
      to: normalizePath(item.to),
    })),
    mountPoints: manifest.mountPoints.map((item) => ({
      ...item,
      targetPath: normalizePath(item.targetPath),
    })),
    conflictPolicy: manifest.conflictPolicy ?? DEFAULT_CONFLICT_POLICY,
    protectedPaths: (manifest.protectedPaths ?? []).map(normalizePath),
    cleanupRules: manifest.cleanupRules.map((item) => ({
      ...item,
      path: normalizePath(item.path),
    })),
  };
}

function validateAbsoluteWorkspacePaths(
  paths: readonly string[],
  field: string,
): void {
  for (const rawPath of paths) {
    assertWorkspacePath(rawPath, field);
  }
}

function assertWorkspacePath(rawPath: string, field: string): void {
  const normalized = normalizePath(rawPath);
  if (!normalized.startsWith("/workspace")) {
    throw new RestorePlanValidationError("path must be under /workspace", {
      field,
      value: rawPath,
    });
  }
}

function normalizePath(rawPath: string): string {
  const normalized = rawPath.trim().replace(/\/{2,}/g, "/").replace(/\/$/, "");
  if (!normalized.startsWith("/")) {
    throw new RestorePlanValidationError("path must be absolute", {
      field: "path",
      value: rawPath,
    });
  }
  if (normalized.split("/").includes("..")) {
    throw new RestorePlanValidationError("path cannot contain '..'", {
      field: "path",
      value: rawPath,
    });
  }
  return normalized.length > 0 ? normalized : "/";
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) {
    throw new RestorePlanValidationError("workspaceTemplatePrefix is required", {
      field: "workspaceTemplatePrefix",
      value: prefix,
    });
  }
  return trimmed;
}
