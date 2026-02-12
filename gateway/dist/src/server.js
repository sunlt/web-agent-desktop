import { createGatewayApp } from "./app.js";
const port = Number(process.env.GATEWAY_PORT ?? 3001);
const app = createGatewayApp();
app.listen(port, () => {
    console.info(JSON.stringify({
        level: "info",
        ts: new Date().toISOString(),
        component: "gateway",
        message: `gateway listening on :${port}`,
    }));
});
