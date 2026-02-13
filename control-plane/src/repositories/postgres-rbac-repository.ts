import type { Pool } from "pg";
import type {
  FileAuditLogInput,
  RbacRepository,
  RegisterStoreAppInput,
  RegisterStoreAppMember,
  RegisterStoreAppVisibilityRule,
  StoreAppRuntimeConfig,
  StoreAppRuntimeDefaultsView,
  StoreAppView,
} from "./rbac-repository.js";

export class PostgresRbacRepository implements RbacRepository {
  private runtimeProfilesTableEnsured = false;

  constructor(private readonly pool: Pool) {}

  async listStoreAppsForUser(userId: string): Promise<readonly StoreAppView[]> {
    await this.ensureRuntimeProfilesTable();

    const [
      userResult,
      rolesResult,
      appResult,
      ruleResult,
      memberResult,
      runtimeProfileResult,
    ] = await Promise.all([
      this.pool.query<{
        user_id: string;
        department_id: string | null;
      }>(
        `
            SELECT user_id, department_id
            FROM users
            WHERE user_id = $1
          `,
        [userId],
      ),
      this.pool.query<{ role_key: string }>(
        `
            SELECT role_key
            FROM user_role_bindings
            WHERE user_id = $1
          `,
        [userId],
      ),
      this.pool.query<{
        app_id: string;
        name: string;
        enabled: boolean;
      }>(
        `
            SELECT app_id, name, enabled
            FROM apps
            ORDER BY name ASC
          `,
      ),
      this.pool.query<{
        app_id: string;
        scope_type: "all" | "department" | "user";
        scope_value: string | null;
      }>(
        `
            SELECT app_id, scope_type, scope_value
            FROM app_visibility_rules
          `,
      ),
      this.pool.query<{
        app_id: string;
        can_use: boolean;
      }>(
        `
            SELECT app_id, can_use
            FROM app_members
            WHERE user_id = $1
          `,
        [userId],
      ),
      this.pool.query<{
        app_id: string;
        provider: StoreAppRuntimeConfig["provider"];
        model: string;
        timeout_ms: number | null;
        credential_env: unknown;
      }>(
        `
            SELECT app_id, provider, model, timeout_ms, credential_env
            FROM app_runtime_profiles
          `,
      ),
    ]);

    const user = userResult.rows[0] ?? null;
    const roles = new Set(rolesResult.rows.map((item) => item.role_key));
    const isPlatformAdmin = roles.has("platform_admin");

    const ruleByApp = new Map<
      string,
      Array<{ scopeType: "all" | "department" | "user"; scopeValue: string | null }>
    >();
    for (const rule of ruleResult.rows) {
      const list = ruleByApp.get(rule.app_id) ?? [];
      list.push({
        scopeType: rule.scope_type,
        scopeValue: rule.scope_value,
      });
      ruleByApp.set(rule.app_id, list);
    }

    const memberByApp = new Map<string, boolean>();
    for (const member of memberResult.rows) {
      memberByApp.set(member.app_id, member.can_use);
    }

    const runtimeDefaultsByApp = new Map<string, StoreAppRuntimeDefaultsView>();
    for (const profile of runtimeProfileResult.rows) {
      runtimeDefaultsByApp.set(profile.app_id, {
        provider: profile.provider,
        model: profile.model,
        timeoutMs: normalizeTimeoutMs(profile.timeout_ms),
        credentialEnvKeys: Object.keys(asStringRecord(profile.credential_env)).sort((a, b) =>
          a.localeCompare(b),
        ),
      });
    }

    return appResult.rows.map((app) => {
      const rules = ruleByApp.get(app.app_id) ?? [];
      const canView =
        isPlatformAdmin ||
        rules.some((rule) => {
          if (rule.scopeType === "all") {
            return true;
          }
          if (rule.scopeType === "user") {
            return user ? rule.scopeValue === user.user_id : false;
          }
          return user ? rule.scopeValue === user.department_id : false;
        });
      const canUse =
        app.enabled &&
        canView &&
        (isPlatformAdmin || memberByApp.get(app.app_id) === true);

      return {
        appId: app.app_id,
        name: app.name,
        enabled: app.enabled,
        canView,
        canUse,
        runtimeDefaults: runtimeDefaultsByApp.get(app.app_id) ?? null,
      };
    });
  }

  async upsertStoreApp(input: RegisterStoreAppInput): Promise<void> {
    if (input.runtimeDefaults) {
      await this.ensureRuntimeProfilesTable();
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `
          INSERT INTO apps (app_id, name, enabled)
          VALUES ($1, $2, $3)
          ON CONFLICT (app_id)
          DO UPDATE SET
            name = EXCLUDED.name,
            enabled = EXCLUDED.enabled
        `,
        [input.appId, input.name, input.enabled ?? true],
      );

      if (input.visibilityRules) {
        await client.query(
          `
            DELETE FROM app_visibility_rules
            WHERE app_id = $1
          `,
          [input.appId],
        );

        if (input.visibilityRules.length > 0) {
          await this.insertVisibilityRules(
            client,
            input.appId,
            input.visibilityRules,
          );
        }
      }

      if (input.members) {
        await client.query(
          `
            DELETE FROM app_members
            WHERE app_id = $1
          `,
          [input.appId],
        );

        if (input.members.length > 0) {
          await this.insertAppMembers(client, input.appId, input.members);
        }
      }

      if (input.runtimeDefaults) {
        await client.query(
          `
            INSERT INTO app_runtime_profiles (
              app_id,
              provider,
              model,
              timeout_ms,
              credential_env,
              provider_options
            )
            VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
            ON CONFLICT (app_id)
            DO UPDATE SET
              provider = EXCLUDED.provider,
              model = EXCLUDED.model,
              timeout_ms = EXCLUDED.timeout_ms,
              credential_env = EXCLUDED.credential_env,
              provider_options = EXCLUDED.provider_options,
              updated_at = NOW()
          `,
          [
            input.appId,
            input.runtimeDefaults.provider,
            input.runtimeDefaults.model,
            normalizeTimeoutMs(input.runtimeDefaults.timeoutMs),
            JSON.stringify(asStringRecord(input.runtimeDefaults.credentialEnv)),
            JSON.stringify(asUnknownRecord(input.runtimeDefaults.providerOptions)),
          ],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getStoreAppRuntimeConfig(appId: string): Promise<StoreAppRuntimeConfig | null> {
    await this.ensureRuntimeProfilesTable();

    const result = await this.pool.query<{
      app_id: string;
      provider: StoreAppRuntimeConfig["provider"];
      model: string;
      timeout_ms: number | null;
      credential_env: unknown;
      provider_options: unknown;
    }>(
      `
        SELECT app_id, provider, model, timeout_ms, credential_env, provider_options
        FROM app_runtime_profiles
        WHERE app_id = $1
      `,
      [appId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      appId: row.app_id,
      provider: row.provider,
      model: row.model,
      timeoutMs: normalizeTimeoutMs(row.timeout_ms),
      credentialEnv: asStringRecord(row.credential_env),
      providerOptions: asUnknownRecord(row.provider_options),
    };
  }

  async canReadPath(userId: string, path: string): Promise<boolean> {
    return this.canAccessPath({
      userId,
      path,
      access: "read",
    });
  }

  async canWritePath(userId: string, path: string): Promise<boolean> {
    return this.canAccessPath({
      userId,
      path,
      access: "write",
    });
  }

  async recordFileAudit(input: FileAuditLogInput): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO file_audit_logs (
          user_id,
          action,
          path,
          allowed,
          reason,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        input.userId,
        input.action,
        normalizePath(input.path),
        input.allowed,
        input.reason ?? null,
        input.ts,
      ],
    );
  }

  private async canAccessPath(input: {
    userId: string;
    path: string;
    access: "read" | "write";
  }): Promise<boolean> {
    const { userId, path, access } = input;
    const [rolesResult, policiesResult] = await Promise.all([
      this.pool.query<{ role_key: string }>(
        `
          SELECT role_key
          FROM user_role_bindings
          WHERE user_id = $1
        `,
        [userId],
      ),
      this.pool.query<{
        path_prefix: string;
        principal_type: "all" | "user" | "role";
        principal_id: string | null;
        can_read: boolean;
        can_write: boolean;
      }>(
        `
          SELECT path_prefix, principal_type, principal_id, can_read, can_write
          FROM file_acl_policies
          WHERE $2 LIKE (path_prefix || '%')
        `,
        [userId, normalizePath(path)],
      ),
    ]);

    const roles = new Set(rolesResult.rows.map((item) => item.role_key));
    if (roles.has("platform_admin")) {
      return true;
    }

    return policiesResult.rows.some((policy) => {
      const allowedByPolicy = access === "read" ? policy.can_read : policy.can_write;
      if (!allowedByPolicy) {
        return false;
      }
      if (policy.principal_type === "all") {
        return true;
      }
      if (policy.principal_type === "user") {
        return policy.principal_id === userId;
      }
      return policy.principal_id ? roles.has(policy.principal_id) : false;
    });
  }

  private async insertVisibilityRules(
    client: Pick<Pool, "query">,
    appId: string,
    rules: readonly RegisterStoreAppVisibilityRule[],
  ): Promise<void> {
    for (const rule of rules) {
      await client.query(
        `
          INSERT INTO app_visibility_rules (app_id, scope_type, scope_value)
          VALUES ($1, $2, $3)
        `,
        [appId, rule.scopeType, rule.scopeValue ?? null],
      );
    }
  }

  private async insertAppMembers(
    client: Pick<Pool, "query">,
    appId: string,
    members: readonly RegisterStoreAppMember[],
  ): Promise<void> {
    for (const member of members) {
      await client.query(
        `
          INSERT INTO app_members (app_id, user_id, can_use)
          VALUES ($1, $2, $3)
        `,
        [appId, member.userId, member.canUse],
      );
    }
  }

  private async ensureRuntimeProfilesTable(): Promise<void> {
    if (this.runtimeProfilesTableEnsured) {
      return;
    }
    await this.pool.query(
      `
        CREATE TABLE IF NOT EXISTS app_runtime_profiles (
          app_id TEXT PRIMARY KEY REFERENCES apps(app_id) ON DELETE CASCADE,
          provider TEXT NOT NULL CHECK (
            provider IN ('claude-code', 'opencode', 'codex-cli', 'codex-app-server')
          ),
          model TEXT NOT NULL,
          timeout_ms INTEGER NULL CHECK (timeout_ms IS NULL OR timeout_ms > 0),
          credential_env JSONB NOT NULL DEFAULT '{}'::jsonb,
          provider_options JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
    );
    await this.pool.query(
      `
        CREATE INDEX IF NOT EXISTS idx_app_runtime_profiles_provider_model
          ON app_runtime_profiles (provider, model)
      `,
    );
    this.runtimeProfilesTableEnsured = true;
  }
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function normalizeTimeoutMs(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      continue;
    }
    const normalizedKey = key.trim();
    const normalizedValue = item.trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    output[normalizedKey] = normalizedValue;
  }
  return output;
}

function asUnknownRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}
