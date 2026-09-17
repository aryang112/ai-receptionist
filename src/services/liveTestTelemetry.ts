// Derived accounting for simulated Live comparison calls. CallStore records
// usage snapshots, so this module deliberately performs no I/O and can be
// reused by read-only operator surfaces.

export type LiveTelemetryRow = {
  type?: unknown;
  callSid?: unknown;
  ts?: unknown;
  event?: unknown;
  detail?: unknown;
  voiceEngine?: unknown;
  backendModel?: unknown;
  backendEffort?: unknown;
};

type BackendUsage = {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
};

export type LiveTestTelemetry = {
  voiceSeconds?: number;
  audioCostUsd?: number;
  backendResponseCount: number;
  backendCostUsd?: number;
  totalCostUsd?: number;
  /** Absent until Live supplies a final usage snapshot. */
  finalConfirmed?: boolean;
};

type Pricing = {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
};

const PRICING: Record<string, Pricing> = {
  'gpt-5.6-terra': {
    inputPerMillion: 2,
    cachedInputPerMillion: 0.2,
    outputPerMillion: 12,
  },
  'gpt-5.6-luna': {
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    outputPerMillion: 1.2,
  },
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function parseBackendUsage(value: unknown): BackendUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const inputTokens = nonNegativeFinite(usage.inputTokens);
  const cachedTokens = nonNegativeFinite(usage.cachedTokens);
  const outputTokens = nonNegativeFinite(usage.outputTokens);
  if (
    inputTokens === undefined ||
    cachedTokens === undefined ||
    outputTokens === undefined
  ) {
    return undefined;
  }
  return { inputTokens, cachedTokens, outputTokens };
}

function costForUsage(usage: BackendUsage, pricing: Pricing): number {
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedTokens);
  return (
    (uncachedInput * pricing.inputPerMillion +
      usage.cachedTokens * pricing.cachedInputPerMillion +
      usage.outputTokens * pricing.outputPerMillion) /
    1_000_000
  );
}

/**
 * Derive the Live comparison cost from a single call's persisted rows.
 *
 * `voiceSeconds` is a cumulative Live snapshot: the newest valid snapshot is
 * authoritative and is never summed. Backend usage is emitted per Responses
 * result, so a response id is counted once even if it was persisted twice.
 * Missing usage remains missing; callers must not mistake unavailable billing
 * telemetry for a free call.
 */
export function deriveLiveTestTelemetry(
  rows: readonly LiveTelemetryRow[],
  backendModel: unknown
): LiveTestTelemetry | undefined {
  const pricing =
    typeof backendModel === 'string' ? PRICING[backendModel] : undefined;
  const voiceRows = rows
    .filter((row) => row.type === 'voice' && row.event === 'live_usage')
    .map((row, index) => ({ row, index, detail: asRecord(row.detail) }))
    .filter(
      (
        entry
      ): entry is {
        row: LiveTelemetryRow;
        index: number;
        detail: Record<string, unknown>;
      } => !!entry.detail
    );
  if (voiceRows.length === 0) return undefined;

  let newestVoice: { seconds: number; ts: number; index: number } | undefined;
  let newestFinal:
    | { finalConfirmed: boolean; ts: number; index: number }
    | undefined;
  const seenResponseIds = new Set<string>();
  let backendResponseCount = 0;
  let backendCostUsd: number | undefined;

  for (const { row, index, detail } of voiceRows) {
    const ts =
      typeof row.ts === 'number' && Number.isFinite(row.ts)
        ? row.ts
        : -Infinity;
    const voiceSeconds = nonNegativeFinite(detail.voiceSeconds);
    if (
      voiceSeconds !== undefined &&
      (!newestVoice ||
        ts > newestVoice.ts ||
        (ts === newestVoice.ts && index > newestVoice.index))
    ) {
      newestVoice = { seconds: voiceSeconds, ts, index };
    }

    if (detail.final === true && typeof detail.finalConfirmed === 'boolean') {
      if (
        !newestFinal ||
        ts > newestFinal.ts ||
        (ts === newestFinal.ts && index > newestFinal.index)
      ) {
        newestFinal = { finalConfirmed: detail.finalConfirmed, ts, index };
      }
    }

    const usage = parseBackendUsage(detail.backendUsage);
    if (!usage) continue;
    const responseId =
      typeof detail.responseId === 'string' ? detail.responseId : undefined;
    if (responseId && seenResponseIds.has(responseId)) continue;
    if (responseId) seenResponseIds.add(responseId);
    backendResponseCount += 1;
    if (pricing) {
      backendCostUsd = (backendCostUsd ?? 0) + costForUsage(usage, pricing);
    }
  }

  const audioCostUsd = newestVoice
    ? (newestVoice.seconds * 0.05) / 60
    : undefined;
  const totalCostUsd =
    audioCostUsd !== undefined || backendCostUsd !== undefined
      ? (audioCostUsd ?? 0) + (backendCostUsd ?? 0)
      : undefined;

  return {
    ...(newestVoice ? { voiceSeconds: newestVoice.seconds } : {}),
    ...(audioCostUsd === undefined ? {} : { audioCostUsd }),
    backendResponseCount,
    ...(backendCostUsd === undefined ? {} : { backendCostUsd }),
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
    ...(newestFinal ? { finalConfirmed: newestFinal.finalConfirmed } : {}),
  };
}
