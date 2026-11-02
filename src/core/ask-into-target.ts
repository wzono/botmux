export type AskIntoTargetDecision =
  | { ok: true; rootMessageId: string | null }
  | { ok: false; status: 403; error: 'ask_into_invalid_target' }
  | { ok: false; status: 502; error: 'ask_into_validation_failed'; detail: string };

type MessageItem = {
  message_id?: unknown;
  chat_id?: unknown;
  deleted?: unknown;
  root_id?: unknown;
};

function messageCandidates(detail: unknown): MessageItem[] {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return [];
  const value = detail as { items?: unknown; message?: unknown } & MessageItem;
  if (Array.isArray(value.items)) {
    return value.items.filter((item): item is MessageItem => !!item && typeof item === 'object' && !Array.isArray(item));
  }
  if (value.message && typeof value.message === 'object' && !Array.isArray(value.message)) {
    return [value.message as MessageItem];
  }
  return [value];
}

export async function resolveAskRootTarget(input: {
  requestedRootMessageId?: string;
  ambientRootMessageId: string | null;
  authenticatedChatId: string;
  larkAppId: string;
  getMessageDetail: (
    larkAppId: string,
    messageId: string,
    options: { userCardContent: boolean },
  ) => Promise<unknown>;
}): Promise<AskIntoTargetDecision> {
  if (!input.requestedRootMessageId) {
    return { ok: true, rootMessageId: input.ambientRootMessageId };
  }
  try {
    const detail = await input.getMessageDetail(
      input.larkAppId,
      input.requestedRootMessageId,
      { userCardContent: false },
    );
    const matches = messageCandidates(detail)
      .filter(item => item.message_id === input.requestedRootMessageId);
    const message = matches.length === 1 ? matches[0] : undefined;
    const validRoot = !!message
      && message.chat_id === input.authenticatedChatId
      && message.deleted === false
      && (message.root_id === undefined
        || message.root_id === null
        || message.root_id === ''
        || message.root_id === input.requestedRootMessageId);
    if (!validRoot) {
      return { ok: false, status: 403, error: 'ask_into_invalid_target' };
    }
    return { ok: true, rootMessageId: input.requestedRootMessageId };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: 'ask_into_validation_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
