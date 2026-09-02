import { BridgeError } from "../errors.js";
import { collaborationWorkload } from "./collaboration.js";
import { engineeringWorkload } from "./engineering.js";
import { researchWorkload } from "./research.js";
import { reviewWorkload } from "./review.js";
import { specialistWorkload } from "./specialist.js";
import { coordinationWorkload } from "./coordination.js";
import type { WorkloadDefinition } from "./types.js";

type RegisteredWorkload = WorkloadDefinition<any, any>;

export class WorkloadRegistry {
  private readonly definitions = new Map<string, RegisteredWorkload>();

  constructor(definitions: RegisteredWorkload[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: RegisteredWorkload): void {
    if (this.definitions.has(definition.taskType)) {
      throw new BridgeError(`Workload task type ${definition.taskType} is already registered`);
    }
    this.definitions.set(definition.taskType, definition);
  }

  has(taskType: string): boolean {
    return this.definitions.has(taskType);
  }

  require(taskType: string): RegisteredWorkload {
    const definition = this.definitions.get(taskType);
    if (!definition) throw new BridgeError(`Unsupported safe agent task type ${taskType}`);
    return definition;
  }
}

export function createDefaultWorkloadRegistry(): WorkloadRegistry {
  return new WorkloadRegistry([
    researchWorkload,
    engineeringWorkload,
    collaborationWorkload,
    reviewWorkload,
    specialistWorkload,
    coordinationWorkload,
  ]);
}
