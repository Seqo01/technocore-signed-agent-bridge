import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function temporaryDirectory(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "technocore-bridge-test-"));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

export function roomFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    room: "public",
    count: 0,
    first_seq: null,
    last_seq: 0,
    messages: [],
    ...overrides,
  };
}
