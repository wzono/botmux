export interface CapacityAskFeedbackOrigin {
  ownsSession: boolean;
  currentTurnId?: string;
  claimedTurnId?: string;
  claimedDispatchAttempt?: number;
  dispatchHighWater?: { turnId: string; dispatchAttempt: number };
  managedTurnOrigin?: { turnId?: string; dispatchAttempt?: number };
}

export function ownsCapacityAskFeedback(origin: CapacityAskFeedbackOrigin): boolean {
  if (!origin.ownsSession || !origin.claimedTurnId
    || origin.currentTurnId !== origin.claimedTurnId) return false;
  const liveAttempt = origin.dispatchHighWater?.turnId === origin.claimedTurnId
    ? origin.dispatchHighWater.dispatchAttempt
    : origin.managedTurnOrigin?.turnId === origin.claimedTurnId
      ? origin.managedTurnOrigin.dispatchAttempt
      : undefined;
  return origin.claimedDispatchAttempt === undefined
    || liveAttempt !== undefined && origin.claimedDispatchAttempt === liveAttempt;
}

export function createCapacityAskFeedbackLifecycle(deps: {
  owned: boolean;
  observe(): void;
  resume(): void;
  onTransitionError(error: unknown): void;
}) {
  const observe = () => {
    if (!deps.owned) return;
    try { deps.observe(); } catch (error) { deps.onTransitionError(error); }
  };
  const resume = () => {
    if (!deps.owned) return;
    try { deps.resume(); } catch (error) { deps.onTransitionError(error); }
  };

  async function pending<T>(waitForDelivery: () => Promise<T>): Promise<T> {
    observe();
    try { return await waitForDelivery(); }
    catch (error) { resume(); throw error; }
  }

  async function settled<T>(waitForResult: () => Promise<T>): Promise<T> {
    observe();
    try { return await waitForResult(); }
    finally { resume(); }
  }

  function acknowledge<T>(readResult: () => T | undefined): T | undefined {
    const result = readResult();
    if (result !== undefined) resume();
    return result;
  }

  return { pending, settled, acknowledge };
}
