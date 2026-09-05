import { readFile } from "node:fs/promises";
import { BridgeError } from "../errors.js";
import { createStores } from "../context.js";
import { hiddenPassphraseProvider } from "../passphrase.js";
import { OutboundExternalWorkCoordinator, type PrepareOutboundExternalWork } from "./outbound-external-work.js";

const commands = new Set([
  "external-work:prepare", "external-work:status", "external-work:authorize", "external-work:send",
  "external-work:receive", "external-work:timeout", "external-work:list",
]);

async function readBoundedInput(path: string): Promise<PrepareOutboundExternalWork> {
  const bytes = await readFile(path);
  if (bytes.length > 65_536) throw new BridgeError("External work input file exceeds bound");
  try { return JSON.parse(bytes.toString("utf8")) as PrepareOutboundExternalWork; }
  catch { throw new BridgeError("External work input file is not valid JSON"); }
}

function requireCount(args: string[], count: number): void {
  if (args.length !== count) throw new BridgeError("Invalid external-work command arguments");
}

export function isOutboundExternalWorkCommand(command: string): boolean { return commands.has(command); }

/** CLI adapter prints only the coordinator's capability-free summary. */
export async function outboundExternalWorkCommand(command: string, args: string[]): Promise<void> {
  if (!commands.has(command)) throw new BridgeError("Unsupported external-work command");
  const live = command === "external-work:send" || command === "external-work:receive";
  const origin = live ? process.env.TECHNOCORE_URL : undefined;
  if (live && !origin) throw new BridgeError("TECHNOCORE_URL is required; no request made");
  const coordinator = new OutboundExternalWorkCoordinator({ root: createStores().paths.root,
    passphrases: hiddenPassphraseProvider, ...(origin ? { origin } : {}) });
  let result;
  if (command === "external-work:list") { requireCount(args, 0); result = await coordinator.list(); }
  else if (command === "external-work:prepare") { requireCount(args, 1); result = await coordinator.prepare(await readBoundedInput(args[0]!)); }
  else if (command === "external-work:status") { requireCount(args, 1); result = await coordinator.status(args[0]!); }
  else if (command === "external-work:authorize") { requireCount(args, 2); result = await coordinator.authorize(args[0]!, args[1]!); }
  else if (command === "external-work:send") { requireCount(args, 2); result = await coordinator.send(args[0]!, args[1]!); }
  else if (command === "external-work:receive") { requireCount(args, 1); result = await coordinator.receive(args[0]!); }
  else { requireCount(args, 1); result = await coordinator.timeout(args[0]!); }
  console.log(JSON.stringify(result, null, 2));
}
