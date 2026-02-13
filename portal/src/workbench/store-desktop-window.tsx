import type { StoreAppItem } from "./store-types";

interface StoreDesktopWindowProps {
  globalFileUserId: string;
  setGlobalFileUserId: (userId: string) => void;
  storeStatus: "idle" | "loading" | "error";
  storeError: string;
  storeApps: StoreAppItem[];
  activeAppId: string;
  setActiveAppId: (appId: string) => void;
  activeStoreApp: StoreAppItem | null;
  refreshStoreApps: () => Promise<void>;
}

export function StoreDesktopWindow(input: StoreDesktopWindowProps) {
  const {
    globalFileUserId,
    setGlobalFileUserId,
    storeStatus,
    storeError,
    storeApps,
    activeAppId,
    setActiveAppId,
    activeStoreApp,
    refreshStoreApps,
  } = input;

  return (
    <section className="panel window-single-column">
      <h3>应用商店</h3>
      <div className="store-query-row">
        <label>
          userId
          <input
            value={globalFileUserId}
            onChange={(event) => setGlobalFileUserId(event.target.value)}
            placeholder="u-alice"
          />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={storeStatus === "loading" || !globalFileUserId.trim()}
          onClick={() => void refreshStoreApps()}
        >
          {storeStatus === "loading" ? "刷新中..." : "刷新应用"}
        </button>
      </div>

      {storeError ? <p className="error-text panel-error">{storeError}</p> : null}

      <div className="store-list">
        {storeApps.length === 0 ? (
          <p className="muted">当前用户无可见应用</p>
        ) : (
          storeApps.map((app) => (
            <button
              key={app.appId}
              type="button"
              className={`store-item ${activeAppId === app.appId ? "active" : ""}`}
              disabled={!app.canUse}
              onClick={() => setActiveAppId(app.appId)}
              title={app.canUse ? app.appId : "无使用权限"}
            >
              <strong>{app.name}</strong>
              <span>{app.appId}</span>
              <span>{app.canUse ? "可用" : "仅可见"}</span>
            </button>
          ))
        )}
      </div>

      {activeStoreApp ? (
        <div className="store-selection-summary">
          <p className="muted">
            当前绑定应用：<code>{activeStoreApp.appId}</code>
          </p>
          {activeStoreApp.runtimeDefaults ? (
            <>
              <p className="muted">
                provider/model：
                <code>
                  {activeStoreApp.runtimeDefaults.provider} /{" "}
                  {activeStoreApp.runtimeDefaults.model}
                </code>
              </p>
              <p className="muted">
                timeout：
                <code>
                  {activeStoreApp.runtimeDefaults.timeoutMs
                    ? `${activeStoreApp.runtimeDefaults.timeoutMs}ms`
                    : "default"}
                </code>
              </p>
              <p className="muted">
                凭证环境变量：
                <code>
                  {activeStoreApp.runtimeDefaults.credentialEnvKeys.length > 0
                    ? activeStoreApp.runtimeDefaults.credentialEnvKeys.join(", ")
                    : "-"}
                </code>
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
