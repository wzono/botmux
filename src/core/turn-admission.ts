export type WorkspaceIdentity = { path: string; dev: string; ino: string };
export type TurnKind = 'management' | 'business' | 'control_reply' | 'terminal_bytes' | 'output_delivery';
export type TurnOrigin = 'ordinary' | 'listener' | 'trigger' | 'dashboard_opening' | 'queue' | 'principal' | 'xpi' | 'scheduler' | 'recovery'
  | 'repo_show' | 'repo_unbind_without_cli' | 'ask_reply' | 'approval_reply' | 'terminal_bytes' | 'durable_output';

declare const blankBrand: unique symbol;
declare const businessBrand: unique symbol;
declare const controlBrand: unique symbol;
export type BlankBootstrapPermit = Readonly<{ permitId: string; sessionId: string; turnId: string; reservedGeneration: number; target: WorkspaceIdentity; groupRevision?: number; expiresAt: number; [blankBrand]?: never }>;
export type BusinessSubmitPermit = Readonly<{ permitId: string; bootstrapPermitId: string; sessionId: string; turnId: string; workerGeneration: number; workspace: WorkspaceIdentity; groupRevision?: number; expiresAt: number; [businessBrand]?: never }>;
export type ControlReplyPermit = Readonly<{ permitId: string; sessionId: string; originalTurnId: string; wait: { kind: 'ask'; askId: string } | { kind: 'approval'; approvalId: string }; expectedGeneration: number; workspace: WorkspaceIdentity; groupRevision?: number; expiresAt: number; [controlBrand]?: never }>;

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
