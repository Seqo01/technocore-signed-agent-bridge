import { readFile } from "node:fs/promises";
import { BridgeError } from "../errors.js";
import { createStores } from "../context.js";
import { hiddenPassphraseProvider } from "../passphrase.js";
import { ExternalBootstrapCoordinator, type PrepareExternalBootstrap } from "./external-bootstrap.js";

const commands = new Set([
  "bootstrap:prepare", "bootstrap:status", "bootstrap:list", "bootstrap:authorize",
  "bootstrap:send", "bootstrap:receive", "bootstrap:timeout", "bootstrap:proposal",
]);

function requireCount(args: string[], count: number): void {
  if (args.length !== count) throw new BridgeError("Invalid bootstrap command arguments");
}

async function boundedInput(path: string): Promise<PrepareExternalBootstrap> {
  const bytes = await readFile(path);
  if (bytes.length > 32_768) throw new BridgeError("Bootstrap input file exceeds bound");
  try { return JSON.parse(bytes.toString("utf8")) as PrepareExternalBootstrap; }
  catch { throw new BridgeError("Bootstrap input file is not valid JSON"); }
}

export function isExternalBootstrapCommand(command: string): boolean { return commands.has(command); }

/** CLI output contains only public identifiers and hashes; private capability routes are forbidden by the coordinator. */
export async function externalBootstrapCommand(command: string, args: string[]): Promise<void> {
  if (!commands.has(command)) throw new BridgeError("Unsupported bootstrap command");
  const network = command === "bootstrap:send" || command === "bootstrap:receive";
  const origin = network ? process.env.TECHNOCORE_URL : undefined;
  if (network && !origin) throw new BridgeError("TECHNOCORE_URL is required; no request made");
  const coordinator = new ExternalBootstrapCoordinator({ root: createStores().paths.root,
    discoveryWorkspace: process.cwd(), passphrases: hiddenPassphraseProvider, ...(origin ? { origin } : {}) });
  let result;
  if (command === "bootstrap:list") { requireCount(args, 0); result = await coordinator.list(); }
  else if (command === "bootstrap:prepare") { requireCount(args, 1); result = await coordinator.prepare(await boundedInput(args[0]!)); }
  else if (command === "bootstrap:status") { requireCount(args, 1); result = await coordinator.status(args[0]!); }
  else if (command === "bootstrap:authorize") { requireCount(args, 2); result = await coordinator.authorize(args[0]!, args[1]!); }
  else if (command === "bootstrap:send") { requireCount(args, 2); result = await coordinator.send(args[0]!, args[1]!); }
  else if (command === "bootstrap:receive") { requireCount(args, 1); result = await coordinator.receive(args[0]!); }
  else if (command === "bootstrap:timeout") { requireCount(args, 1); result = await coordinator.timeout(args[0]!); }
  else { requireCount(args, 1); result = await coordinator.proposal(args[0]!); }
  console.log(JSON.stringify(result, null, 2));
}
