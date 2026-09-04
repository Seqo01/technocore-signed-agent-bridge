import { readFile } from "node:fs/promises";
import { atomicWriteJson, withFileLock } from "../fs-safe.js";
import { BridgeError } from "../errors.js";
import { didToPublicKeyBytes } from "../protocol.js";
import { assertNoSecretLikeOutput } from "../workloads/types.js";
import { hashValue } from "./util.js";
import type { InferenceMetadata, InferenceProvider, InferenceRequest, InferenceResult, SpendMetadata } from "./types.js";

export interface InferenceExecutionContext {
  readonly agentDid: string;
  readonly sessionId: string;
  readonly jobId: string;
  readonly taskId: string;
  readonly rootRequesterDid: string;
  readonly rootOrigin: "internal" | "external";
  readonly rootTrust: "operator-local" | "external-approved";
  readonly workloadType: string;
  readonly workloadVersion: number;
  readonly authorityId: string;
  readonly providerMode: "offline" | "configured";
}
export interface UnitBudget { unit: string; max: string; reservePerAttempt: string }
export interface SpendBudget { asset: string; network: string; max: string; reservePerAttempt: string }
export interface InferenceScopeBudget { maxAttempts: number; usage?: UnitBudget[]; spend?: SpendBudget }
export interface InferenceBudgets {
  session: InferenceScopeBudget;
  agent: InferenceScopeBudget;
  job: InferenceScopeBudget;
}
export type AttemptState = "planned" | "reserved" | "running" | "succeeded" | "failed" | "ambiguous" | "cancelled";
export interface InferenceBinding {
  attemptId: string;
  requestHash: string;
  context: InferenceExecutionContext;
  budgetHash: string;
  provider: string;
  providerMetadataHash?: string;
}
export interface InferenceAttempt extends InferenceBinding {
  version: 1;
  provider: string;
  state: AttemptState;
  history: { state: AttemptState; at: string }[];
  startedAt: string;
  endedAt?: string;
  latencyMs?: number;
  model?: string;
  usage?: Record<string, string>;
  usageStatus: "unknown" | "synthetic" | "provider-reported";
  spend?: SpendMetadata;
  spendStatus: "unknown" | "provider-reported";
  billingStatus?: "unknown" | "pending" | "final";
  resultHash?: string;
  referenceHashes?: { request?: string; session?: string; result?: string };
  error?: "budget-denied" | "provider-timeout" | "provider-error" | "provider-ambiguous" | "invalid-provider-metadata" | "reservation-exceeded";
}
interface Ledger { version: 1; budgetHash: string; budgets: InferenceBudgets; attempts: InferenceAttempt[] }
export interface InferenceAccountingOptions {
  path: string;
  budgets: InferenceBudgets;
  context: (request: Readonly<InferenceRequest>) => InferenceExecutionContext;
  timeoutMs?: number;
  beforeDispatch?: () => Promise<void>;
}

function invalid(): never { throw new BridgeError("Invalid inference accounting data"); }
function safeId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) invalid();
  assertNoSecretLikeOutput(value, "Inference metadata");
  return value;
}
function publicLabel(value: string): string {
  safeId(value);
  if (value.length > 64 || /(?:^|[^0-9])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?:$|[^0-9])/u.test(value)) invalid();
  return value;
}
function hash(value: string): string { if (!/^[a-f0-9]{64}$/u.test(value)) invalid(); return value; }
// Fixed precision decimal arithmetic: never sum economic amounts with IEEE floats.
const SCALE = 10n ** 18n;
function units(value: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,18})?$/u.test(value)) invalid();
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(18, "0"));
}
function decimal(value: bigint): string {
  const whole = value / SCALE, fraction = (value % SCALE).toString().padStart(18, "0").replace(/0+$/u, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}
export function freezeInferenceContext(input: InferenceExecutionContext): InferenceExecutionContext {
  didToPublicKeyBytes(input.agentDid); didToPublicKeyBytes(input.rootRequesterDid);
  if (!["internal", "external"].includes(input.rootOrigin) ||
    input.rootTrust !== (input.rootOrigin === "internal" ? "operator-local" : "external-approved") ||
    !["offline", "configured"].includes(input.providerMode) || !Number.isSafeInteger(input.workloadVersion) || input.workloadVersion < 1) invalid();
  return Object.freeze({ agentDid: input.agentDid, sessionId: safeId(input.sessionId), jobId: safeId(input.jobId),
    taskId: safeId(input.taskId), rootRequesterDid: input.rootRequesterDid, rootOrigin: input.rootOrigin, rootTrust: input.rootTrust,
    workloadType: safeId(input.workloadType), workloadVersion: input.workloadVersion, authorityId: safeId(input.authorityId), providerMode: input.providerMode });
}
export function cleanInferenceBinding(value: InferenceBinding): InferenceBinding {
  return { attemptId: hash(value.attemptId), requestHash: hash(value.requestHash),
    context: freezeInferenceContext(value.context), budgetHash: hash(value.budgetHash), provider: publicLabel(value.provider),
    ...(value.providerMetadataHash ? { providerMetadataHash: hash(value.providerMetadataHash) } : {}) };
}
export function validateInferenceBudgets(input: InferenceBudgets): InferenceBudgets {
  const scope = (b: InferenceScopeBudget): InferenceScopeBudget => {
    if (!b || !Number.isSafeInteger(b.maxAttempts) || b.maxAttempts < 1 || b.maxAttempts > 10000) invalid();
    if (b.usage && (!Array.isArray(b.usage) || b.usage.length > 16 || new Set(b.usage.map(u => u.unit)).size !== b.usage.length)) invalid();
    for (const limit of [...b.usage ?? [], ...b.spend ? [b.spend] : []]) {
      if (units(limit.max) <= 0n || units(limit.reservePerAttempt) <= 0n || units(limit.reservePerAttempt) > units(limit.max)) invalid();
    }
    return { maxAttempts: b.maxAttempts,
      ...(b.usage ? { usage: b.usage.map(u => ({ unit: publicLabel(u.unit), max: u.max, reservePerAttempt: u.reservePerAttempt })) } : {}),
      ...(b.spend ? { spend: { asset: publicLabel(b.spend.asset), network: publicLabel(b.spend.network), max: b.spend.max, reservePerAttempt: b.spend.reservePerAttempt } } : {}) };
  };
  return { session: scope(input.session), agent: scope(input.agent), job: scope(input.job) };
}
export function defaultInferenceBudgets(maxAttempts = 1000): InferenceBudgets {
  return { session: { maxAttempts }, agent: { maxAttempts }, job: { maxAttempts } };
}

/** Whitelist metadata only; opaque provider references are hashes, never response/URL/token strings. */
export function cleanAccountedMetadata(value: InferenceMetadata, mode: "offline" | "configured", provider: string): InferenceMetadata {
  // Multiplexing/local providers may report a different backend name. Attribution
  // remains the host-selected adapter; response fields can never override it.
  publicLabel(value.provider);
  const usage = value.usage ? Object.fromEntries(Object.entries(value.usage).map(([key, amount]) => {
    units(amount); return [publicLabel(key), amount];
  })) : undefined;
  if (usage && Object.keys(usage).length > 16) invalid();
  if (mode === "offline" && value.spend) invalid(); // No fake FLOP or other real spend, including zero.
  if (value.billingStatus !== undefined && (!["unknown", "pending", "final"].includes(value.billingStatus) || (mode === "offline" && value.billingStatus !== "unknown"))) invalid();
  let spend: SpendMetadata | undefined;
  if (value.spend) { units(value.spend.amount); spend = { asset: publicLabel(value.spend.asset), network: publicLabel(value.spend.network), amount: value.spend.amount }; }
  const refs: Record<string, string> = {};
  for (const [key, ref] of Object.entries({ providerRequestId: value.providerRequestId, providerSessionId: value.providerSessionId, providerResultId: value.providerResultId })) {
    if (ref !== undefined) { if (typeof ref !== "string" || ref.length > 4096) invalid(); refs[key] = hashValue(ref); }
  }
  return { provider: publicLabel(provider), model: publicLabel(value.model), ...refs,
    usageStatus: usage ? mode === "offline" ? "synthetic" : "provider-reported" : "unknown",
    spendStatus: spend ? "provider-reported" : "unknown", providerMode: mode,
    ...(value.billingStatus ? { billingStatus: value.billingStatus } : {}),
    ...(usage ? { usage } : {}), ...(spend ? { spend } : {}) };
}

function normalizeAttempt(a: InferenceAttempt): InferenceAttempt {
  const binding = cleanInferenceBinding(a);
  const states: AttemptState[] = ["planned", "reserved", "running", "succeeded", "failed", "ambiguous", "cancelled"];
  if (a.version !== 1 || !states.includes(a.state) || !Array.isArray(a.history) || a.history.length > 4 || !a.history.length ||
    a.history.at(-1)?.state !== a.state || !Number.isFinite(Date.parse(a.startedAt)) ||
    (a.endedAt !== undefined && !Number.isFinite(Date.parse(a.endedAt)))) invalid();
  const expected = a.state === "planned" ? ["planned"] : a.state === "cancelled" ? ["planned", "cancelled"] :
    a.state === "reserved" ? ["planned", "reserved"] : a.state === "running" ? ["planned", "reserved", "running"] : ["planned", "reserved", "running", a.state];
  if (JSON.stringify(a.history.map(h => h.state)) !== JSON.stringify(expected) || a.history.some(h => !Number.isFinite(Date.parse(h.at)))) invalid();
  if (a.latencyMs !== undefined && (!Number.isSafeInteger(a.latencyMs) || a.latencyMs < 0)) invalid();
  if (a.error && !["budget-denied", "provider-timeout", "provider-error", "provider-ambiguous", "invalid-provider-metadata", "reservation-exceeded"].includes(a.error)) invalid();
  if (a.usageStatus !== (a.usage ? a.context.providerMode === "offline" ? "synthetic" : "provider-reported" : "unknown") ||
    a.spendStatus !== (a.spend ? "provider-reported" : "unknown")) invalid();
  const metadata = cleanAccountedMetadata({ provider: a.provider, model: a.model ?? "unknown", ...(a.usage ? { usage: a.usage } : {}), ...(a.spend ? { spend: a.spend } : {}), ...(a.billingStatus ? { billingStatus: a.billingStatus } : {}) }, a.context.providerMode, a.provider);
  if (a.referenceHashes) for (const ref of Object.values(a.referenceHashes)) hash(ref);
  // Reject unknown fields, not just secrets, in local ledger records.
  const clean: InferenceAttempt = { ...binding, version: 1, provider: metadata.provider, state: a.state,
    history: a.history.map(h => ({ state: h.state, at: h.at })), startedAt: a.startedAt,
    usageStatus: a.usageStatus, spendStatus: a.spendStatus,
    ...(a.endedAt !== undefined ? { endedAt: a.endedAt } : {}), ...(a.latencyMs !== undefined ? { latencyMs: a.latencyMs } : {}),
    ...(a.model !== undefined ? { model: metadata.model } : {}), ...(metadata.usage ? { usage: metadata.usage } : {}), ...(metadata.spend ? { spend: metadata.spend } : {}),
    ...(metadata.billingStatus ? { billingStatus: metadata.billingStatus } : {}),
    ...(a.resultHash ? { resultHash: hash(a.resultHash) } : {}), ...(a.referenceHashes ? { referenceHashes: { ...a.referenceHashes } } : {}), ...(a.error ? { error: a.error } : {}) };
  if (hashValue(clean) !== hashValue(a)) invalid();
  return clean;
}

export class InferenceLedger {
  constructor(readonly path: string) {}
  private async load(): Promise<Ledger | undefined> {
    let content: string;
    try { content = await readFile(this.path, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new BridgeError("Inference ledger unavailable"); }
    try {
      const v = JSON.parse(content) as Ledger;
      if (v.version !== 1 || !Array.isArray(v.attempts) || v.attempts.length > 100000 || Object.keys(v).sort().join() !== "attempts,budgetHash,budgets,version") invalid();
      const budgets = validateInferenceBudgets(v.budgets);
      if (hashValue(budgets) !== v.budgetHash) invalid();
      const attempts = v.attempts.map(normalizeAttempt);
      if (new Set(attempts.map(a => a.attemptId)).size !== attempts.length || attempts.some(a => a.budgetHash !== v.budgetHash)) invalid();
      return { version: 1, budgetHash: v.budgetHash, budgets, attempts };
    } catch { throw new BridgeError("Inference ledger invalid; operator inspection required"); }
  }
  async read(): Promise<InferenceAttempt[]> { return structuredClone((await this.load())?.attempts ?? []); }
  async change<T>(budgets: InferenceBudgets, operation: (ledger: Ledger) => Promise<T>): Promise<T> {
    try {
      return await withFileLock(this.path, async () => {
        const budgetHash = hashValue(budgets);
        const data = await this.load() ?? { version: 1, budgetHash, budgets, attempts: [] };
        if (data.budgetHash !== budgetHash) throw new BridgeError("Inference budget policy changed; refused");
        return operation(data);
      });
    } catch { throw new BridgeError("Inference accounting refused; inspect local ledger; no automatic retry"); }
  }
  async save(data: Ledger): Promise<void> {
    data.attempts.forEach(normalizeAttempt);
    await atomicWriteJson(this.path, data);
  }
  /** Pure read: no locks, repair, provider lookup, identity access or network. */
  async summary(filter: { sessionId?: string; agentDid?: string } = {}) {
    const data = await this.load();
    const rows = (data?.attempts ?? []).filter(a => (!filter.sessionId || a.context.sessionId === filter.sessionId) && (!filter.agentDid || a.context.agentDid === filter.agentDid));
    const totals = new Map<string, bigint>();
    const spend = new Map<string, bigint>();
    for (const a of rows) {
      for (const [unit, value] of Object.entries(a.usage ?? {})) {
        const key = `${a.provider}/${a.usageStatus}/${unit}`; totals.set(key, (totals.get(key) ?? 0n) + units(value));
      }
      if (a.spend) { const key = `${a.spend.network}/${a.spend.asset}/provider-reported`; spend.set(key, (spend.get(key) ?? 0n) + units(a.spend.amount)); }
    }
    return { attempts: rows.length, dispatched: rows.filter(a => a.history.some(h => h.state === "running")).length,
      successes: rows.filter(a => a.state === "succeeded").length, failures: rows.filter(a => a.state === "failed").length,
      ambiguous: rows.filter(a => a.state === "ambiguous").length, cancelled: rows.filter(a => a.state === "cancelled").length,
      unresolved: rows.filter(a => ["planned", "reserved", "running", "ambiguous"].includes(a.state)).length,
      liveNetworkInference: "not-attested", offlineAttempts: rows.filter(a => a.context.providerMode === "offline").length,
      usage: Object.fromEntries([...totals].map(([k, v]) => [k, decimal(v)])),
      reportedSpend: Object.fromEntries([...spend].map(([k, v]) => [k, decimal(v)])), verifiedSpend: "unsupported",
      unknownSpendAttempts: rows.filter(a => a.state !== "cancelled" && a.spendStatus === "unknown").length,
      reservations: rows.filter(a => a.state !== "cancelled" && (a.spendStatus === "unknown" || ["reserved", "running", "ambiguous"].includes(a.state) || (a.billingStatus !== undefined && a.billingStatus !== "final")))
        .map(a => ({ attemptId: a.attemptId, scopes: Object.entries(data!.budgets).flatMap(([scope, b]) => b.spend ? [{ scope, asset: b.spend.asset, network: b.spend.network, amount: b.spend.reservePerAttempt }] : []) })),
      agents: [...new Set(rows.map(a => a.context.agentDid))], jobs: [...new Set(rows.map(a => a.context.jobId))], tasks: [...new Set(rows.map(a => a.context.taskId))] };
  }
}

function matching(a: InferenceAttempt, c: InferenceExecutionContext, scope: keyof InferenceBudgets): boolean {
  return a.context.sessionId === c.sessionId && (scope === "session" || (scope === "agent" ? a.context.agentDid === c.agentDid : a.context.jobId === c.jobId));
}
function charge(a: InferenceAttempt, limit: UnitBudget | SpendBudget): bigint {
  const value = "unit" in limit ? a.usage?.[limit.unit] :
    a.spend?.asset === limit.asset && a.spend.network === limit.network ? a.spend.amount : undefined;
  const reserve = units(limit.reservePerAttempt);
  if (value === undefined) return reserve;
  const actual = units(value);
  const pendingBill = !("unit" in limit) && a.billingStatus !== undefined && a.billingStatus !== "final";
  return (["reserved", "running", "ambiguous"].includes(a.state) || pendingBill) && actual < reserve ? reserve : actual;
}

/** Host-only gateway. Model/proposal fields are input data, never authority. */
export class AccountedInferenceProvider implements InferenceProvider {
  readonly name: string;
  readonly ledger: InferenceLedger;
  private readonly budgets: InferenceBudgets;
  private readonly timeoutMs: number;
  constructor(private readonly provider: InferenceProvider, private readonly options: InferenceAccountingOptions) {
    this.name = publicLabel(provider.name); this.ledger = new InferenceLedger(options.path);
    this.budgets = validateInferenceBudgets(structuredClone(options.budgets));
    this.timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000) invalid();
  }
  prepare(request: InferenceRequest): InferenceRequest {
    const c = freezeInferenceContext(this.options.context(Object.freeze({ requestId: request.requestId, taskId: request.taskId, taskType: request.taskType, input: undefined })));
    if (c.taskId !== request.taskId || c.workloadType !== request.taskType) invalid();
    return Object.freeze({ requestId: safeId(request.requestId), taskId: c.taskId, taskType: c.workloadType, input: structuredClone(request.input), executionContext: c });
  }
  async infer(input: InferenceRequest): Promise<InferenceResult> {
    const request = this.prepare(input), context = request.executionContext!;
    if (input.executionContext && hashValue(input.executionContext) !== hashValue(context)) throw new BridgeError("Inference host context mismatch");
    const requestHash = hashValue(request), budgetHash = hashValue(this.budgets);
    const attemptId = hashValue({ context, requestId: request.requestId });
    const binding = cleanInferenceBinding({ attemptId, requestHash, context, budgetHash, provider: this.name });
    const started = Date.now();
    const attempt: InferenceAttempt = { version: 1, ...binding, state: "planned", startedAt: new Date(started).toISOString(),
      history: [{ state: "planned", at: new Date(started).toISOString() }], usageStatus: "unknown", spendStatus: "unknown" };
    const transition = (a: InferenceAttempt, state: AttemptState) => { a.state = state; a.history.push({ state, at: new Date().toISOString() }); };
    const allowed = await this.ledger.change(this.budgets, async data => {
      if (data.attempts.some(a => a.attemptId === attemptId || (matching(a, context, "job") && a.context.taskId === context.taskId && a.context.agentDid === context.agentDid && ["planned", "reserved", "running", "ambiguous"].includes(a.state)))) throw new BridgeError("Inference attempt unresolved or already spent");
      data.attempts.push(attempt); await this.ledger.save(data);
      for (const scope of ["session", "agent", "job"] as const) {
        const b = this.budgets[scope];
        const prior = data.attempts.filter(a => a.attemptId !== attemptId && a.state !== "cancelled" && matching(a, context, scope));
        if (prior.length >= b.maxAttempts || [...b.usage ?? [], ...b.spend ? [b.spend] : []].some(limit =>
          prior.reduce((sum, a) => sum + charge(a, limit), 0n) + units(limit.reservePerAttempt) > units(limit.max))) {
          transition(attempt, "cancelled"); attempt.error = "budget-denied"; attempt.endedAt = new Date().toISOString();
          await this.ledger.save(data); return false;
        }
      }
      transition(attempt, "reserved"); await this.ledger.save(data);
      // Crash here retains reservation. No provider call occurs before the durable running intent.
      transition(attempt, "running"); await this.ledger.save(data); return true;
    });
    const base: InferenceMetadata = { provider: this.name, model: "unknown", providerMode: context.providerMode, usageStatus: "unknown", spendStatus: "unknown", accounting: binding };
    if (!allowed) return { outcome: "failure", retrySafe: false, errorCode: "INFERENCE_BUDGET_DENIED", metadata: base };
    let result: InferenceResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let error: InferenceAttempt["error"];
    try {
      await this.options.beforeDispatch?.();
      result = await Promise.race([Promise.resolve().then(() => this.provider.infer(request)), new Promise<InferenceResult>(resolve => {
        timer = setTimeout(() => { error = "provider-timeout"; resolve({ outcome: "ambiguous", errorCode: "PROVIDER_TIMEOUT", metadata: base }); }, this.timeoutMs);
      })]);
    } catch { error = "provider-error"; result = { outcome: "ambiguous", errorCode: "PROVIDER_ERROR", metadata: base }; }
    finally { if (timer) clearTimeout(timer); }
    let metadata: InferenceMetadata;
    try { metadata = { ...cleanAccountedMetadata(result.metadata, context.providerMode, this.name), accounting: binding, latencyMs: Math.max(0, Date.now() - started) }; }
    catch { error = "invalid-provider-metadata"; metadata = { ...base, latencyMs: Math.max(0, Date.now() - started) }; result = { outcome: "ambiguous", errorCode: "INVALID_PROVIDER_METADATA", metadata }; }
    if (result.outcome === "ambiguous") error ??= "provider-ambiguous";
    if (result.outcome === "failure") error ??= "provider-error";
    const { accounting: _binding, ...safeProviderMetadata } = metadata;
    binding.providerMetadataHash = hashValue(safeProviderMetadata);
    await this.ledger.change(this.budgets, async data => {
      const a = data.attempts.find(item => item.attemptId === attemptId);
      if (!a || a.state !== "running") invalid();
      a.providerMetadataHash = binding.providerMetadataHash!;
      a.model = metadata.model; a.latencyMs = metadata.latencyMs!; a.endedAt = new Date().toISOString();
      if (metadata.usage) a.usage = metadata.usage;
      if (metadata.spend) a.spend = metadata.spend;
      if (metadata.billingStatus) a.billingStatus = metadata.billingStatus;
      a.usageStatus = metadata.usageStatus!; a.spendStatus = metadata.spendStatus!;
      const refs = { ...(metadata.providerRequestId ? { request: metadata.providerRequestId } : {}), ...(metadata.providerSessionId ? { session: metadata.providerSessionId } : {}), ...(metadata.providerResultId ? { result: metadata.providerResultId } : {}) };
      if (Object.keys(refs).length) a.referenceHashes = refs;
      const limits = Object.values(this.budgets).flatMap(b => [...b.usage ?? [], ...b.spend ? [b.spend] : []]);
      if (limits.some(limit => charge(a, limit) > units(limit.reservePerAttempt)) || (metadata.spend && Object.values(this.budgets).some(b => b.spend && (b.spend.asset !== metadata.spend!.asset || b.spend.network !== metadata.spend!.network)))) {
        error = "reservation-exceeded"; result = { outcome: "ambiguous", errorCode: "RESERVATION_EXCEEDED", metadata };
      }
      if (result.outcome === "success") a.resultHash = hashValue(result.output);
      transition(a, result.outcome === "success" ? "succeeded" : result.outcome === "failure" ? "failed" : "ambiguous");
      if (error) a.error = error;
      await this.ledger.save(data);
    });
    return result.outcome === "success" ? { outcome: "success", output: result.output, metadata } :
      result.outcome === "failure" ? { outcome: "failure", retrySafe: result.retrySafe, errorCode: "PROVIDER_FAILURE", metadata } :
        { outcome: "ambiguous", errorCode: error === "provider-timeout" ? "PROVIDER_TIMEOUT" : "INFERENCE_UNRESOLVED", metadata };
  }
}
