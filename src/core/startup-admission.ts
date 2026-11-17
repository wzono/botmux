/**
 * Fail-closed startup admission state for the exact bot daemons expected in a
 * process. Callers derive that set from the daemons actually started, not every
 * configured bot, so intentionally disabled bots cannot hold readiness open.
 */
export class StartupAdmissionBarrier {
  private readonly states = new Map<string, { ready: boolean; failure?: Error }>();

  constructor(expectedActiveBotIds: Iterable<string>) {
    for (const botId of expectedActiveBotIds) this.states.set(botId, { ready: false });
  }

  isReady(botId: string): boolean {
    return this.states.get(botId)?.ready === true;
  }

  allReady(): boolean {
    return this.states.size > 0 && [...this.states.values()].every(state => state.ready);
  }

  markReady(botId: string): void {
    const state = this.states.get(botId);
    if (!state) throw new Error(`unexpected startup bot: ${botId}`);
    state.ready = true;
    delete state.failure;
  }

  markFailed(botId: string, error: unknown): void {
    const state = this.states.get(botId);
    if (!state) throw new Error(`unexpected startup bot: ${botId}`);
    state.ready = false;
    state.failure = error instanceof Error ? error : new Error(String(error));
  }

  failure(botId: string): Error | undefined {
    return this.states.get(botId)?.failure;
  }
}
