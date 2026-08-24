import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicKey } from "node:crypto";
import { IdentityStore } from "../src/identity.js";
import {
  base58Decode,
  base58Encode,
  canonicalMessagePayload,
  didToPublicKeyBytes,
  publicKeyBytesToDid,
  sanitizeText,
  signMessage,
  verifySignedMessage,
} from "../src/protocol.js";
import { temporaryDirectory } from "./helpers.js";

test("sanitization exactly replaces upstream invisible categories and trims", () => {
  const input = "  a\nb\u200dc\ue000d\ud800e\u2028f\u2029g  ";
  assert.equal(sanitizeText(input), "a b c d e f g");
  assert.equal(sanitizeText("a\u00a0b"), "a\u00a0b", "Zs remains visible inside text");
  assert.throws(() => sanitizeText("\n\u200d\u2028"), /Nothing visible/);
});

test("sanitization character limit counts Unicode code points", () => {
  assert.equal([...sanitizeText("😀".repeat(4096))].length, 4096);
  assert.throws(() => sanitizeText("😀".repeat(4097)), /4096-character/);
});

test("Ed25519 did:key round-trips and signs the sanitized canonical payload", async () => {
  const temporary = await temporaryDirectory();
  try {
    const identities = new IdentityStore(temporary.path);
    await identities.create("alice");
    const identity = await identities.load("alice");
    const raw = didToPublicKeyBytes(identity.did);
    assert.equal(raw.length, 32);
    assert.equal(publicKeyBytesToDid(raw), identity.did);
    assert.deepEqual(base58Decode(base58Encode(raw)), raw);

    const signed = signMessage(identity, "mb-p-0123456789abcdef", "7", " hello\nworld ");
    assert.equal(signed.sanitizedText, "hello world");
    assert.equal(signed.canonicalPayload, canonicalMessagePayload("mb-p-0123456789abcdef", "7", "hello world"));
    assert.match(signed.signature, /^[A-Za-z0-9_-]{86}$/);
    assert.equal(verifySignedMessage("mb-p-0123456789abcdef", signed), true);
    assert.equal(verifySignedMessage("mb-p-0123456789abcdef", { ...signed, sanitizedText: "changed" }), false);

    const key = createPublicKey(identity.publicKeyPem).export({ format: "jwk" });
    assert.equal(Buffer.from(key.x!, "base64url").equals(raw), true);
  } finally {
    await temporary.cleanup();
  }
});

test("nonce syntax follows the server's 1-19 decimal digit rule", () => {
  assert.equal(canonicalMessagePayload("room", "0007", "text"), "room|7|text");
  assert.throws(() => canonicalMessagePayload("room", "10000000000000000000", "text"), /1-19/);
  assert.throws(() => canonicalMessagePayload("room", -1, "text"), /1-19/);
});

test("verifies the official Python server's deterministic seed-1 vector", () => {
  // Derived from technocore-chat tests/_client.py::_keypair and its signed-message contract.
  assert.equal(verifySignedMessage("mb-p-vector", {
    did: "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX",
    signature: "NNztcS8FN7eXgyzlTBd_7MOzDKNOYhpIHsHiqqHO8E3a7o9FSFChX-c2S8dIxO0eTqdwrEiwfnqyCtotaaepDw",
    nonce: "7",
    sanitizedText: "hello world",
  }), true);
});
