import { lstat, open, opendir, rename } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { BridgeError } from "../errors.js";
import { ensurePrivateDirectory } from "../fs-safe.js";
import { hashValue } from "../agent/util.js";

/** Bootstrap-local IO. Never searches another bootstrap's staging files or deletes evidence. */
export class BootstrapFiles {
  constructor(readonly root: string) {}

  async check(path: string): Promise<void> {
    const target = resolve(path), rel = relative(this.root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new BridgeError("Bootstrap path outside quarantine");
    const parts = rel.split(/[\\/]/u).filter(Boolean);
    let current = this.root;
    for (const part of ["", ...parts]) {
      if (part) current = resolve(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw new BridgeError("Bootstrap symlink refused"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  async read<T>(path: string, fallback: T, maximum = 512 * 1024): Promise<T> {
    await this.check(path);
    let handle;
    try { handle = await open(path, "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw new BridgeError("Bootstrap state unavailable");
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maximum) throw new Error("bound");
      const bytes = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > maximum) throw new Error("bound");
      return JSON.parse(bytes.subarray(0, length).toString("utf8")) as T;
    } catch { throw new BridgeError("Bootstrap state malformed or exceeds bound"); }
    finally { await handle.close(); }
  }

  private async syncDirectory(path: string): Promise<void> {
    // Windows does not expose portable directory fsync through Node. File fsync is still mandatory.
    if (process.platform === "win32") return;
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async checkpoint(path: string, value: unknown, phase: (name: string) => Promise<void>): Promise<void> {
    await this.check(path); await ensurePrivateDirectory(dirname(path));
    const candidate = `${path}.candidate`;
    await this.check(candidate);
    const handle = await open(candidate, "wx", 0o600);
    try {
      await phase("checkpoint-open");
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await phase("checkpoint-write");
      await handle.sync();
      await phase("checkpoint-fsync");
    } finally { await handle.close(); }
    await phase("checkpoint-before-rename");
    // Caller holds the bootstrap lifecycle lock. Existing final evidence must never be overwritten.
    if (await this.read(path, null) !== null) throw new BridgeError("Bootstrap checkpoint already exists");
    await rename(candidate, path); await this.syncDirectory(dirname(path));
    await phase("checkpoint-rename");
  }

  async recover<T>(path: string, validate: (value: T) => void): Promise<T | null> {
    await this.check(path);
    const names: string[] = [];
    try {
      const directory = await opendir(dirname(path));
      for await (const entry of directory) {
        if (names.length >= 4096) throw new BridgeError("Bootstrap observation directory exceeds bound");
        names.push(entry.name);
      }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const name = path.slice(dirname(path).length + 1);
    // Recognize only this record's candidate and legacy fs-safe names. Unrelated files remain untouched.
    const candidates = names.filter(n => n === `${name}.candidate` ||
      n.startsWith(`${name}.tmp-`) && /^[0-9]+-[a-f0-9]{12}$/u.test(n.slice(`${name}.tmp-`.length)));
    if (candidates.length > 8) throw new BridgeError("Bootstrap checkpoint candidates exceed bound");
    const final = await this.read<T | null>(path, null);
    const values: { path: string; value: T }[] = [];
    if (final !== null) { validate(final); values.push({ path, value: final }); }
    for (const n of candidates) {
      const p = resolve(dirname(path), n), value = await this.read<T | null>(p, null);
      if (value === null) throw new BridgeError("Bootstrap candidate unavailable");
      validate(value); values.push({ path: p, value });
    }
    if (!values.length) return null;
    if (values.some(v => hashValue(v.value) !== hashValue(values[0]!.value))) {
      throw new BridgeError("Conflicting bootstrap checkpoint evidence");
    }
    if (final === null) {
      const selected = values[0]!;
      const handle = await open(selected.path, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(selected.path, path); await this.syncDirectory(dirname(path));
    }
    return values[0]!.value;
  }
}
