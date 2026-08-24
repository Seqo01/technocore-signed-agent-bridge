const CAPABILITY_ROOM = /\b(?:mb-)?p-[a-z0-9_-]{8,}\b/giu;
const PRIVATE_KEY_PEM = /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/gu;

export function redactSecrets(input: string, secrets: readonly string[] = []): string {
  let output = input;
  const ordered = [...new Set(secrets.filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
  for (const secret of ordered) {
    output = output.split(secret).join("[REDACTED_SECRET]");
    output = output
      .split(encodeURIComponent(secret))
      .join("[REDACTED_SECRET]");
  }
  return output
    .replace(PRIVATE_KEY_PEM, "[REDACTED_PRIVATE_KEY]")
    .replace(CAPABILITY_ROOM, "[REDACTED_CAPABILITY]");
}

export function safeErrorMessage(
  error: unknown,
  secrets: readonly string[] = [],
): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message, secrets);
}

export function abbreviatePublicDid(did: string): string {
  const marker = "did:key:";
  if (!did.startsWith(marker) || did.length < marker.length + 12) return did;
  const key = did.slice(marker.length);
  return `${marker}${key.slice(0, 8)}…${key.slice(-6)}`;
}
