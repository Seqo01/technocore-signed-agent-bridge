import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { SignedAgentBridge } from "./bridge.js";
import { createStores } from "./context.js";
import { BridgeError } from "./errors.js";
import { InMemoryTechnocoreTransport } from "./mock-transport.js";

export interface DemoResult {
  transport: "in-memory-only";
  liveWrites: false;
  task: string;
  workerAcceptedFrom: "coordinator";
  response: string;
  coordinatorAcceptedFrom: "worker";
}

export async function runOfflineDemo(root?: string): Promise<DemoResult> {
  const ownsTemporaryRoot = root === undefined;
  const stateRoot = root ?? await mkdtemp(join(tmpdir(), "technocore-bridge-demo-"));
  const passphrase = randomBytes(32);
  try {
    const { paths: _paths, ...stores } = createStores(
      stateRoot,
      async () => Buffer.from(passphrase),
    );
    const transport = new InMemoryTechnocoreTransport();
    const bridge = new SignedAgentBridge(stores, transport);
    const coordinator = await stores.identities.create("coordinator");
    const worker = await stores.identities.create("worker");
    const coordinatorMailbox = await stores.mailboxes.create("coordinator", coordinator.did);
    const workerMailbox = await stores.mailboxes.create("worker", worker.did);
    await stores.contacts.add("coordinator", "worker", worker.did, workerMailbox.room);
    await stores.contacts.add("worker", "coordinator", coordinator.did, coordinatorMailbox.room);

    const task = "return status: ready";
    await bridge.sendTo("coordinator", "worker", task);
    const workerInbox = await bridge.readInbox("worker");
    const receivedTask = workerInbox.at(-1);
    if (!receivedTask?.serverVerifiedDid || receivedTask.contactId !== "coordinator" || receivedTask.text !== task) {
      throw new BridgeError("Worker rejected the offline coordinator message");
    }

    const response = "status: ready";
    await bridge.sendTo("worker", "coordinator", response);
    const coordinatorInbox = await bridge.readInbox("coordinator");
    const receivedResponse = coordinatorInbox.at(-1);
    if (!receivedResponse?.serverVerifiedDid || receivedResponse.contactId !== "worker" || receivedResponse.text !== response) {
      throw new BridgeError("Coordinator rejected the offline worker response");
    }

    return {
      transport: "in-memory-only",
      liveWrites: false,
      task,
      workerAcceptedFrom: "coordinator",
      response,
      coordinatorAcceptedFrom: "worker",
    };
  } finally {
    passphrase.fill(0);
    if (ownsTemporaryRoot) await rm(stateRoot, { recursive: true, force: true });
  }
}
