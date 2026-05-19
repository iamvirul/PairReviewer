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
vi.mock('../../src/github-client', () => ({
  getReviewerLogin: vi.fn(),
  getReviewThreads: vi.fn(),
  hasBlockingUnresolvedThreads: vi.fn(),
  getPRDetails: vi.fn(),
  getPRDiff: vi.fn(),
  postReview: vi.fn(),
  postBlockedComment: vi.fn(),
}));
vi.mock('../../src/models-client');

// ---------------------------------------------------------------------------
// extractPRContext
// ---------------------------------------------------------------------------

function makeGithubContext(
  eventName: string,
  payload: Record<string, unknown>
): typeof github.context {
  return {
    eventName,
    repo: { owner: 'acme', repo: 'app' },
    payload,
  } as unknown as typeof github.context;
}

describe('extractPRContext', () => {
  beforeEach(() => vi.clearAllMocks());

  it('extracts context from a pull_request event payload', async () => {
    const ctx = makeGithubContext('pull_request', {
      pull_request: {
        number: 7,
        title: 'fix: bug',
        body: 'Fixes a bug.',
        head: { sha: 'deadbeef' },
      },
    });

    const result = await extractPRContext(ctx, 'acme', 'app', 'token');
    expect(result).toEqual({
      owner: 'acme',
      repo: 'app',
      prNumber: 7,
      title: 'fix: bug',
      body: 'Fixes a bug.',
      headSha: 'deadbeef',
    });
  });

  it('extracts context from a pull_request_review event payload', async () => {
    const ctx = makeGithubContext('pull_request_review', {
      review: { state: 'approved' },
      pull_request: {
        number: 12,
        title: 'chore: cleanup',
        body: null,
        head: { sha: 'cafebabe' },
      },
    });

    const result = await extractPRContext(ctx, 'acme', 'app', 'token');
    expect(result).not.toBeNull();
    expect(result!.prNumber).toBe(12);
    expect(result!.body).toBe('');
  });

  it('fetches PR details from API for issue_comment event', async () => {
    const { getPRDetails } = await import('../../src/github-client');
    vi.mocked(getPRDetails).mockResolvedValue({
      title: 'feat: api',
      body: 'Adds an API.',
      headSha: 'abc123',
    });

    const ctx = makeGithubContext('issue_comment', {
      issue: { number: 5, pull_request: { url: 'https://...' } },
      comment: { body: '@reviewer-bot please review' },
    });

    const result = await extractPRContext(ctx, 'acme', 'app', 'token');
    expect(result).not.toBeNull();
    expect(result!.prNumber).toBe(5);
    expect(result!.title).toBe('feat: api');
    expect(result!.headSha).toBe('abc123');
    expect(getPRDetails).toHaveBeenCalledWith('token', 'acme', 'app', 5);
  });

  it('returns null for issue_comment on a plain issue (not a PR)', async () => {
    const ctx = makeGithubContext('issue_comment', {
      issue: { number: 3 },
      comment: { body: '@reviewer-bot please review' },
    });

    const result = await extractPRContext(ctx, 'acme', 'app', 'token');
    expect(result).toBeNull();
  });

  it('returns null when payload has no pull_request and is not issue_comment', async () => {
    const ctx = makeGithubContext('push', {});
    const result = await extractPRContext(ctx, 'acme', 'app', 'token');
    expect(result).toBeNull();
  });

  it('coerces a null body to an empty string', async () => {
    const ctx = makeGithubContext('pull_request', {
      pull_request: { number: 1, title: 'title', body: null, head: { sha: 'abc' } },
    });

    const result = await extractPRContext(ctx, 'acme', 'app', 'token');
    expect(result!.body).toBe('');
  });

  it('uses the owner and repo passed as arguments', async () => {
    const ctx = makeGithubContext('pull_request', {
      pull_request: { number: 1, title: 'title', body: '', head: { sha: 'abc' } },
    });

    const result = await extractPRContext(ctx, 'org-override', 'repo-override', 'token');
    expect(result!.owner).toBe('org-override');
    expect(result!.repo).toBe('repo-override');
  });
});
