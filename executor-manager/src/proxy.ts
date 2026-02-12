import http, { type OutgoingHttpHeaders } from "node:http";
import https from "node:https";
import type { NextFunction, Request, Response } from "express";

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

export interface HttpProxyTarget {
  readonly name: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

export function createProxyHandler(target: HttpProxyTarget) {
  return (req: Request, res: Response, _next: NextFunction): void => {
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
          res.setHeader(key, value as string | string[]);
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
        error: "executor_manager_upstream_error",
        upstream: target.name,
        message: error.message,
      });
    });

    req.pipe(proxyReq);
  };
}

function buildForwardHeaders(req: Request, host: string): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { ...req.headers };

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

function appendForwardedFor(
  existed: string | string[] | undefined,
  remoteAddress: string,
): string {
  if (typeof existed === "string" && existed.length > 0) {
    return `${existed}, ${remoteAddress}`;
  }
  if (Array.isArray(existed) && existed.length > 0) {
    return `${existed.join(", ")}, ${remoteAddress}`;
  }
  return remoteAddress;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
