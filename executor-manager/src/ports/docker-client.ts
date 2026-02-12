export interface DockerClient {
  createWorker(input: { sessionId: string }): Promise<string>;
  start(containerId: string): Promise<void>;
  stop(containerId: string): Promise<void>;
  remove(containerId: string, options?: { force?: boolean }): Promise<void>;
  exists(containerId: string): Promise<boolean>;
}
