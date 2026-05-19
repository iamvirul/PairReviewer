import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as actionsGithub from '@actions/github';
import * as actionsCore from '@actions/core';
import {
  getReviewerLogin,
  getReviewThreads,
  hasBlockingUnresolvedThreads,
  getPRDiff,
  postReview,
  postBlockedComment,
} from '../../src/github-client';
import type { PRContext, ReviewResult, ReviewThread } from '../../src/types';

vi.mock('@actions/github', () => ({ getOctokit: vi.fn() }));
vi.mock('@actions/core', () => ({ info: vi.fn(), warning: vi.fn() }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ctx: PRContext = {
  owner: 'acme',
  repo: 'app',
  prNumber: 42,
  title: 'feat: add widget',
  body: 'Adds a new widget.',
  headSha: 'abc123',
};

function makeThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'T_1',
    isResolved: false,
    isOutdated: false,
    authorLogin: 'reviewer-bot',
    ...overrides,
  };
}

function makeOctokit(overrides: Record<string, unknown> = {}) {
  return {
    graphql: vi.fn(),
    request: vi.fn(),
    rest: {
      users: { getAuthenticated: vi.fn() },
      pulls: { createReview: vi.fn() },
      issues: { createComment: vi.fn() },
    },
    ...overrides,
  };
}

function mockOctokit(octokit: ReturnType<typeof makeOctokit>) {
  vi.mocked(actionsGithub.getOctokit).mockReturnValue(octokit as unknown as ReturnType<typeof actionsGithub.getOctokit>);
}

// ---------------------------------------------------------------------------
// hasBlockingUnresolvedThreads — pure function, no mocks needed
// ---------------------------------------------------------------------------

describe('hasBlockingUnresolvedThreads', () => {
  it('returns false for an empty thread list', () => {
    expect(hasBlockingUnresolvedThreads([], 'reviewer-bot')).toBe(false);
  });

  it('returns false when the reviewer thread is resolved', () => {
    const threads = [makeThread({ isResolved: true })];
    expect(hasBlockingUnresolvedThreads(threads, 'reviewer-bot')).toBe(false);
  });

  it('returns false when the reviewer thread is outdated', () => {
    const threads = [makeThread({ isOutdated: true })];
    expect(hasBlockingUnresolvedThreads(threads, 'reviewer-bot')).toBe(false);
  });

  it('returns false when threads belong to other users', () => {
    const threads = [makeThread({ authorLogin: 'human-reviewer' })];
    expect(hasBlockingUnresolvedThreads(threads, 'reviewer-bot')).toBe(false);
  });

  it('returns true when reviewer has an unresolved non-outdated thread', () => {
    const threads = [makeThread()];
    expect(hasBlockingUnresolvedThreads(threads, 'reviewer-bot')).toBe(true);
  });

  it('returns true when mixed threads include one blocking reviewer thread', () => {
    const threads = [
      makeThread({ authorLogin: 'human-reviewer' }),
      makeThread({ isResolved: true }),
      makeThread({ isOutdated: true }),
      makeThread(), // this one blocks
    ];
    expect(hasBlockingUnresolvedThreads(threads, 'reviewer-bot')).toBe(true);
  });

  it('returns false when reviewer thread is both resolved and outdated', () => {
    const threads = [makeThread({ isResolved: true, isOutdated: true })];
    expect(hasBlockingUnresolvedThreads(threads, 'reviewer-bot')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getReviewerLogin
// ---------------------------------------------------------------------------

describe('getReviewerLogin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the authenticated user login', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.users.getAuthenticated).mockResolvedValue({
      data: { login: 'reviewer-bot' },
    } as never);
    mockOctokit(octokit);

    const login = await getReviewerLogin('pat-token');
    expect(login).toBe('reviewer-bot');
    expect(actionsGithub.getOctokit).toHaveBeenCalledWith('pat-token');
  });

  it('propagates API errors', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.users.getAuthenticated).mockRejectedValue(
      new Error('401 Unauthorized')
    );
    mockOctokit(octokit);

    await expect(getReviewerLogin('bad-token')).rejects.toThrow('401 Unauthorized');
  });
});

// ---------------------------------------------------------------------------
// getReviewThreads
// ---------------------------------------------------------------------------

describe('getReviewThreads', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps GraphQL response to ReviewThread array', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'T_1',
                isResolved: false,
                isOutdated: false,
                comments: { nodes: [{ author: { login: 'reviewer-bot' } }] },
              },
              {
                id: 'T_2',
                isResolved: true,
                isOutdated: false,
                comments: { nodes: [{ author: { login: 'human' } }] },
              },
            ],
          },
        },
      },
    });
    mockOctokit(octokit);

    const threads = await getReviewThreads('token', ctx);
    expect(threads).toHaveLength(2);
    expect(threads[0]).toEqual({
      id: 'T_1',
      isResolved: false,
      isOutdated: false,
      authorLogin: 'reviewer-bot',
    });
    expect(threads[1]).toEqual({
      id: 'T_2',
      isResolved: true,
      isOutdated: false,
      authorLogin: 'human',
    });
  });

  it('handles threads with no author (deleted accounts)', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'T_1',
                isResolved: false,
                isOutdated: false,
                comments: { nodes: [{ author: null }] },
              },
            ],
          },
        },
      },
    });
    mockOctokit(octokit);

    const threads = await getReviewThreads('token', ctx);
    expect(threads[0]!.authorLogin).toBe('');
  });

  it('returns empty array when PR has no threads', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          reviewThreads: { nodes: [] },
        },
      },
    });
    mockOctokit(octokit);

    const threads = await getReviewThreads('token', ctx);
    expect(threads).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getPRDiff
// ---------------------------------------------------------------------------

describe('getPRDiff', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the raw diff string', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.request).mockResolvedValue({ data: 'diff --git a/foo.ts...' });
    mockOctokit(octokit);

    const diff = await getPRDiff('token', ctx);
    expect(diff).toBe('diff --git a/foo.ts...');
    expect(octokit.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      expect.objectContaining({
        owner: 'acme',
        repo: 'app',
        pull_number: 42,
        headers: { accept: 'application/vnd.github.diff' },
      })
    );
  });
});

// ---------------------------------------------------------------------------
// postReview
// ---------------------------------------------------------------------------

describe('postReview', () => {
  beforeEach(() => vi.clearAllMocks());

  const approveResult: ReviewResult = {
    verdict: 'APPROVE',
    summary: 'Looks great.',
    comments: [],
  };

  const requestChangesResult: ReviewResult = {
    verdict: 'REQUEST_CHANGES',
    summary: 'Needs work.',
    comments: [
      { path: 'src/foo.ts', line: 10, body: 'Fix this', severity: 'blocking' },
      { path: 'src/bar.ts', line: 5, body: 'Minor nit', severity: 'nit' },
    ],
  };

  it('posts APPROVE review without inline comments', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.pulls.createReview).mockResolvedValue({} as never);
    mockOctokit(octokit);

    await postReview('reviewer-token', ctx, approveResult);

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledOnce();
    const call = vi.mocked(octokit.rest.pulls.createReview).mock.calls[0]![0];
    expect(call).toMatchObject({
      owner: 'acme',
      repo: 'app',
      pull_number: 42,
      commit_id: 'abc123',
      event: 'APPROVE',
      body: expect.stringContaining('Looks great.'),
      comments: [],
    });
    expect(call.body).toContain('<summary>Recent review info</summary>');
    expect(call.body).toContain('Verdict: `APPROVE`');
  });

  it('posts REQUEST_CHANGES with formatted inline comments', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.pulls.createReview).mockResolvedValue({} as never);
    mockOctokit(octokit);

    await postReview('reviewer-token', ctx, requestChangesResult);

    const call = vi.mocked(octokit.rest.pulls.createReview).mock.calls[0]![0];
    expect(call.comments).toHaveLength(2);
    expect(call.comments![0]!.body).toContain('**Severity: Blocking**');
    expect(call.comments![1]!.body).toContain('**Severity: Nit**');
  });

  it('falls back to body-only review when inline comments are rejected', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.pulls.createReview)
      .mockRejectedValueOnce(new Error('Unprocessable Entity'))
      .mockResolvedValueOnce({} as never);
    mockOctokit(octokit);

    await postReview('reviewer-token', ctx, requestChangesResult);

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(2);
    expect(actionsCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Retrying body-only')
    );
    const fallbackCall = vi.mocked(octokit.rest.pulls.createReview).mock.calls[1]![0];
    expect(fallbackCall.comments).toEqual([]);
    expect(fallbackCall.body).toContain('[!WARNING]');
    expect(fallbackCall.body).toContain('src/foo.ts:10');
    expect(fallbackCall.body).toContain('src/bar.ts:5');
  });

  it('excludes comments with invalid line numbers', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.pulls.createReview).mockResolvedValue({} as never);
    mockOctokit(octokit);

    const result: ReviewResult = {
      verdict: 'COMMENT',
      summary: 'Summary',
      comments: [
        { path: 'src/foo.ts', line: 0, body: 'Invalid line', severity: 'nit' },
        { path: '', line: 5, body: 'Empty path', severity: 'nit' },
        { path: 'src/good.ts', line: 7, body: 'Valid', severity: 'suggestion' },
      ],
    };

    await postReview('reviewer-token', ctx, result);

    const call = vi.mocked(octokit.rest.pulls.createReview).mock.calls[0]![0];
    expect(call.comments).toHaveLength(1);
    expect(call.comments![0]!.path).toBe('src/good.ts');
  });
});

// ---------------------------------------------------------------------------
// postBlockedComment
// ---------------------------------------------------------------------------

describe('postBlockedComment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts a comment explaining how many threads are unresolved', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.createComment).mockResolvedValue({} as never);
    mockOctokit(octokit);

    await postBlockedComment('reviewer-token', ctx, 3);

    const call = vi.mocked(octokit.rest.issues.createComment).mock.calls[0]![0];
    expect(call.issue_number).toBe(42);
    expect(call.body).toContain('3');
    expect(call.body).toContain('unresolved');
  });

  it('uses singular grammar for exactly one thread', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.createComment).mockResolvedValue({} as never);
    mockOctokit(octokit);

    await postBlockedComment('reviewer-token', ctx, 1);

    const call = vi.mocked(octokit.rest.issues.createComment).mock.calls[0]![0];
    expect(call.body).toMatch(/\b1\b.*thread[^s]/);
  });
});
