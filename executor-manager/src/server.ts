import { createExecutorManagerApp } from "./app.js";

const port = Number(process.env.EXECUTOR_MANAGER_PORT ?? 3010);
const app = createExecutorManagerApp();

app.listen(port, () => {
  console.info(
    JSON.stringify({
      level: "info",
      ts: new Date().toISOString(),
      component: "executor-manager",
      message: `executor-manager listening on :${port}`,
    }),
  );
});
