import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  readHiddenLine,
  type HiddenInput,
  type HiddenOutput,
} from "../src/passphrase.js";

function fakeTty(): {
  input: HiddenInput & PassThrough;
  output: HiddenOutput;
  rawModes: boolean[];
  outputText: () => string;
} {
  const input = new PassThrough() as HiddenInput & PassThrough;
  const output = new PassThrough() as HiddenOutput;
  const rawModes: boolean[] = [];
  const chunks: Buffer[] = [];
  Object.defineProperty(input, "isTTY", { value: true, writable: true });
  Object.defineProperty(input, "isRaw", { value: false, writable: true });
  input.setRawMode = function setRawMode(mode: boolean) {
    rawModes.push(mode);
    Object.defineProperty(this, "isRaw", { value: mode, writable: true });
    return this;
  };
  Object.defineProperty(output, "isTTY", { value: true, writable: true });
  output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return {
    input,
    output,
    rawModes,
    outputText: () => Buffer.concat(chunks).toString("utf8"),
  };
}

test("hidden passphrase input does not echo and restores terminal raw mode", async () => {
  const tty = fakeTty();
  const secret = Buffer.from("temporary hidden input", "utf8");
  const pending = readHiddenLine("Passphrase: ", tty.input, tty.output);
  tty.input.write(Buffer.concat([secret, Buffer.from("\r", "utf8")]));
  const result = await pending;
  try {
    assert.deepEqual(result, secret);
    assert.deepEqual(tty.rawModes, [true, false]);
    assert.equal(tty.outputText(), "Passphrase: \n");
    assert.equal(tty.outputText().includes(secret.toString("utf8")), false);
    assert.equal(tty.input.readableFlowing, false);
  } finally {
    result.fill(0);
    secret.fill(0);
  }
});

test("hidden passphrase cancellation fails safely and restores terminal state", async () => {
  const tty = fakeTty();
  const pending = readHiddenLine("Passphrase: ", tty.input, tty.output);
  tty.input.write(Buffer.from([0x03]));
  await assert.rejects(() => pending, /cancelled/u);
  assert.deepEqual(tty.rawModes, [true, false]);
  assert.equal(tty.outputText(), "Passphrase: \n");
  assert.equal(tty.input.readableFlowing, false);
});

test("hidden passphrase backspace removes one complete UTF-8 code point", async () => {
  const tty = fakeTty();
  const pending = readHiddenLine("Passphrase: ", tty.input, tty.output);
  tty.input.write(Buffer.concat([
    Buffer.from("temporary😀", "utf8"),
    Buffer.from([0x7f]),
    Buffer.from(" value\r", "utf8"),
  ]));
  const result = await pending;
  try {
    assert.equal(result.toString("utf8"), "temporary value");
    assert.deepEqual(tty.rawModes, [true, false]);
  } finally {
    result.fill(0);
  }
});
