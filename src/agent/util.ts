import { createHash, randomUUID } from "node:crypto";

export type AgentClock = () => Date;
export type AgentIdGenerator = (prefix: string) => string;

export const systemClock: AgentClock = () => new Date();
export const randomId: AgentIdGenerator = (prefix) => `${prefix}_${randomUUID()}`;

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function hashValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function timestamp(clock: AgentClock): string {
  return clock().toISOString();
}

export function assertDecimalString(value: string, label: string): void {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) {
    throw new TypeError(`${label} must be a non-negative decimal string`);
  }
}
