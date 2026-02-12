export interface WorkspacePathInput {
  readonly appId: string;
  readonly projectName?: string;
  readonly userLoginName: string;
  readonly sessionId: string;
}

export function workspaceS3Prefix(input: WorkspacePathInput): string {
  const project = normalizePathSegment(input.projectName) || "default";
  const appId = requiredSegment(input.appId, "appId");
  const userLoginName = requiredSegment(input.userLoginName, "userLoginName");
  const sessionId = requiredSegment(input.sessionId, "sessionId");

  return `app/${appId}/project/${project}/${userLoginName}/session/${sessionId}/workspace`;
}

function requiredSegment(value: string, field: string): string {
  const normalized = normalizePathSegment(value);
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function normalizePathSegment(value: string | undefined): string {
  return (value ?? "").trim().replace(/^\/+|\/+$/g, "");
}
