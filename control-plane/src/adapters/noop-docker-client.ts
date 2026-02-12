import { randomUUID } from "node:crypto";
import type { DockerClient } from "../ports/docker-client.js";

type ContainerState = "running" | "stopped";

export class NoopDockerClient implements DockerClient {
  private readonly containers = new Map<string, ContainerState>();

  async createWorker(): Promise<string> {
    const containerId = `ctr_${randomUUID().slice(0, 12)}`;
    this.containers.set(containerId, "stopped");
    return containerId;
  }

  async start(containerId: string): Promise<void> {
    this.ensure(containerId);
    this.containers.set(containerId, "running");
  }

  async stop(containerId: string): Promise<void> {
    this.ensure(containerId);
    this.containers.set(containerId, "stopped");
  }

  async remove(containerId: string): Promise<void> {
    this.containers.delete(containerId);
  }

  async exists(containerId: string): Promise<boolean> {
    return this.containers.has(containerId);
  }

  private ensure(containerId: string): void {
    if (!this.containers.has(containerId)) {
      throw new Error(`container not found: ${containerId}`);
    }
  }
}
