import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// `profiles.role` (migration 001's free-form column) was dropped in
// migration 155. Supabase `.select('...')` column lists are plain strings,
// so TypeScript can't catch a select that still names it — that exact slip
// broke the client profile load once (use-auth, 2026-09-24). This scans
// every select that reads from `profiles`.

const SRC = path.join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('profiles selects', () => {
  it('never ask for the dropped legacy `role` column', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const re = /from\(\s*['"]profiles['"]\s*\)\s*\.select\(\s*(['"`])([\s\S]*?)\1/g;
      for (const m of text.matchAll(re)) {
        const columns = m[2].split(',').map((c) => c.trim());
        if (columns.includes('role')) {
          offenders.push(`${path.relative(SRC, file)}: select(${m[2].trim()})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
