import { BridgeError } from "../errors.js";
import { createStores } from "../context.js";
import { hiddenPassphraseProvider } from "../passphrase.js";
import { boundedText } from "../swarm/operator-task.js";
import { SessionStateStore } from "../swarm/session-state.js";
import type { SessionPolicy } from "../swarm/session-policy.js";
import { DashboardController } from "./controller.js";
import { startDashboardServer } from "./server.js";

export async function dashboardCommand(args: string[]): Promise<void> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--policy", "--session", "--port"].includes(key) || !value || options.has(key)) throw new BridgeError("dashboard --policy <file> OR --session <id> [--port <port>]");
    options.set(key, value);
  }
  if (options.has("--policy") === options.has("--session")) throw new BridgeError("Select exactly one existing policy file or session id");
  const root = createStores().paths.root;
  let policy: SessionPolicy;
  try { policy = options.has("--policy") ? JSON.parse(await boundedText(options.get("--policy")!, 32768)) as SessionPolicy :
    (await SessionStateStore.read(root, options.get("--session")!)).policy; }
  catch { throw new BridgeError("Dashboard policy/session could not be loaded"); }
  const port = options.get("--port") ?? "4317";
  if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535) throw new BridgeError("Invalid dashboard port");
  const controller = new DashboardController(root, policy, hiddenPassphraseProvider);
  await controller.view(); // Validate binding before exposing even the read-only projection.
  const app = await startDashboardServer(controller, Number(port));
  console.log(`Local dashboard: ${app.origin}\nOffline deterministic/mock inference — TESTING ONLY. No session started.\nSTART/RESUME unlock prompts appear only in this terminal. Keep it open. Ctrl+C stops the app.`);
  await new Promise<void>(resolve => {
    let closing = false;
    const stop = () => {
      if (closing) return; closing = true;
      void app.close().catch(() => { process.exitCode = 1; console.error("Dashboard shutdown needs inspection; no automatic restart"); })
        .finally(() => { process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(); });
    };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
  });
}
