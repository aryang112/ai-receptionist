import type { RealtimeUsage } from '../realtime/openaiSession.js';

export type LiveTranscriptFragment = {
  delta: string;
  startMs?: number;
  endMs?: number;
};

export type LiveUsage = {
  /** Cumulative billed voice duration. Session updates are snapshots. */
  voiceSeconds?: number;
  contextWindowUsageRatio?: number;
  /** Present for one completed delegated Responses invocation. */
  backendUsage?: RealtimeUsage;
  responseId?: string;
  /** True only when this came from session.closed. */
  final: boolean;
  /** False when transport closure prevented a final session.closed event. */
  finalConfirmed: boolean;
  closeReason?: string;
};

export type LiveToolCall = {
  callId: string;
  name: string;
  arguments: string;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object'
    ? (value as UnknownRecord)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export function parseTranscriptFragment(
  event: UnknownRecord
): LiveTranscriptFragment | undefined {
  if (typeof event.delta !== 'string') return undefined;
  const startMs = finiteNumber(event.start_ms);
  const endMs = finiteNumber(event.end_ms);
  return {
    delta: event.delta,
    ...(startMs === undefined ? {} : { startMs }),
    ...(endMs === undefined ? {} : { endMs }),
  };
}

export function parseToolCall(event: UnknownRecord): LiveToolCall | undefined {
  if (event.type !== 'response.output_item.done') return undefined;
  const item = asRecord(event.item);
  if (
    item?.type !== 'function_call' ||
    typeof item.call_id !== 'string' ||
    typeof item.name !== 'string' ||
    typeof item.arguments !== 'string'
  ) {
    return undefined;
  }
  return {
    callId: item.call_id,
    name: item.name,
    arguments: item.arguments,
  };
}

export function parseBackendUsage(value: unknown): RealtimeUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const inputTokens = finiteNumber(usage.input_tokens);
  const outputTokens = finiteNumber(usage.output_tokens);
  const totalTokens = finiteNumber(usage.total_tokens);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    totalTokens === undefined
  ) {
    return undefined;
  }

  const inputDetails = asRecord(usage.input_tokens_details);
  const cachedTokens = finiteNumber(inputDetails?.cached_tokens) ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens,
    inputTextTokens: inputTokens,
    outputTextTokens: outputTokens,
    cachedTextTokens: cachedTokens,
  };
}

export function parseVoiceUsage(event: UnknownRecord): {
  voiceSeconds?: number;
  contextWindowUsageRatio?: number;
} {
  const usage = asRecord(event.usage);
  const contextWindow = asRecord(event.context_window);
  const session = asRecord(event.session);
  const sessionUsage = asRecord(session?.usage);
  const voiceSeconds = finiteNumber(usage?.seconds ?? sessionUsage?.seconds);
  const contextWindowUsageRatio = finiteNumber(contextWindow?.usage_ratio);
  return {
    ...(voiceSeconds === undefined ? {} : { voiceSeconds }),
    ...(contextWindowUsageRatio === undefined
      ? {}
      : { contextWindowUsageRatio }),
  };
}
