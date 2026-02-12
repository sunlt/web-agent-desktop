export const SYNC_INCLUDE: readonly string[] = [
  "/workspace/**",
  "/workspace/.agent_data/**",
];

export const SYNC_EXCLUDE: readonly string[] = [
  "/workspace/.codex/**",
  "/workspace/.claude/**",
  "/workspace/.opencode/**",
];
