import type { Server } from "node:http";
import type { Express } from "express";

export async function withHttpServer(
  app: Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = await listenOnRandomPort(app);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("failed to resolve http server address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await closeServer(server);
  }
}

function listenOnRandomPort(app: Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => resolve(server));
    server.on("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
