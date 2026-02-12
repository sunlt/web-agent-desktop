import http from "node:http";
import https from "node:https";
const HOP_BY_HOP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
]);
const HTTP_AGENT = new http.Agent({ keepAlive: true });
const HTTPS_AGENT = new https.Agent({ keepAlive: true });
export function createProxyHandler(target) {
    return (req, res, _next) => {
        const upstreamUrl = new URL(req.originalUrl, ensureTrailingSlash(target.baseUrl));
        const client = upstreamUrl.protocol === "https:" ? https : http;
        const headers = buildForwardHeaders(req, upstreamUrl.host);
        const proxyReq = client.request({
            protocol: upstreamUrl.protocol,
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port,
            path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
            method: req.method,
            headers,
            timeout: target.timeoutMs,
            agent: upstreamUrl.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT,
        });
        proxyReq.on("response", (proxyRes) => {
            res.status(proxyRes.statusCode ?? 502);
            for (const [key, value] of Object.entries(proxyRes.headers)) {
                if (value !== undefined) {
                    res.setHeader(key, value);
                }
            }
            proxyRes.pipe(res);
        });
        proxyReq.on("timeout", () => {
            proxyReq.destroy(new Error("upstream timeout"));
        });
        proxyReq.on("error", (error) => {
            if (res.headersSent) {
                res.end();
                return;
            }
            res.status(502).json({
                error: "gateway_upstream_error",
                upstream: target.name,
                message: error.message,
            });
        });
        req.pipe(proxyReq);
    };
}
function buildForwardHeaders(req, host) {
    const headers = { ...req.headers };
    headers.host = host;
    for (const header of HOP_BY_HOP_HEADERS) {
        delete headers[header];
    }
    const remoteAddress = req.socket.remoteAddress ?? "";
    const existedForward = req.headers["x-forwarded-for"];
    headers["x-forwarded-for"] = appendForwardedFor(existedForward, remoteAddress);
    headers["x-forwarded-host"] = req.headers.host ?? "";
    headers["x-forwarded-proto"] = req.protocol;
    return headers;
}
function appendForwardedFor(existed, remoteAddress) {
    if (typeof existed === "string" && existed.length > 0) {
        return `${existed}, ${remoteAddress}`;
    }
    if (Array.isArray(existed) && existed.length > 0) {
        return `${existed.join(", ")}, ${remoteAddress}`;
    }
    return remoteAddress;
}
function ensureTrailingSlash(url) {
    return url.endsWith("/") ? url : `${url}/`;
}
