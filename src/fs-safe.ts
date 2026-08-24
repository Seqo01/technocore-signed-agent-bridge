import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { BridgeError } from "./errors.js";

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new BridgeError(`Could not read local state file ${path}`, { cause: error });
  }
}

export async function atomicWriteFile(
  path: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, mode).catch(() => undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function lockIsStale(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return Date.now() - info.mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

export async function withFileLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  await ensurePrivateDirectory(dirname(lockPath));
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${Date.now()}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await lockIsStale(lockPath)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new BridgeError("Timed out waiting for a local state lock");
      }
      await delay(LOCK_WAIT_MS);
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}
