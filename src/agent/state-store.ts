import { BridgeError } from "../errors.js";
import { cleanOutbound, outboundDiagnostics } from "../send-diagnostics.js";
import { validateEvidence } from "./evidence.js";
import {
  atomicCreateJson,
  atomicWriteJson,
  pathExists,
  readJsonFile,
  withFileLock,
} from "../fs-safe.js";
import { didToPublicKeyBytes } from "../protocol.js";
import type { PublicIdentity } from "../types.js";
import type {
  AgentCheckpoint,
  AgentGoal,
  AgentRuntimeStatus,
  AgentStateV1,
  AgentTask,
  AgentTaskResult,
  AgentTaskStatus,
  EnqueueTaskInput,
  SafeErrorRecord,
} from "./types.js";
import {
  hashText,
  hashValue,
  randomId,
  systemClock,
  timestamp,
  type AgentClock,
  type AgentIdGenerator,
} from "./util.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneState(state: AgentStateV1): AgentStateV1 {
  return structuredClone(state);
}

function validateState(value: unknown): AgentStateV1 {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.revision)) {
    throw new BridgeError("Agent state has an unsupported local format");
  }
  if (
    !isRecord(value.profile) ||
    typeof value.profile.identityAlias !== "string" ||
    typeof value.profile.did !== "string" ||
    typeof value.profile.createdAt !== "string"
  ) {
    throw new BridgeError("Agent profile has an unsupported local format");
  }
  didToPublicKeyBytes(value.profile.did);
  if (
    !isRecord(value.goals) ||
    !isRecord(value.tasks) ||
    !Array.isArray(value.queue) ||
    !isRecord(value.sessions) ||
    !isRecord(value.checkpoints) ||
    !isRecord(value.runtime) ||
    typeof value.runtime.status !== "string" ||
    typeof value.runtime.updatedAt !== "string"
  ) {
    throw new BridgeError("Agent state has an unsupported local format");
  }
  for (const taskId of value.queue) {
    if (typeof taskId !== "string" || !(taskId in value.tasks)) {
      throw new BridgeError("Agent queue references an invalid task");
    }
  }
  return value as unknown as AgentStateV1;
}

function validateIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new BridgeError(`${label} has an invalid local format`);
  }
  return value;
}

export function safeErrorRecord(error: unknown): SafeErrorRecord {
  const outbound = outboundDiagnostics(error);
  if (outbound) return { name: cleanOutbound(outbound).errorClass,
    messageHash: hashText(error instanceof Error ? error.message : "Outbound failure"), outbound: cleanOutbound(outbound) };
  const name = error instanceof Error && error.name ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return {
    name: name.slice(0, 64),
    ...(typeof code === "string" &&
      /^[A-Za-z0-9._:-]{1,64}$/u.test(code) &&
      !/\b(?:mb-)?p-[a-z0-9_-]{8,}\b/iu.test(code)
      ? { code }
      : {}),
    messageHash: hashText(message),
  };
}

export interface InitializeAgentStateResult {
  state: AgentStateV1;
  created: boolean;
}

export class AgentStateStore {
  constructor(
    readonly path: string,
    private readonly clock: AgentClock = systemClock,
    private readonly ids: AgentIdGenerator = randomId,
  ) {}

  async exists(): Promise<boolean> {
    return pathExists(this.path);
  }

  async initialize(identity: PublicIdentity): Promise<InitializeAgentStateResult> {
    return withFileLock(this.path, async () => {
      if (await pathExists(this.path)) {
        const state = await this.loadUnlocked();
        if (
          state.profile.identityAlias !== identity.name ||
          state.profile.did !== identity.did
        ) {
          throw new BridgeError("Existing agent profile does not match the selected identity DID");
        }
        return { state: cloneState(state), created: false };
      }
      const now = timestamp(this.clock);
      const state: AgentStateV1 = {
        version: 1,
        revision: 0,
        profile: {
          identityAlias: identity.name,
          did: identity.did,
          createdAt: now,
        },
        goals: {},
        tasks: {},
        queue: [],
        sessions: {},
        checkpoints: {},
        runtime: {
          status: "initialized",
          updatedAt: now,
        },
      };
      await atomicCreateJson(this.path, state);
      return { state: cloneState(state), created: true };
    });
  }

  async load(): Promise<AgentStateV1> {
    return cloneState(await this.loadUnlocked());
  }

  private async loadUnlocked(): Promise<AgentStateV1> {
    const value = await readJsonFile<unknown | null>(this.path, null);
    if (value === null) throw new BridgeError("Agent is not initialized for this identity");
    return validateState(value);
  }

  private async update(operation: (state: AgentStateV1, now: string) => void): Promise<AgentStateV1> {
    return withFileLock(this.path, async () => {
      const state = await this.loadUnlocked();
      const now = timestamp(this.clock);
      operation(state, now);
      state.revision += 1;
      state.runtime.updatedAt = now;
      await atomicWriteJson(this.path, state);
      return cloneState(state);
    });
  }

  async addGoal(description: string, id = this.ids("goal")): Promise<AgentGoal> {
    validateIdentifier(id, "goal id");
    if (description.trim().length === 0 || description.length > 4096) {
      throw new BridgeError("Goal description must contain 1-4096 characters");
    }
    const state = await this.update((draft, now) => {
      if (draft.goals[id]) throw new BridgeError(`Goal ${id} already exists`);
      draft.goals[id] = {
        id,
        description,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
    });
    return structuredClone(state.goals[id]!);
  }

  async enqueueTask(input: EnqueueTaskInput): Promise<AgentTask> {
    validateIdentifier(input.idempotencyKey, "task idempotency key");
    const id = validateIdentifier(input.id ?? this.ids("task"), "task id");
    const maxAttempts = input.maxAttempts ?? 1;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new BridgeError("Task maxAttempts must be an integer from 1 through 10");
    }
    if (input.type.length === 0 || input.type.length > 128) {
      throw new BridgeError("Task type has an invalid local format");
    }
    const payload = structuredClone(input.payload ?? {});
    const context = input.context ? validateEvidence(input.context) : undefined;
    let selected!: AgentTask;
    const state = await this.update((draft, now) => {
      const duplicate = Object.values(draft.tasks).find(
        (task) => task.idempotencyKey === input.idempotencyKey,
      );
      if (duplicate) {
        const same =
          duplicate.type === input.type &&
          duplicate.goalId === input.goalId &&
          hashValue(duplicate.payload) === hashValue(payload) &&
          hashValue(duplicate.context ?? null) === hashValue(context ?? null);
        if (!same) throw new BridgeError("Task idempotency key was reused with different input");
        selected = duplicate;
        return;
      }
      if (draft.tasks[id]) throw new BridgeError(`Task ${id} already exists`);
      if (input.goalId && !draft.goals[input.goalId]) {
        throw new BridgeError(`Goal ${input.goalId} does not exist`);
      }
      const checkpoint: AgentCheckpoint = {
        phase: "queued",
        externalEffect: "none",
        updatedAt: now,
      };
      selected = {
        id,
        type: input.type,
        ...(input.goalId ? { goalId: input.goalId } : {}),
        idempotencyKey: input.idempotencyKey,
        status: "pending",
        attempts: 0,
        maxAttempts,
        createdAt: now,
        updatedAt: now,
        payload,
        ...(context ? { context } : {}),
        checkpoint,
      };
      draft.tasks[id] = selected;
      draft.queue.push(id);
      draft.checkpoints[id] = [checkpoint];
    });
    return structuredClone(state.tasks[selected.id]!);
  }

  async claimNextTask(expectedTaskId?: string): Promise<AgentTask | undefined> {
    let selectedId: string | undefined;
    const state = await this.update((draft, now) => {
      selectedId = draft.queue.find((id) => draft.tasks[id]?.status === "pending" &&
        (expectedTaskId === undefined || id === expectedTaskId));
      if (!selectedId) return;
      const task = draft.tasks[selectedId]!;
      task.status = "running";
      task.attempts += 1;
      task.startedAt ??= now;
      task.updatedAt = now;
      task.checkpoint = { phase: "selected", externalEffect: "none", updatedAt: now };
      draft.checkpoints[task.id] ??= [];
      draft.checkpoints[task.id]!.push(task.checkpoint);
      draft.runtime.status = "running";
      draft.runtime.activeTaskId = task.id;
    });
    return selectedId ? structuredClone(state.tasks[selectedId]) : undefined;
  }

  async waitForApproval(taskId: string): Promise<AgentTask> {
    const state = await this.update((draft, now) => {
      const task = draft.tasks[taskId];
      if (!task || task.status !== "running") throw new BridgeError("Task is not running");
      task.status = "awaiting-approval";
      task.checkpoint = { phase: "awaiting-approval", externalEffect: "none", updatedAt: now };
      task.updatedAt = now;
      draft.checkpoints[task.id]!.push(task.checkpoint);
      draft.runtime.status = "idle";
      delete draft.runtime.activeTaskId;
    });
    return structuredClone(state.tasks[taskId]!);
  }

  async resumeAfterApproval(taskId: string): Promise<void> {
    await this.update((draft) => {
      const task = draft.tasks[taskId];
      if (!task || !["pending", "awaiting-approval"].includes(task.status)) {
        throw new BridgeError("Task cannot resume after approval");
      }
      task.status = "pending";
    });
  }

  async checkpointTask(
    taskId: string,
    phase: string,
    externalEffect: AgentCheckpoint["externalEffect"],
  ): Promise<AgentTask> {
    const state = await this.update((draft, now) => {
      const task = draft.tasks[taskId];
      if (!task || task.status !== "running") {
        throw new BridgeError(`Task ${taskId} is not running`);
      }
      const checkpoint = { phase, externalEffect, updatedAt: now };
      task.checkpoint = checkpoint;
      task.updatedAt = now;
      draft.checkpoints[task.id] ??= [];
      draft.checkpoints[task.id]!.push(checkpoint);
    });
    return structuredClone(state.tasks[taskId]!);
  }

  async finishTask(
    taskId: string,
    status: Exclude<AgentTaskStatus, "pending" | "running">,
    options: { result?: AgentTaskResult; error?: SafeErrorRecord } = {},
  ): Promise<AgentTask> {
    const state = await this.update((draft, now) => {
      const task = draft.tasks[taskId];
      if (!task || task.status !== "running") {
        throw new BridgeError(`Task ${taskId} is not running`);
      }
      task.status = status;
      task.updatedAt = now;
      task.finishedAt = now;
      task.checkpoint = {
        phase: status,
        externalEffect: status === "succeeded"
          ? "confirmed"
          : status === "ambiguous"
            ? "possible"
            : "none",
        updatedAt: now,
      };
      if (options.result) task.result = structuredClone(options.result);
      if (options.error) task.error = structuredClone(options.error);
      draft.checkpoints[task.id] ??= [];
      draft.checkpoints[task.id]!.push(task.checkpoint);
      draft.runtime.status = "idle";
      delete draft.runtime.activeTaskId;
    });
    return structuredClone(state.tasks[taskId]!);
  }

  async retryTask(taskId: string, error: SafeErrorRecord): Promise<AgentTask> {
    const state = await this.update((draft, now) => {
      const task = draft.tasks[taskId];
      if (!task || task.status !== "running") {
        throw new BridgeError(`Task ${taskId} is not running`);
      }
      if (task.attempts >= task.maxAttempts) {
        throw new BridgeError(`Task ${taskId} exhausted its retry bound`);
      }
      task.status = "pending";
      task.error = structuredClone(error);
      task.updatedAt = now;
      task.checkpoint = { phase: "retry-pending", externalEffect: "none", updatedAt: now };
      draft.checkpoints[task.id] ??= [];
      draft.checkpoints[task.id]!.push(task.checkpoint);
      draft.runtime.status = "idle";
      delete draft.runtime.activeTaskId;
    });
    return structuredClone(state.tasks[taskId]!);
  }

  async recoverInterruptedTasks(): Promise<{ pending: string[]; ambiguous: string[] }> {
    const pending: string[] = [];
    const ambiguous: string[] = [];
    await this.update((draft, now) => {
      draft.runtime.status = "recovering";
      for (const task of Object.values(draft.tasks)) {
        if (task.status !== "running") continue;
        if (task.checkpoint.externalEffect === "none") {
          task.status = "pending";
          task.checkpoint = { phase: "recovered-pending", externalEffect: "none", updatedAt: now };
          pending.push(task.id);
        } else {
          task.status = "ambiguous";
          task.finishedAt = now;
          task.checkpoint = { phase: "recovered-ambiguous", externalEffect: "possible", updatedAt: now };
          task.error = safeErrorRecord(new BridgeError("Interrupted after a possible external effect"));
          ambiguous.push(task.id);
        }
        task.updatedAt = now;
        draft.checkpoints[task.id] ??= [];
        draft.checkpoints[task.id]!.push(task.checkpoint);
      }
      draft.runtime.status = "idle";
      delete draft.runtime.activeTaskId;
    });
    return { pending, ambiguous };
  }

  async startSession(id = this.ids("session")): Promise<string> {
    validateIdentifier(id, "session id");
    await this.update((draft, now) => {
      if (draft.sessions[id]) throw new BridgeError(`Session ${id} already exists`);
      draft.sessions[id] = { id, startedAt: now, outcome: "running" };
      draft.runtime = {
        status: "idle",
        updatedAt: now,
        activeSessionId: id,
      };
    });
    return id;
  }

  async endSession(id: string, outcome: "clean" | "failed"): Promise<void> {
    await this.update((draft, now) => {
      const session = draft.sessions[id];
      if (!session) throw new BridgeError(`Session ${id} does not exist`);
      session.endedAt = now;
      session.outcome = outcome;
      draft.runtime = {
        status: outcome === "clean" ? "stopped" : "failed",
        updatedAt: now,
      };
    });
  }

  async setRuntimeStatus(status: AgentRuntimeStatus): Promise<void> {
    await this.update((draft) => {
      draft.runtime.status = status;
    });
  }
}
