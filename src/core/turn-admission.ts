export type WorkspaceIdentity = { path: string; dev: string; ino: string };
export type TurnKind = 'management' | 'business' | 'control_reply' | 'terminal_bytes' | 'output_delivery';
export type TurnOrigin = 'ordinary' | 'listener' | 'trigger' | 'dashboard_opening' | 'queue' | 'principal' | 'xpi' | 'scheduler' | 'recovery'
  | 'repo_show' | 'repo_unbind_without_cli' | 'ask_reply' | 'approval_reply' | 'terminal_bytes' | 'durable_output';

declare const blankBrand: unique symbol;
declare const businessBrand: unique symbol;
declare const controlBrand: unique symbol;
export type BlankBootstrapPermit = Readonly<{ permitId: string; sessionId: string; turnId: string; reservedGeneration: number; target: WorkspaceIdentity; groupRevision?: number; expiresAt: number; [blankBrand]: true }>;
export type BusinessSubmitPermit = Readonly<{ permitId: string; bootstrapPermitId: string; sessionId: string; turnId: string; workerGeneration: number; workspace: WorkspaceIdentity; groupRevision?: number; expiresAt: number; [businessBrand]: true }>;
export type ControlReplyPermit = Readonly<{ permitId: string; controlDispatchId: string; sessionId: string; originalTurnId: string; wait: { kind: 'ask'; askId: string } | { kind: 'approval'; approvalId: string }; expectedGeneration: number; workspace: WorkspaceIdentity; groupRevision?: number; expiresAt: number; [controlBrand]: true }>;
export type BlankBootstrapPermitInput = Omit<BlankBootstrapPermit, 'permitId' | typeof blankBrand>;
export type ControlReplyPermitInput = Omit<ControlReplyPermit, 'permitId' | 'controlDispatchId' | typeof controlBrand>;

export type WorkspaceAdmissionFailure = 'store_unavailable' | 'invalid_dir' | 'inaccessible' | 'identity_changed';
export type TurnAdmissionResult =
  | { status: 'bootstrap_permitted'; sessionId: string; permit: BlankBootstrapPermit }
  | { status: 'admitted'; sessionId: string; permit: BusinessSubmitPermit }
  | { status: 'control_reply_admitted'; sessionId: string; permit: ControlReplyPermit }
  | { status: 'deferred'; reason: 'busy' | 'fifo_owned' | 'needs_user' | 'startup_recovery' }
  | { status: 'rejected'; reason: WorkspaceAdmissionFailure | 'unsupported_backend' | 'stale_owner' };

export async function admitTurnUnderMutation(input: {
  admitUnderMutation(): Promise<TurnAdmissionResult>;
}): Promise<TurnAdmissionResult> {
  return input.admitUnderMutation();
}

export async function admitTurn(input: {
  runUnderAdmission<T>(run: () => Promise<T>): Promise<T>;
  admitUnderMutation(): Promise<TurnAdmissionResult>;
}): Promise<TurnAdmissionResult> {
  return input.runUnderAdmission(() => admitTurnUnderMutation(input));
}

export type AdmittedBusinessTurnDependencies = {
  hasLiveWorker(): boolean;
  freezeWorkspace(): Promise<{ workspace: WorkspaceIdentity; groupRevision?: number }>;
  currentWorkerGeneration(): number | undefined;
  proveExistingWorkerReady(generation: number, workspace: WorkspaceIdentity): Promise<boolean>;
  issueExistingBusiness(input: {
    sessionId: string; turnId: string; workerGeneration: number;
    workspace: WorkspaceIdentity; groupRevision?: number;
  }): Promise<BusinessSubmitPermit | undefined>;
  reserveWorkerGeneration(): number;
  issueBlank(input: BlankBootstrapPermitInput): Promise<BlankBootstrapPermit>;
  forkBlank(permit: BlankBootstrapPermit): Promise<'started' | 'deferred' | 'observing' | 'rejected'>;
  awaitBlankReady(permit: BlankBootstrapPermit): Promise<{
    actualGeneration: number; cwd: WorkspaceIdentity; backend: WorkspaceIdentity;
  } | undefined>;
  proveBlankReady(permit: BlankBootstrapPermit, proof: {
    actualGeneration: number; cwd: WorkspaceIdentity; backend: WorkspaceIdentity;
  }): Promise<BusinessSubmitPermit | undefined>;
  abortBlank?(permit: BlankBootstrapPermit, phase: 'pre_fork' | 'forked_unproven'): Promise<void>;
  abortBusiness?(permit: BusinessSubmitPermit, outcome: 'refused' | 'threw'): Promise<void>;
  acquireResource?(permit: BusinessSubmitPermit): Promise<boolean>;
  markAttempting?(permit: BusinessSubmitPermit): Promise<boolean>;
  submit(permit: BusinessSubmitPermit): Promise<boolean>;
};

/** The only business-turn ordering primitive: workspace/readiness proof and a
 * durable typed permit always precede narrower leases, attempting, and IPC. */
export async function dispatchAdmittedBusinessTurn(input: {
  sessionId: string;
  turnId: string;
  permitTtlMs?: number;
  dependencies: AdmittedBusinessTurnDependencies;
}): Promise<boolean> {
  const deps = input.dependencies;
  const frozen = await deps.freezeWorkspace();
  let permit: BusinessSubmitPermit | undefined;
  if (deps.hasLiveWorker()) {
    const generation = deps.currentWorkerGeneration();
    if (!generation || !await deps.proveExistingWorkerReady(generation, frozen.workspace)) return false;
    permit = await deps.issueExistingBusiness({
      sessionId: input.sessionId, turnId: input.turnId, workerGeneration: generation,
      workspace: frozen.workspace, ...(frozen.groupRevision === undefined ? {} : { groupRevision: frozen.groupRevision }),
    });
  } else {
    const blank = await deps.issueBlank({
      sessionId: input.sessionId, turnId: input.turnId,
      reservedGeneration: deps.reserveWorkerGeneration(), target: frozen.workspace,
      ...(frozen.groupRevision === undefined ? {} : { groupRevision: frozen.groupRevision }),
      expiresAt: Date.now() + (input.permitTtlMs ?? 60_000),
    });
    let fork: Awaited<ReturnType<AdmittedBusinessTurnDependencies['forkBlank']>>;
    try {
      fork = await deps.forkBlank(blank);
    } catch {
      await deps.abortBlank?.(blank,
        (deps.currentWorkerGeneration() ?? 0) >= blank.reservedGeneration ? 'forked_unproven' : 'pre_fork');
      return false;
    }
    if (fork === 'rejected') {
      await deps.abortBlank?.(blank, 'pre_fork');
      return false;
    }
    if (fork === 'observing') return false;
    let proof: Awaited<ReturnType<AdmittedBusinessTurnDependencies['awaitBlankReady']>>;
    try {
      proof = await deps.awaitBlankReady(blank);
    } catch (error) {
      await deps.abortBlank?.(blank, 'forked_unproven');
      throw error;
    }
    if (!proof) {
      await deps.abortBlank?.(blank, 'forked_unproven');
      return false;
    }
    try {
      permit = await deps.proveBlankReady(blank, proof);
    } catch (error) {
      await deps.abortBlank?.(blank, 'forked_unproven');
      throw error;
    }
    if (!permit) await deps.abortBlank?.(blank, 'forked_unproven');
  }
  if (!permit) return false;
  if (deps.acquireResource && !await deps.acquireResource(permit)) return false;
  if (deps.markAttempting && !await markBusinessAttempting(permit, () => deps.markAttempting!(permit!))) return false;
  try {
    const submitted = await deps.submit(permit);
    if (!submitted) await deps.abortBusiness?.(permit, 'refused');
    return submitted;
  } catch {
    await deps.abortBusiness?.(permit, 'threw');
    return false;
  }
}

export async function markBusinessAttempting<T>(
  _permit: BusinessSubmitPermit,
  mark: () => Promise<T>,
): Promise<T> {
  return mark();
}

export async function resumeOriginalTurnReply<T>(
  _permit: ControlReplyPermit,
  resume: () => Promise<T>,
): Promise<T> {
  return resume();
}

/** Exact-turn control replies authorize first, validate and consume their
 * original needs_user wait second, and may only resume that turn. */
export async function resumeAdmittedControlReply<T>(input: {
  authorizeFresh(): Promise<boolean>;
  issuePermit(): Promise<ControlReplyPermit | undefined>;
  beginDispatch(permit: ControlReplyPermit): Promise<'acquired' | 'observing' | 'delivered' | 'rejected'>;
  resume(permit: ControlReplyPermit): Promise<T>;
  abort(permit: ControlReplyPermit): Promise<void>;
}): Promise<T | undefined> {
  if (!await input.authorizeFresh()) return undefined;
  const permit = await input.issuePermit();
  if (!permit) return undefined;
  const dispatch = await input.beginDispatch(permit);
  if (dispatch === 'delivered') return undefined;
  if (dispatch !== 'acquired') return undefined;
  const result = await resumeOriginalTurnReply(permit, () => input.resume(permit));
  if (result === false) await input.abort(permit);
  return result;
}

export async function reconcileTurnPermitDispatches(input: {
  pending: Array<{ permit: BusinessSubmitPermit; retryUsed: boolean }>;
  sessions: Iterable<{
    sessionId: string;
    workerGeneration?: number;
    workerAlive: boolean;
    dispatchInputReceipts?: Record<string, { workerGeneration: number }>;
  }>;
  reconcile(
    permit: BusinessSubmitPermit,
    evidence: { ack?: { sessionId: string; turnId: string; workerGeneration: number }; safeToRetry: boolean },
  ): Promise<unknown>;
}): Promise<void> {
  const sessions = new Map([...input.sessions].map(session => [session.sessionId, session]));
  for (const pending of input.pending) {
    const session = sessions.get(pending.permit.sessionId);
    const receipt = session?.dispatchInputReceipts?.[pending.permit.turnId];
    const ack = receipt?.workerGeneration === pending.permit.workerGeneration
      ? { sessionId: pending.permit.sessionId, turnId: pending.permit.turnId, workerGeneration: receipt.workerGeneration }
      : undefined;
    const sameGenerationAlive = session?.workerAlive === true
      && session.workerGeneration === pending.permit.workerGeneration;
    await input.reconcile(pending.permit, {
      ...(ack ? { ack } : {}),
      safeToRetry: !pending.retryUsed && !!session && !sameGenerationAlive,
    });
  }
}

export function classifyTurn(input: { origin: TurnOrigin }): TurnKind {
  if (input.origin === 'repo_show' || input.origin === 'repo_unbind_without_cli') return 'management';
  if (input.origin === 'ask_reply' || input.origin === 'approval_reply') return 'control_reply';
  if (input.origin === 'terminal_bytes') return 'terminal_bytes';
  if (input.origin === 'durable_output') return 'output_delivery';
  return 'business';
}

export async function runExistingWorkerAdmission(deps: {
  botGate(): Promise<void>; resolve(): Promise<WorkspaceIdentity>; follow(target: WorkspaceIdentity): Promise<void>;
  consume(target: WorkspaceIdentity): Promise<void>; issueBusinessPermit(target: WorkspaceIdentity): Promise<void>;
  resourceLease(): Promise<void>; markAttempting(): Promise<void>; submit(): Promise<void>;
}): Promise<void> {
  await deps.botGate(); const target = await deps.resolve(); await deps.follow(target); await deps.consume(target);
  await deps.issueBusinessPermit(target); await deps.resourceLease(); await deps.markAttempting(); await deps.submit();
}

export async function runBlankBootstrapAdmission(deps: {
  resolve(): Promise<WorkspaceIdentity>; reserveGeneration(): Promise<number>; persistBlankPermit(target: WorkspaceIdentity, generation: number): Promise<void>;
  forkBlank(payload: ''): Promise<void>; proveReady(generation: number): Promise<void>; proveCwdIdentity(target: WorkspaceIdentity): Promise<void>;
  proveBackend(target: WorkspaceIdentity): Promise<void>; persistBusinessPermit(): Promise<void>; submitOnce(): Promise<void>;
}): Promise<void> {
  const target = await deps.resolve(); const generation = await deps.reserveGeneration(); await deps.persistBlankPermit(target, generation);
  await deps.forkBlank(''); await deps.proveReady(generation); await deps.proveCwdIdentity(target); await deps.proveBackend(target);
  await deps.persistBusinessPermit(); await deps.submitOnce();
}
