import { BridgeError } from "../errors.js";
import { TechnocorePublicDiscoveryAdapter } from "./adapter.js";
import { defaults, limits, type Limits } from "./model.js";
import { DiscoveryStore } from "./store.js";
import { HttpDiscoveryReadTransport, type DiscoveryReadTransport } from "./transport.js";

interface Options { workspace?: string; transport?: DiscoveryReadTransport; output?: (value: unknown) => void; bounds?: Partial<Limits> }
export async function discoveryCommand(command: string, args: string[], options: Options = {}): Promise<void> {
  const output = options.output ?? ((value: unknown) => console.log(JSON.stringify(value, null, 2)));
  const local = ["discovery:candidates", "discovery:inspect", "discovery:summary"].includes(command);
  const network = ["discovery:rooms", "discovery:events", "discovery:room", "discovery:did"].includes(command);
  const fail = (): never => { throw new BridgeError("Discovery syntax refused; network commands require --read-only-network --origin https://technocore.chat (see DISCOVERY.md)"); };
  if (!local && !network) fail();
  if (local) {
    if (args.length !== (command === "discovery:inspect" ? 1 : 0)) fail();
    const store = new DiscoveryStore(options.workspace ?? process.cwd(), options.bounds);
    output(command === "discovery:inspect" ? await store.inspectCandidate(args[0]!) : command === "discovery:candidates" ? await store.listCandidates() : await store.summary());
    return;
  }
  const positional = command === "discovery:room" || command === "discovery:did" ? 1 : 0;
  if (positional && (!args[0] || args[0].startsWith("--"))) fail();
  let origin: string | undefined; let consent = false; let since = 0;
  const input = { ...options.bounds }; const seen = new Set<string>();
  for (let i = positional; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) fail(); seen.add(flag);
    if (flag === "--read-only-network") consent = true;
    else if (flag === "--origin") origin = args[++i] ?? fail();
    else if (flag === "--limit" && command !== "discovery:did") {
      const value = args[++i]; if (!value || !/^[1-9]\d*$/u.test(value)) fail();
      if (command === "discovery:rooms") input.rooms = Number(value); else input.events = Number(value);
    } else if (flag === "--since" && ["discovery:room", "discovery:events"].includes(command)) {
      const value = args[++i]; if (!value || !/^(0|[1-9]\d{0,14})$/u.test(value)) fail(); since = Number(value);
    } else fail();
  }
  if (!consent || !origin) fail();
  const bounds = limits(input);
  // Validate the exact origin even for injected offline transports.
  const production = new HttpDiscoveryReadTransport(origin!, bounds);
  const store = new DiscoveryStore(options.workspace ?? process.cwd(), bounds);
  const adapter = new TechnocorePublicDiscoveryAdapter(options.transport ?? production, store, bounds);
  output({ access: "READ-ONLY NETWORK ACCESS", method: "GET", origin, maxRequests: command === "discovery:did" ? bounds.requests : 1,
    timeoutMs: bounds.timeoutMs, maxResponseBytes: bounds.responseBytes, automaticRetries: 0,
    operationalMutation: false, defaultMaxCandidates: defaults.candidates });
  const result = command === "discovery:rooms" ? await adapter.discoverRooms() : command === "discovery:events" ? await adapter.discoverEvents(since) :
    command === "discovery:room" ? await adapter.discoverRoom(args[0]!, since) : await adapter.lookupDidMetadata(args[0]!);
  output(result);
}
