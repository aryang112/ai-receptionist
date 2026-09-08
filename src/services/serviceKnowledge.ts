import { z } from 'zod';
import { loadServiceKnowledgeConfig } from '../config/serviceKnowledgeConfig.js';

export const SERVICE_INFORMATION_TOPICS = [
  'overview',
  'process',
  'longevity',
  'preparation',
  'aftercare',
  'suitability',
  'expected_results',
  'products',
  'patch_test',
  'contraindications',
  'safety',
] as const;

export const ServiceInformationTopicSchema = z.enum(SERVICE_INFORMATION_TOPICS);
export type ServiceInformationTopic = z.infer<
  typeof ServiceInformationTopicSchema
>;

const FactSchema = z.object({
  topic: ServiceInformationTopicSchema,
  text: z.string().min(1).max(600),
  qualifiers: z.array(z.string().min(1).max(300)).max(3),
  scope: z.enum(['salon', 'general']),
  reviewStatus: z.enum([
    'voice_ready',
    'needs_owner_review',
    'conflicting',
    'unsafe',
  ]),
  safety: z.enum(['low', 'sensitive', 'medical']),
  delivery: z.enum(['compose', 'verbatim']).default('compose'),
  sourceUrl: z.string().url(),
  corroboratingUrl: z.string().url().optional(),
});

const EntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  displayName: z.string().min(1).max(120),
  aliases: z.array(z.string().min(1).max(120)).min(1),
  facts: z.array(FactSchema).min(1),
});

const KnowledgeSchema = z.object({
  schemaVersion: z.literal(1),
  auditedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entries: z.array(EntrySchema).min(1),
});

const knowledge = KnowledgeSchema.parse(loadServiceKnowledgeConfig());
type KnowledgeEntry = z.infer<typeof EntrySchema>;

export const ServiceInformationRequestSchema = z.object({
  serviceName: z.string().trim().min(1).max(120),
  topics: z
    .array(ServiceInformationTopicSchema)
    .min(1)
    .max(3)
    .transform((topics) => [...new Set(topics)]),
});

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^\s*\d+[a-z]?\)\s*/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(value: string): string[] {
  return normalize(value).split(' ').filter(Boolean);
}

function aliasScore(query: string, alias: string): number {
  const q = normalize(query);
  const a = normalize(alias);
  if (!q || !a) return 0;
  if (q === a) return 100 + tokens(a).length;
  if (q.replace(/\s/g, '') === a.replace(/\s/g, '')) return 95;

  const qTokens = tokens(q);
  const aTokens = tokens(a);
  const qSet = new Set(qTokens);
  const aSet = new Set(aTokens);
  const queryInsideAlias = qTokens.every((token) => aSet.has(token));
  const aliasInsideQuery = aTokens.every((token) => qSet.has(token));
  if (!queryInsideAlias && !aliasInsideQuery) return 0;
  const shared = Math.min(qTokens.length, aTokens.length);
  return 20 + shared * 4 - Math.abs(qTokens.length - aTokens.length);
}

function matchEntries(serviceName: string): KnowledgeEntry[] {
  const scored = knowledge.entries
    .map((entry) => ({
      entry,
      score: Math.max(
        ...entry.aliases.map((alias) => aliasScore(serviceName, alias))
      ),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.displayName.localeCompare(b.entry.displayName)
    );

  if (!scored.length) return [];
  const best = scored[0]!.score;
  return scored
    .filter((candidate) => candidate.score === best)
    .slice(0, 3)
    .map((candidate) => candidate.entry);
}

export type ServiceInformationResult =
  | {
      status: 'not_documented';
      serviceName: string;
      note: string;
    }
  | {
      status: 'ambiguous';
      serviceName: string;
      candidates: string[];
      note: string;
    }
  | {
      status: 'ok' | 'needs_provider_confirmation';
      service: string;
      highRisk?: boolean;
      safeResponse?: string;
      topics: Array<{
        topic: ServiceInformationTopic;
        status: 'ok' | 'not_documented' | 'needs_provider_confirmation';
        facts?: Array<{
          text: string;
          qualifiers: string[];
          scope: 'salon' | 'general';
        }>;
      }>;
      note: string;
    };

/**
 * Deterministic, in-memory service knowledge lookup for the Realtime tool.
 * The runtime receives no URLs or editorial metadata, and facts that are
 * conflicting, unsafe, or still awaiting owner review are never returned.
 */
export function getServiceInformation(
  input: unknown
): ServiceInformationResult {
  const request = ServiceInformationRequestSchema.parse(input);
  const matches = matchEntries(request.serviceName);
  if (!matches.length) {
    return {
      status: 'not_documented',
      serviceName: request.serviceName,
      note: 'No approved knowledge is stored for this service. Do not answer from model memory or invent a salon-specific fact; offer provider confirmation for the requested detail.',
    };
  }
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      serviceName: request.serviceName,
      candidates: matches.map((entry) => entry.displayName),
      note: 'Ask one short question to identify which service the caller means. Do not guess.',
    };
  }

  const entry = matches[0]!;
  const topics = request.topics.map((topic) => {
    const candidates = entry.facts.filter((fact) => fact.topic === topic);
    const ready = candidates.filter(
      (fact) => fact.reviewStatus === 'voice_ready'
    );
    if (ready.length) {
      const verbatim = ready.find((fact) => fact.delivery === 'verbatim');
      if (verbatim) {
        return {
          topic,
          status: 'ok' as const,
        };
      }
      return {
        topic,
        status: 'ok' as const,
        facts: ready.map(({ text, qualifiers, scope }) => ({
          text,
          qualifiers,
          scope,
        })),
      };
    }
    if (candidates.length) {
      return { topic, status: 'needs_provider_confirmation' as const };
    }
    return { topic, status: 'not_documented' as const };
  });
  const needsProvider = topics.some((topic) => topic.status !== 'ok');
  const safeResponses = [
    ...new Set(
      request.topics.flatMap((topic) =>
        entry.facts
          .filter(
            (fact) =>
              fact.topic === topic &&
              fact.reviewStatus === 'voice_ready' &&
              fact.delivery === 'verbatim'
          )
          .map((fact) => fact.text)
      )
    ),
  ];

  return {
    status: needsProvider ? 'needs_provider_confirmation' : 'ok',
    service: entry.displayName,
    ...(safeResponses.length
      ? { highRisk: true, safeResponse: safeResponses.join(' ') }
      : {}),
    topics,
    note: needsProvider
      ? 'Answer directly from the returned facts. For any topic marked not documented or needing provider confirmation, do not fill the gap from memory; say Richa would need to confirm that detail. Keep it to one or two sentences and do not mention tools, sources, or internal review.'
      : 'Answer directly in one or two natural sentences using only these facts and relevant qualifiers. General-scope facts must be phrased as typical, not guaranteed. Do not mention tools, sources, or internal review.',
  };
}

export function getServiceKnowledgeAuditSummary() {
  const facts = knowledge.entries.flatMap((entry) => entry.facts);
  return {
    schemaVersion: knowledge.schemaVersion,
    auditedAt: knowledge.auditedAt,
    entries: knowledge.entries.length,
    facts: facts.length,
    voiceReady: facts.filter((fact) => fact.reviewStatus === 'voice_ready')
      .length,
    withheld: facts.filter((fact) => fact.reviewStatus !== 'voice_ready')
      .length,
  };
}
