import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { BridgeError } from "../errors.js";
import { ensurePrivateDirectory } from "../fs-safe.js";
import { dirname } from "node:path";

interface LockRecord {
  version: 1;
  pid: number;
  token: string;
  createdAt: string;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(path: string): Promise<LockRecord | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.token !== "string" ||
      value.token.length < 16 ||
      typeof value.createdAt !== "string"
    ) throw new BridgeError("Agent runtime lock is invalid; refusing unsafe recovery");
    return value as LockRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("Agent runtime lock is invalid; refusing unsafe recovery", {
      cause: error,
    });
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireGuard(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      return await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new BridgeError("Timed out waiting to inspect the agent runtime lock");
      }
      await delay(25);
    }
  }
}

export class AgentRuntimeLock {
  private released = false;

  private constructor(
    private readonly path: string,
    private readonly token: string,
  ) {}

  static async acquire(path: string): Promise<AgentRuntimeLock> {
    await ensurePrivateDirectory(dirname(path));
    const guardPath = `${path}.guard`;
    const guard = await acquireGuard(guardPath);
    const token = randomUUID();
    const record: LockRecord = {
      version: 1,
      pid: process.pid,
      token,
      createdAt: new Date().toISOString(),
    };

    try {
      const current = await readLock(path);
      if (current && processIsAlive(current.pid)) {
        throw new BridgeError("Agent runtime is already active for this identity");
      }
      if (current) await unlink(path);
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return new AgentRuntimeLock(path, token);
    } finally {
      await guard.close().catch(() => undefined);
      await unlink(guardPath).catch(() => undefined);
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const current = await readLock(this.path);
    if (current?.token === this.token) {
      await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
