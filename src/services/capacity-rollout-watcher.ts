export interface CapacityRolloutWatcherDeps {
  snapshot(): string;
  reconcile(): Promise<void>;
  warn(error: unknown): void;
}

export function createCapacityRolloutWatcher(deps: CapacityRolloutWatcherDeps) {
  let applied = '';
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function sweep(): void {
    let current: string;
    try { current = deps.snapshot(); }
    catch (error) { deps.warn(error); return; }
    if (current === applied || running) return;
    running = true;
    void deps.reconcile().then(() => {
      applied = current;
    }, error => {
      deps.warn(error);
    }).finally(() => { running = false; });
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  return {
    sweep,
    start(intervalMs = 250): () => void {
      stop();
      sweep();
      timer = setInterval(sweep, intervalMs);
      timer.unref?.();
      return stop;
    },
    stop,
  };
}
