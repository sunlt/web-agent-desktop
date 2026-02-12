import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DockerClient } from "../ports/docker-client.js";

const execFileAsync = promisify(execFile);

export interface DockerCliClientOptions {
  readonly dockerBinary?: string;
  readonly containerImage?: string;
  readonly containerCommand?: readonly string[];
  readonly network?: string;
  readonly labels?: Record<string, string>;
}

export class DockerCliClient implements DockerClient {
  private readonly dockerBinary: string;
  private readonly containerImage: string;
  private readonly containerCommand: readonly string[];
  private readonly network?: string;
  private readonly labels: Record<string, string>;

  constructor(options: DockerCliClientOptions = {}) {
    this.dockerBinary = options.dockerBinary ?? "docker";
    this.containerImage = options.containerImage ?? "alpine:3.20";
    this.containerCommand = options.containerCommand ?? ["sh", "-c", "sleep infinity"];
    this.network = options.network;
    this.labels = options.labels ?? {};
  }

  async createWorker(input: { sessionId: string }): Promise<string> {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const name = `em-session-${sanitizeName(input.sessionId)}-${suffix}`;

    const args = ["create", "--name", name];
    if (this.network) {
      const resolvedNetwork = await this.resolveNetwork(this.network);
      args.push("--network", resolvedNetwork);
    }

    args.push("--label", "managed-by=executor-manager");
    args.push("--label", `session-id=${input.sessionId}`);
    for (const [key, value] of Object.entries(this.labels)) {
      args.push("--label", `${key}=${value}`);
    }

    args.push(this.containerImage, ...this.containerCommand);
    const stdout = await this.run(args);
    return stdout.trim();
  }

  async start(containerId: string): Promise<void> {
    await this.run(["start", containerId]);
  }

  async stop(containerId: string): Promise<void> {
    await this.run(["stop", containerId]);
  }

  async remove(containerId: string, options?: { force?: boolean }): Promise<void> {
    const args = ["rm"];
    if (options?.force) {
      args.push("-f");
    }
    args.push(containerId);
    await this.run(args);
  }

  async exists(containerId: string): Promise<boolean> {
    try {
      const stdout = await this.run(["inspect", "-f", "{{.Id}}", containerId]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async run(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(this.dockerBinary, args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  private async resolveNetwork(network: string): Promise<string> {
    if (await this.networkExists(network)) {
      return network;
    }
    try {
      const listed = await this.run(["network", "ls", "--format", "{{.Name}}"]);
      const candidates = listed
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      const suffixMatched = candidates.filter((item) => item.endsWith(`_${network}`));
      if (suffixMatched.length === 1) {
        return suffixMatched[0];
      }
    } catch {
      return network;
    }
    return network;
  }

  private async networkExists(network: string): Promise<boolean> {
    try {
      await this.run(["network", "inspect", network]);
      return true;
    } catch {
      return false;
    }
  }
}

function sanitizeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  return normalized.slice(0, 42);
}
