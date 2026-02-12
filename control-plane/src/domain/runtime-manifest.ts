export type ConflictPolicy = "keep_session" | "prefer_registry" | "merge";

export type RestoreLayer =
  | "registry_base"
  | "session_overlay"
  | "knowledge_overlay"
  | "user_overlay"
  | "runtime_fixups";

export type CleanupAction = "remove_if_exists" | "truncate_if_exists";

export interface RuntimeManifestSeedFile {
  readonly from: string;
  readonly to: string;
  readonly ifMissingOnly: boolean;
}

export interface RuntimeManifestMountPoint {
  readonly name: "app_kb" | "project_kb" | "user_files" | "agent_data";
  readonly targetPath: string;
  readonly readOnly: boolean;
}

export interface RuntimeManifestCleanupRule {
  readonly action: CleanupAction;
  readonly path: string;
}

export interface RuntimeManifest {
  readonly appId: string;
  readonly runtimeVersion: string;
  readonly workspaceTemplatePrefix: string;
  readonly requiredPaths: readonly string[];
  readonly seedFiles: readonly RuntimeManifestSeedFile[];
  readonly mountPoints: readonly RuntimeManifestMountPoint[];
  readonly conflictPolicy?: ConflictPolicy;
  readonly protectedPaths?: readonly string[];
  readonly cleanupRules: readonly RuntimeManifestCleanupRule[];
}

export interface RestorePlanEntry {
  readonly layer: RestoreLayer;
  readonly fromPrefix: string;
  readonly toPath: string;
  readonly optional: boolean;
}

export interface RestorePlan {
  readonly appId: string;
  readonly runtimeVersion: string;
  readonly workspaceS3Prefix: string;
  readonly conflictPolicy: ConflictPolicy;
  readonly protectedPaths: readonly string[];
  readonly requiredPaths: readonly string[];
  readonly seedFiles: readonly RuntimeManifestSeedFile[];
  readonly mountPoints: readonly RuntimeManifestMountPoint[];
  readonly cleanupRules: readonly RuntimeManifestCleanupRule[];
  readonly entries: readonly RestorePlanEntry[];
}

export interface RequiredPathValidation {
  readonly ok: boolean;
  readonly missingRequiredPaths: readonly string[];
}
