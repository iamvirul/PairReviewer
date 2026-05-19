import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as github from '@actions/github';
import { extractPRContext } from '../../src/index';

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
}));
vi.mock('@actions/github', () => ({
  context: { repo: { owner: 'acme', repo: 'app' }, payload: {} },
  getOctokit: vi.fn(),
}));
vi.mock('../../src/github-client');
vi.mock('../../src/models-client');

// ---------------------------------------------------------------------------
// extractPRContext
// ---------------------------------------------------------------------------

function makeGithubContext(payload: Record<string, unknown>): typeof github.context {
  return {
    repo: { owner: 'acme', repo: 'app' },
    payload,
  } as unknown as typeof github.context;
}

describe('extractPRContext', () => {
  beforeEach(() => vi.clearAllMocks());

  it('extracts context from a pull_request event payload', () => {
    const ctx = makeGithubContext({
      pull_request: {
        number: 7,
        title: 'fix: bug',
        body: 'Fixes a bug.',
        head: { sha: 'deadbeef' },
      },
    });

    const result = extractPRContext(ctx, 'acme', 'app');
    expect(result).toEqual({
      owner: 'acme',
      repo: 'app',
      prNumber: 7,
      title: 'fix: bug',
      body: 'Fixes a bug.',
      headSha: 'deadbeef',
    });
  });

  it('extracts context from a pull_request_review event payload', () => {
    const ctx = makeGithubContext({
      review: { state: 'approved' },
      pull_request: {
        number: 12,
        title: 'chore: cleanup',
        body: null,
        head: { sha: 'cafebabe' },
      },
    });

    const result = extractPRContext(ctx, 'acme', 'app');
    expect(result).not.toBeNull();
    expect(result!.prNumber).toBe(12);
    expect(result!.body).toBe('');
  });

  it('returns null when payload has no pull_request', () => {
    const ctx = makeGithubContext({ action: 'push' });
    expect(extractPRContext(ctx, 'acme', 'app')).toBeNull();
  });

  it('coerces a null body to an empty string', () => {
    const ctx = makeGithubContext({
      pull_request: {
        number: 1,
        title: 'title',
        body: null,
        head: { sha: 'abc' },
      },
    });

    const result = extractPRContext(ctx, 'acme', 'app');
    expect(result!.body).toBe('');
  });

  it('uses the owner and repo passed as arguments, not from context', () => {
    const ctx = makeGithubContext({
      pull_request: {
        number: 1,
        title: 'title',
        body: '',
        head: { sha: 'abc' },
      },
    });

    const result = extractPRContext(ctx, 'org-override', 'repo-override');
    expect(result!.owner).toBe('org-override');
    expect(result!.repo).toBe('repo-override');
  });
});
