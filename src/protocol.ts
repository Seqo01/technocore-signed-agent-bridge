import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { ProtocolError } from "./errors.js";
import { assertTechnocoreName } from "./names.js";
import type { SignedMessage, StoredIdentity } from "./types.js";

// Protocol rules adapted from flop-labs/technocore-chat at commit 8bd794b
// (Apache-2.0) and independently implemented here in TypeScript.
const INVISIBLE_CATEGORY = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;
const DID_PREFIX = "did:key:z";
const ED25519_MULTICODEC = Buffer.from([0xed, 0x01]);
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(
  [...BASE58_ALPHABET].map((character, index) => [character, index]),
);

export const MESSAGE_CHARACTER_LIMIT = 4096;
export const NOTE_CHARACTER_LIMIT = 8192;
export const SIGNATURE_LENGTH = 86;

export function sanitizeText(
  input: string,
  limit = MESSAGE_CHARACTER_LIMIT,
): string {
  let sanitized = "";
  for (const character of input) {
    sanitized += INVISIBLE_CATEGORY.test(character) ? " " : character;
  }
  sanitized = sanitized.trim();
  if (!sanitized) {
    throw new ProtocolError(
      "Nothing visible remained after Technocore single-line sanitization",
    );
  }
  if ([...sanitized].length > limit) {
    throw new ProtocolError(`Sanitized text exceeds the ${limit}-character limit`);
  }
  return sanitized;
}

export function normalizeNonce(nonce: bigint | number | string): string {
  let value: bigint;
  try {
    value = BigInt(nonce);
  } catch (error) {
    throw new ProtocolError("Nonce must be a decimal integer", { cause: error });
  }
  const decimal = value.toString(10);
  if (value < 0n || !/^[0-9]{1,19}$/.test(decimal)) {
    throw new ProtocolError("Nonce must contain 1-19 decimal digits");
  }
  return decimal;
}

export function canonicalMessagePayload(
  room: string,
  nonce: bigint | number | string,
  sanitizedText: string,
): string {
  assertTechnocoreName(room, "room");
  return `${room}|${normalizeNonce(nonce)}|${sanitizedText}`;
}

export function base58Encode(input: Uint8Array): string {
  if (input.length === 0) return "";
  let numeric = BigInt(`0x${Buffer.from(input).toString("hex") || "0"}`);
  let encoded = "";
  while (numeric > 0n) {
    const remainder = Number(numeric % 58n);
    encoded = `${BASE58_ALPHABET[remainder]}${encoded}`;
    numeric /= 58n;
  }
  let zeroes = 0;
  while (zeroes < input.length && input[zeroes] === 0) zeroes += 1;
  return `${"1".repeat(zeroes)}${encoded}`;
}

export function base58Decode(input: string): Buffer {
  let numeric = 0n;
  for (const character of input) {
    const value = BASE58_INDEX.get(character);
    if (value === undefined) throw new ProtocolError("Invalid base58btc character");
    numeric = numeric * 58n + BigInt(value);
  }
  let hex = numeric.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const decoded = numeric === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let zeroes = 0;
  while (zeroes < input.length && input[zeroes] === "1") zeroes += 1;
  return Buffer.concat([Buffer.alloc(zeroes), decoded]);
}

export function publicKeyBytesToDid(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new ProtocolError("Ed25519 public keys must be exactly 32 bytes");
  }
  return `${DID_PREFIX}${base58Encode(Buffer.concat([ED25519_MULTICODEC, publicKey]))}`;
}

export function didToPublicKeyBytes(did: string): Buffer {
  if (!did.startsWith(DID_PREFIX)) {
    throw new ProtocolError("Only Ed25519 did:key identifiers are supported");
  }
  const decoded = base58Decode(did.slice(DID_PREFIX.length));
  if (
    decoded.length !== 34 ||
    !decoded.subarray(0, 2).equals(ED25519_MULTICODEC)
  ) {
    throw new ProtocolError("DID is not an Ed25519 did:key identifier");
  }
  return decoded.subarray(2);
}

export function publicKeyFromDid(did: string) {
  const raw = didToPublicKeyBytes(did);
  return createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: raw.toString("base64url"),
    },
    format: "jwk",
  });
}

export function signMessage(
  identity: StoredIdentity,
  room: string,
  nonce: bigint | number | string,
  text: string,
): SignedMessage {
  const sanitizedText = sanitizeText(text);
  const normalizedNonce = normalizeNonce(nonce);
  const canonicalPayload = canonicalMessagePayload(
    room,
    normalizedNonce,
    sanitizedText,
  );
  const privateKey = createPrivateKey(identity.privateKeyPem);
  const signature = cryptoSign(
    null,
    Buffer.from(canonicalPayload, "utf8"),
    privateKey,
  ).toString("base64url");
  if (signature.length !== SIGNATURE_LENGTH) {
    throw new ProtocolError("Ed25519 signature did not have Technocore's required format");
  }
  const signed = {
    did: identity.did,
    signature,
    nonce: normalizedNonce,
    sanitizedText,
    canonicalPayload,
  };
  if (!verifySignedMessage(room, signed)) {
    throw new ProtocolError("Locally generated signature failed verification");
  }
  return signed;
}

export function verifySignedMessage(
  room: string,
  signed: Pick<
    SignedMessage,
    "did" | "signature" | "nonce" | "sanitizedText"
  >,
): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signed.signature)) return false;
  const canonicalPayload = canonicalMessagePayload(
    room,
    signed.nonce,
    signed.sanitizedText,
  );
  try {
    return cryptoVerify(
      null,
      Buffer.from(canonicalPayload, "utf8"),
      publicKeyFromDid(signed.did),
      Buffer.from(signed.signature, "base64url"),
    );
  } catch {
    return false;
  }
}
