import { BridgeError } from "../errors.js";
import { coordinationWorkload } from "./coordination.js";

/** Shared evidence synthesis, without granting research peers coordinator authority. */
export const synthesisWorkload = {
  ...coordinationWorkload, id: "synthesis", taskType: "workload.synthesis", evidenceEvent: "synthesis-completed",
  validateInput: (payload: Record<string, unknown>) => {
    if (payload.phase !== "synthesis") throw new BridgeError("Shared synthesis requires synthesis phase");
    return coordinationWorkload.validateInput(payload);
  },
};
