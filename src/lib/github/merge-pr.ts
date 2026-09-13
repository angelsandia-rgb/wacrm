// ============================================================
// Merges a GitHub pull request via the REST API — the server side of
// the /admin "Aceptar" button on a watcher-proposed fix (see
// src/app/api/admin/alerts/[id]/accept-fix/route.ts). EasyPanel
// auto-deploys `main` on push, so merging IS "launch to production"
// for anything that doesn't also need a manual migration apply.
//
// Needs GITHUB_MERGE_TOKEN: a fine-grained PAT scoped to this repo
// only, with Contents:write + Pull requests:write. Unset →
// isGithubMergeConfigured() is false and the button surfaces a clear
// "not configured" message instead of failing silently, same pattern
// as isPushConfigured()/isTriageConfigured() elsewhere in this repo.
// ============================================================

const GITHUB_API = 'https://api.github.com';

export function isGithubMergeConfigured(): boolean {
  return Boolean(process.env.GITHUB_MERGE_TOKEN?.trim());
}

interface ParsedPrUrl {
  owner: string;
  repo: string;
  number: number;
}

/** Parses `https://github.com/{owner}/{repo}/pull/{number}` (optionally with a trailing path/query). */
export function parsePrUrl(url: string): ParsedPrUrl | null {
  const match = url
    .trim()
    .match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

export class GithubMergeError extends Error {}

/**
 * Merges the given PR (squash). Throws GithubMergeError with a
 * message safe to show a platform admin on any failure (not
 * configured, PR not mergeable, already merged, network error).
 */
export async function mergePullRequest(prUrl: string): Promise<{ sha: string }> {
  const token = process.env.GITHUB_MERGE_TOKEN?.trim();
  if (!token) {
    throw new GithubMergeError(
      'GITHUB_MERGE_TOKEN no está configurado — no se puede fusionar automáticamente. Fusiona el PR manualmente en GitHub.',
    );
  }

  const parsed = parsePrUrl(prUrl);
  if (!parsed) {
    throw new GithubMergeError(`No se pudo interpretar la URL del PR: ${prUrl}`);
  }

  const res = await fetch(
    `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/merge`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ merge_method: 'squash' }),
      signal: AbortSignal.timeout(15_000),
    },
  );

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      typeof body?.message === 'string' ? body.message : `GitHub respondió ${res.status}`;
    throw new GithubMergeError(`No se pudo fusionar el PR: ${message}`);
  }

  return { sha: typeof body?.sha === 'string' ? body.sha : '' };
}
