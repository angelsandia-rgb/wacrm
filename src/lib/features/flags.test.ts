import { describe, expect, it } from 'vitest';
import { hasFeature, normalizeFeatureFlags } from './flags';

describe('feature flags', () => {
  it('keeps only registered keys, deduplicated', () => {
    expect(normalizeFeatureFlags(['ai_voice_notes', 'retired_flag', 'ai_voice_notes', 3])).toEqual([
      'ai_voice_notes',
    ]);
    expect(normalizeFeatureFlags(null)).toEqual([]);
  });

  it('reports whether a flag is on', () => {
    expect(hasFeature(['ai_voice_notes'], 'ai_voice_notes')).toBe(true);
    expect(hasFeature([], 'ai_voice_notes')).toBe(false);
    expect(hasFeature(undefined, 'ai_voice_notes')).toBe(false);
  });
});
