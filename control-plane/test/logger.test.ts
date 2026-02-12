import { afterEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "../src/observability/logger.js";

describe("Structured Logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("should output json with trace fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger({ component: "test" }).child({
      traceId: "trace-1",
      runId: "run-1",
      sessionId: "sess-1",
      executorId: "ctr-1",
    });

    logger.info("hello", { step: "sync" });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    const payload = JSON.parse(line) as Record<string, unknown>;
    expect(payload.level).toBe("info");
    expect(payload.message).toBe("hello");
    expect(payload.traceId).toBe("trace-1");
    expect(payload.runId).toBe("run-1");
    expect(payload.sessionId).toBe("sess-1");
    expect(payload.executorId).toBe("ctr-1");
    expect(payload.step).toBe("sync");
  });
});
