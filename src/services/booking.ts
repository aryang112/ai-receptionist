// src/services/booking.ts
import { z } from 'zod';
import { phorest } from './phorest.js';
import { logger } from '../core/logger.js';
import type { Service } from './phorest.types.js';

export const SuggestSchema = z.object({
  serviceName: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const BookSchema = z.object({
  serviceName: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  // When the caller is a recognized account (matched by caller ID), the
  // orchestrator passes their Phorest clientId so we book against that record
  // directly and skip resolving by phone. Optional — new callers omit it.
  clientId: z.string().min(1).optional(),
  customer: z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().email().optional(),
  }),
});

// Common caller phrasings that don't share a keyword with the real service name.
// Keys and values are compared AFTER normalization (see normalize()), so they
// must themselves be in normalized form (lowercase, alnum, single-spaced).
const SERVICE_ALIASES: Record<string, string> = {
  // September 7 caller phrasing: the live catalog calls this Brow Threading.
  // Keep explicit phrases so unknown treatment words (e.g. henna) survive
  // matching and cannot silently turn a different request into threading.
  'eyebrow threading': 'brow threading',
  'eyebrows threading': 'brow threading',
  'eyebrow thread': 'brow threading',
  'eyebrows threaded': 'brow threading',
  'threading for my eyebrows': 'brow threading',
  'get my eyebrows threaded': 'brow threading',
  'lash lamination': 'lash lift',
  'lash laminations': 'lash lift',
  'lash laminate': 'lash lift',
  'eyelash lamination': 'lash lift',
  'eyelash lift': 'lash lift',
  'brow laminations': 'brow lamination',
  'eyebrow lamination': 'brow lamination',
  // Bare brow/eyebrow phrasings should land on threading (the brow service the
  // salon actually offers), not a tint or a permanent-makeup line.
  eyebrows: 'brow threading',
  eyebrow: 'brow threading',
  brows: 'brow threading',
  brow: 'brow threading',
};

// Normalize a service name or a caller query to a comparable form:
// strip a leading menu prefix like "3)" / "3a)" / "12)", lowercase, turn any
// run of non-alphanumerics into a single space, and trim. This makes
// "3a) Eyebrow Threading" and "eyebrow threading" compare equal.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/^\s*\d+[a-z]?\)\s*/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s).split(' ').filter(Boolean);
}

// The outcome of resolving a caller phrase against the live catalog.
export type ServiceMatch =
  | { kind: 'match'; service: Service }
  | { kind: 'ambiguous'; candidates: Service[] }
  | { kind: 'notOffered'; closest: Service[] };

// Resolve a caller's service phrase to a catalog Service. Match priority:
//   1. exact normalized name
//   2. SERVICE_ALIASES (normalized phrase -> normalized target, re-resolved)
//   3. every query token present as a WHOLE word in the service name, scored by
//      matched-token ratio (tie-break: shortest name)
// If the top two scored candidates are close and different -> ambiguous.
// If nothing scores -> notOffered with the closest few (by shared-token count).
export async function resolveService(name: string): Promise<ServiceMatch> {
  const services = await phorest.listServices();
  const q = normalize(name);
  if (!q) return { kind: 'notOffered', closest: services.slice(0, 3) };

  // (1) exact normalized name.
  const exact = services.find((s) => normalize(s.name) === q);
  if (exact) return { kind: 'match', service: exact };

  // (2) alias -> re-resolve the aliased phrase (exact, then token scoring).
  const aliased = SERVICE_ALIASES[q];
  if (aliased) {
    const aliasExact = services.find((s) => normalize(s.name) === aliased);
    if (aliasExact) return { kind: 'match', service: aliasExact };
    // Fall through using the aliased phrase as the query for token scoring.
  }

  // (3) whole-word token scoring. Every query token must appear as a whole word
  // in the service name; score = matchedName-token-ratio isn't enough on its own
  // (a 1-word query matches many names fully), so we require ALL query tokens
  // present and rank by how much of the SERVICE name they cover, tie-broken by
  // shortest name (the most specific service wins).
  const queryTokens = tokens(aliased ?? q);
  const scored = services
    .map((s) => {
      const nameTokens = tokens(s.name);
      const nameSet = new Set(nameTokens);
      const allPresent = queryTokens.every((t) => nameSet.has(t));
      if (!allPresent) return null;
      // Coverage of the service name by the query — a query that names the
      // whole service (e.g. "lip threading" -> "Lip Threading") scores 1.0;
      // a partial ("threading" -> "Full Face Threading") scores lower.
      const coverage = queryTokens.length / nameTokens.length;
      return { service: s, coverage, nameLen: s.name.length };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => {
      if (b.coverage !== a.coverage) return b.coverage - a.coverage;
      return a.nameLen - b.nameLen;
    });

  if (scored.length === 0) {
    // F4: split compound words ("micro blading") share no WHOLE token with a
    // catalog entry like "Microblading Consult". Before giving up, retry with
    // the query's spaces collapsed so a split compound can match a single
    // catalog token — this is the "micro blading -> dead end while Microblading
    // exists" trap. (>2 chars so we don't collapse trivially.)
    const collapsed = queryTokens.join('');
    if (collapsed.length > 2) {
      const hits = [
        ...new Map(
          services
            .filter((s) =>
              tokens(s.name).some(
                (t) => t === collapsed || t.includes(collapsed)
              )
            )
            .map((s) => [s.id, s])
        ).values(),
      ];
      if (hits.length === 1) return { kind: 'match', service: hits[0]! };
      if (hits.length > 1)
        return { kind: 'ambiguous', candidates: hits.slice(0, 3) };
    }
    // Nothing contained every query token — surface the closest few by how many
    // query tokens they share, so Erica can offer real alternatives.
    const closest = services
      .map((s) => {
        const nameSet = new Set(tokens(s.name));
        const shared = queryTokens.filter((t) => nameSet.has(t)).length;
        return { service: s, shared };
      })
      .filter((x) => x.shared > 0)
      .sort((a, b) => b.shared - a.shared)
      .slice(0, 3)
      .map((x) => x.service);
    return { kind: 'notOffered', closest };
  }

  const top = scored[0]!;
  const distinct = new Map(scored.map((x) => [x.service.id, x]));

  // A coverage of 1.0 means the query named the WHOLE service (every token of
  // the service name was said) — that's a decisive, unambiguous pick even if the
  // fragment also appears inside a longer service name.
  if (top.coverage === 1) {
    // Guard the rare true tie: two DIFFERENT services both fully named (e.g. a
    // duplicated catalog entry). Surface both rather than silently pick one.
    const fullyNamed = [...distinct.values()].filter((x) => x.coverage === 1);
    if (fullyNamed.length > 1) {
      return {
        kind: 'ambiguous',
        candidates: fullyNamed.slice(0, 3).map((x) => x.service),
      };
    }
    return { kind: 'match', service: top.service };
  }

  // Below 1.0 the query is only a FRAGMENT of the service name ("wax",
  // "threading"). If that fragment appears in two or more DIFFERENT services,
  // there's no decisive winner — return them as candidates instead of silently
  // grabbing the first (the exact "wax -> some random wax" trap this rewrites).
  if (distinct.size > 1) {
    return {
      kind: 'ambiguous',
      candidates: [...distinct.values()].slice(0, 3).map((x) => x.service),
    };
  }

  // A single service contains the fragment — resolve to it.
  return { kind: 'match', service: top.service };
}

/**
 * Alias-rot detector (F4 bonus): warn at boot for any SERVICE_ALIASES target
 * that no longer resolves against the live catalog — a renamed/removed service
 * silently turns an alias into a dead end. Best-effort; never throws.
 */
export async function warnStaleAliases(): Promise<void> {
  try {
    const services = await phorest.listServices();
    const names = new Set(services.map((s) => normalize(s.name)));
    const targets = new Set(Object.values(SERVICE_ALIASES));
    const stale = [...targets].filter(
      (t) => !names.has(t) && ![...names].some((n) => tokens(n).includes(t))
    );
    if (stale.length) {
      logger.warn(
        { staleAliasTargets: stale },
        'SERVICE_ALIASES targets no longer resolve against the live catalog (alias rot)'
      );
    }
  } catch {
    /* boot-time diagnostic only — never block startup */
  }
}

// Thin wrapper kept for callers that only need the resolved Service (or
// undefined). Ambiguous / notOffered both collapse to undefined here — callers
// that need to disambiguate should use resolveService directly.
export async function findServiceByName(
  name: string
): Promise<Service | undefined> {
  const result = await resolveService(name);
  return result.kind === 'match' ? result.service : undefined;
}

export type SuggestResult =
  | { service: Service; date: string; slots: string[] }
  | { notOffered: true; closest: Service[] }
  | { ambiguous: Service[] };

export async function suggestSlots(
  input: z.infer<typeof SuggestSchema>
): Promise<SuggestResult> {
  const { serviceName, date } = SuggestSchema.parse(input);
  const match = await resolveService(serviceName);
  if (match.kind === 'notOffered') {
    return { notOffered: true, closest: match.closest };
  }
  if (match.kind === 'ambiguous') {
    return { ambiguous: match.candidates };
  }
  const svc = match.service;
  const slots = await phorest.getAvailability(svc.id, date);
  return { service: svc, date, slots };
}

export async function bookAppointment(input: z.infer<typeof BookSchema>) {
  const { serviceName, date, time, clientId, customer } =
    BookSchema.parse(input);
  const svc = await findServiceByName(serviceName);
  if (!svc) throw new Error('Service not found');

  const startIso = `${date}T${time.length === 5 ? time + ':00' : time}`;

  // ✅ remove undefined keys to satisfy exactOptionalPropertyTypes
  const customerClean: { name: string; phone?: string; email?: string } = {
    name: customer.name,
    ...(customer.phone ? { phone: customer.phone } : {}),
    ...(customer.email ? { email: customer.email } : {}),
  };

  // When a clientId was resolved from caller ID, pass it straight through so the
  // adapter books against that record and skips phone/name resolution.
  const appointment = await phorest.createAppointment(
    svc.id,
    startIso,
    customerClean,
    clientId
  );
  return { service: svc, appointment };
}
