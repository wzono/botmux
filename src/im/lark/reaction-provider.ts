import { getBotClient } from '../../bot-registry.js';
import { assertMessageWriteAllowed } from './client.js';
import { structuredLarkCode } from './lark-errors.js';

export interface OwnReaction {
  id: string;
  type: string;
}

export type ReactionListReceipt =
  | { kind: 'listed'; reactions: OwnReaction[] }
  | { kind: 'message_gone' }
  | { kind: 'retryable'; reason: 'rate_limited' | 'request_processing' | 'transport_uncertain' }
  | { kind: 'blocked'; reason: 'permission_denied' | 'chat_unavailable' | 'operator_unavailable' }
  | { kind: 'permanent'; reason: 'invalid_request' | 'unsupported_message' | 'invalid_response' };

export type ReactionCreateReceipt =
  | { kind: 'created'; reaction: OwnReaction }
  | Exclude<ReactionListReceipt, { kind: 'listed' }>;

export type ReactionDeleteReceipt =
  | { kind: 'deleted' | 'already_absent' | 'message_gone' }
  | { kind: 'retryable'; reason: 'rate_limited' | 'request_processing' | 'transport_uncertain' }
  | { kind: 'blocked'; reason: 'permission_denied' | 'chat_unavailable' | 'operator_unavailable' }
  | { kind: 'permanent'; reason: 'invalid_request' | 'unsupported_message' | 'invalid_response' };

type FailureReceipt = Exclude<ReactionListReceipt, { kind: 'listed' }>;

const MESSAGE_GONE_CODES = new Set([230110, 231005, 232009]);
const PERMISSION_CODES = new Set([231002, 231007, 231008, 231018, 231019, 231020, 231021, 231022]);
const INVALID_REQUEST_CODES = new Set([231001, 231011, 231012, 231013, 231014]);

function classifyFailure(error: unknown, operation: 'list' | 'create' | 'delete'): FailureReceipt {
  const code = structuredLarkCode(error);
  if (MESSAGE_GONE_CODES.has(code ?? -1)) return { kind: 'message_gone' };
  if (code === 231003) {
    return operation === 'delete'
      ? { kind: 'permanent', reason: 'invalid_request' }
      : { kind: 'message_gone' };
  }
  if (code === 99991400 || code === 230020) {
    return { kind: 'retryable', reason: 'rate_limited' };
  }
  if (code === 231015) return { kind: 'retryable', reason: 'request_processing' };
  if (PERMISSION_CODES.has(code ?? -1)) return { kind: 'blocked', reason: 'permission_denied' };
  if (code === 231004) return { kind: 'blocked', reason: 'chat_unavailable' };
  if (code === 231006) return { kind: 'blocked', reason: 'operator_unavailable' };
  if (code === 231017) return { kind: 'permanent', reason: 'unsupported_message' };
  if (INVALID_REQUEST_CODES.has(code ?? -1)) return { kind: 'permanent', reason: 'invalid_request' };
  return { kind: 'retryable', reason: 'transport_uncertain' };
}

function responseFailure(response: unknown, operation: 'list' | 'create' | 'delete'): FailureReceipt | undefined {
  const code = (response as { code?: unknown } | null)?.code;
  if (code === 0 || code === undefined) return undefined;
  return classifyFailure({ code }, operation);
}

export async function listOwnReactions(
  appId: string,
  messageId: string,
): Promise<ReactionListReceipt> {
  const client = getBotClient(appId);
  const own = new Map<string, OwnReaction>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 100; page += 1) {
      const response = await (client as any).im.v1.messageReaction.list({
        path: { message_id: messageId },
        params: {
          page_size: 50,
          user_id_type: 'open_id',
          ...(cursor ? { page_token: cursor } : {}),
        },
      });
      const failed = responseFailure(response, 'list');
      if (failed) return failed;
      const data = response?.data;
      if (!data || !Array.isArray(data.items) || data.items.length > 50
        || typeof data.has_more !== 'boolean') {
        return { kind: 'permanent', reason: 'invalid_response' };
      }
      for (const item of data.items) {
        const operator = item?.operator;
        if (!operator || typeof operator !== 'object' || Array.isArray(operator)) {
          return { kind: 'permanent', reason: 'invalid_response' };
        }
        if (operator.operator_type === 'user') continue;
        if (operator.operator_type !== 'app' || typeof operator.operator_id !== 'string') {
          return { kind: 'permanent', reason: 'invalid_response' };
        }
        if (operator.operator_id !== appId) continue;
        const id = item.reaction_id;
        const type = item.reaction_type?.emoji_type;
        if (typeof id !== 'string' || id.length === 0 || id.length > 4096
          || typeof type !== 'string' || type.length === 0 || type.length > 128) {
          return { kind: 'permanent', reason: 'invalid_response' };
        }
        const existing = own.get(id);
        if (existing && existing.type !== type) {
          return { kind: 'permanent', reason: 'invalid_response' };
        }
        own.set(id, { id, type });
      }
      if (!data.has_more) return { kind: 'listed', reactions: [...own.values()] };
      const next = data.page_token;
      if (typeof next !== 'string' || next.length === 0 || next.length > 4096
        || seenCursors.has(next)) {
        return { kind: 'permanent', reason: 'invalid_response' };
      }
      seenCursors.add(next);
      cursor = next;
    }
    return { kind: 'permanent', reason: 'invalid_response' };
  } catch (error) {
    return classifyFailure(error, 'list');
  }
}

export async function createReactionOnce(
  appId: string,
  messageId: string,
  type: string,
): Promise<ReactionCreateReceipt> {
  try {
    await assertMessageWriteAllowed(appId, messageId);
    const response = await (getBotClient(appId) as any).im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: type } },
    });
    const failed = responseFailure(response, 'create');
    if (failed) return failed;
    const id = response?.data?.reaction_id;
    return typeof id === 'string' && id.length > 0
      ? { kind: 'created', reaction: { id, type } }
      : { kind: 'retryable', reason: 'transport_uncertain' };
  } catch (error) {
    return classifyFailure(error, 'create');
  }
}

export async function deleteReactionOnce(
  appId: string,
  messageId: string,
  reactionId: string,
): Promise<ReactionDeleteReceipt> {
  try {
    const response = await (getBotClient(appId) as any).im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    const code = response?.code;
    if (code === 231003) return { kind: 'already_absent' };
    const failed = responseFailure(response, 'delete');
    if (failed) return failed;
    return { kind: 'deleted' };
  } catch (error) {
    if (structuredLarkCode(error) === 231003) return { kind: 'already_absent' };
    return classifyFailure(error, 'delete');
  }
}
