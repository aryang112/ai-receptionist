import { describe, expect, it, vi } from 'vitest';
import {
  getServiceInformation,
  getServiceKnowledgeAuditSummary,
} from '../services/serviceKnowledge.js';

describe('service knowledge — deterministic reviewed lookup', () => {
  it('returns the reviewed general eyebrow-tint range with its qualifier', () => {
    const result = getServiceInformation({
      serviceName: 'eyebrow tint',
      topics: ['longevity'],
    });
    expect(result.status).toBe('ok');
    if ('topics' in result) {
      expect(result.service).toBe('Eyebrow Tinting');
      expect(result.topics[0]?.facts?.[0]?.text).toMatch(
        /three to four weeks/i
      );
      expect(result.topics[0]?.facts?.[0]?.scope).toBe('general');
    }
  });

  it('uses the most specific knowledge family for a combined service name', () => {
    const result = getServiceInformation({
      serviceName: 'brow thread and tint',
      topics: ['longevity'],
    });
    expect(result.status).toBe('ok');
    if ('service' in result) expect(result.service).toBe('Eyebrow Tinting');
  });

  it('asks for clarification on a genuinely ambiguous one-word service', () => {
    const result = getServiceInformation({
      serviceName: 'tint',
      topics: ['overview'],
    });
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidates).toEqual(['Eyebrow Tinting', 'Lash Tinting']);
    }
  });

  it('withholds a website claim when sources conflict', () => {
    const result = getServiceInformation({
      serviceName: 'lash lift',
      topics: ['aftercare', 'longevity'],
    });
    expect(result.status).toBe('needs_provider_confirmation');
    if ('topics' in result) {
      expect(result.topics).toEqual([
        { topic: 'aftercare', status: 'needs_provider_confirmation' },
        { topic: 'longevity', status: 'needs_provider_confirmation' },
      ]);
    }
  });

  it('never returns unreviewed medication preparation advice', () => {
    const result = getServiceInformation({
      serviceName: 'micro blading',
      topics: ['preparation'],
    });
    expect(result.status).toBe('needs_provider_confirmation');
    if ('topics' in result) {
      expect(result.topics[0]).toEqual({
        topic: 'preparation',
        status: 'needs_provider_confirmation',
      });
      expect(JSON.stringify(result)).not.toMatch(/aspirin|blood thinner/i);
    }
  });

  it('returns a constrained safeResponse for high-risk questions', () => {
    const result = getServiceInformation({
      serviceName: 'microblading',
      topics: ['safety'],
    });
    expect(result.status).toBe('ok');
    if ('topics' in result) {
      expect(result).toMatchObject({ highRisk: true });
      expect(result.safeResponse).toMatch(/Do not stop prescribed medication/i);
      expect(result.topics[0]).toEqual({ topic: 'safety', status: 'ok' });
    }
  });

  it('routes contraindication questions to the same constrained safety boundary', () => {
    const result = getServiceInformation({
      serviceName: 'microblading',
      topics: ['contraindications'],
    });
    expect(result.status).toBe('ok');
    if ('topics' in result) {
      expect(result).toMatchObject({ highRisk: true });
      expect(result.topics[0]).toEqual({
        topic: 'contraindications',
        status: 'ok',
      });
    }
  });

  it('handles an undocumented family topic without inventing facts', () => {
    const result = getServiceInformation({
      serviceName: 'oxygen facial',
      topics: ['aftercare'],
    });
    expect(result.status).toBe('needs_provider_confirmation');
    if ('topics' in result) {
      expect(result.topics[0]).toEqual({
        topic: 'aftercare',
        status: 'not_documented',
      });
    }
  });

  it('does no network work during lookup', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    getServiceInformation({
      serviceName: 'brow lamination',
      topics: ['overview', 'longevity'],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('reports how much audited material is intentionally withheld', () => {
    const summary = getServiceKnowledgeAuditSummary();
    expect(summary.entries).toBeGreaterThanOrEqual(8);
    expect(summary.voiceReady).toBeGreaterThan(0);
    expect(summary.withheld).toBeGreaterThan(0);
  });
});
