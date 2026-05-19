import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateReview } from '../../src/models-client';

// mockCreate is hoisted so the vi.mock factory can close over it.
const mockCreate = vi.fn();

vi.mock('openai', () => ({
  // OpenAI is used with `new` — must be a regular function (not arrow) so it qualifies as a constructor.
  default: vi.fn(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupResponse(content: string): void {
  mockCreate.mockResolvedValue({ choices: [{ message: { content } }] });
}

function setupRejectWith(error: Error): void {
  mockCreate.mockRejectedValue(error);
}

function setupEmptyContent(): void {
  mockCreate.mockResolvedValue({ choices: [{ message: { content: null } }] });
}

const BASE = {
  token: 'gh-token',
  model: 'openai/gpt-4.1',
  title: 'feat: add widget',
  body: 'Adds a widget.',
  diff: 'diff --git a/src/widget.ts b/src/widget.ts\n+export function widget() {}',
  maxDiffChars: 120_000,
} as const;

async function runReview(content: string) {
  setupResponse(content);
  return generateReview(BASE.token, BASE.model, BASE.title, BASE.body, BASE.diff, BASE.maxDiffChars);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Happy paths ────────────────────────────────────────────────────────────

  describe('happy paths', () => {
    it('returns APPROVE with empty comments for a clean diff', async () => {
      const result = await runReview(
        JSON.stringify({ verdict: 'APPROVE', summary: 'Looks good.', comments: [] })
      );

      expect(result.verdict).toBe('APPROVE');
      expect(result.summary).toBe('Looks good.');
      expect(result.comments).toHaveLength(0);
    });

    it('returns REQUEST_CHANGES with parsed inline comments', async () => {
      const result = await runReview(
        JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          summary: 'Found a bug.',
          comments: [
            { path: 'src/widget.ts', line: 3, body: 'Null check missing.', severity: 'blocking' },
          ],
        })
      );

      expect(result.verdict).toBe('REQUEST_CHANGES');
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0]).toEqual({
        path: 'src/widget.ts',
        line: 3,
        body: 'Null check missing.',
        severity: 'blocking',
      });
    });

    it('returns COMMENT verdict for non-blocking feedback', async () => {
      const result = await runReview(
        JSON.stringify({
          verdict: 'COMMENT',
          summary: 'Minor notes.',
          comments: [
            { path: 'src/widget.ts', line: 1, body: 'Consider renaming.', severity: 'nit' },
          ],
        })
      );

      expect(result.verdict).toBe('COMMENT');
    });

    it('passes the token to OpenAI as apiKey', async () => {
      setupResponse(JSON.stringify({ verdict: 'APPROVE', summary: 'OK.', comments: [] }));

      await generateReview('my-gh-token', BASE.model, BASE.title, BASE.body, BASE.diff, BASE.maxDiffChars);

      const { default: OpenAI } = await import('openai');
      expect(vi.mocked(OpenAI)).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'my-gh-token' })
      );
    });

    it('passes the model ID to the completions API', async () => {
      setupResponse(JSON.stringify({ verdict: 'APPROVE', summary: 'OK.', comments: [] }));

      await generateReview(BASE.token, 'meta/llama-4', BASE.title, BASE.body, BASE.diff, BASE.maxDiffChars);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'meta/llama-4' })
      );
    });

    it('includes PR title and body in the user prompt', async () => {
      setupResponse(JSON.stringify({ verdict: 'APPROVE', summary: 'OK.', comments: [] }));

      await generateReview(BASE.token, BASE.model, 'My PR title', 'My PR body', BASE.diff, BASE.maxDiffChars);

      const call = mockCreate.mock.calls[0]![0] as { messages: Array<{ content: string }> };
      const userMsg = call.messages.find((m) => m.content.includes('My PR title'))!;
      expect(userMsg).toBeDefined();
      expect(userMsg.content).toContain('My PR body');
    });
  });

  // ── Verdict enforcement ────────────────────────────────────────────────────

  describe('verdict enforcement', () => {
    it('overrides APPROVE to REQUEST_CHANGES when a blocking comment is present', async () => {
      const result = await runReview(
        JSON.stringify({
          verdict: 'APPROVE',
          summary: 'Contradictory response.',
          comments: [
            { path: 'src/a.ts', line: 1, body: 'Critical bug.', severity: 'blocking' },
          ],
        })
      );

      expect(result.verdict).toBe('REQUEST_CHANGES');
    });

    it('keeps APPROVE when all comments are non-blocking', async () => {
      const result = await runReview(
        JSON.stringify({
          verdict: 'APPROVE',
          summary: 'Mostly good.',
          comments: [
            { path: 'src/a.ts', line: 1, body: 'Rename this.', severity: 'nit' },
            { path: 'src/b.ts', line: 2, body: 'Consider caching.', severity: 'suggestion' },
          ],
        })
      );

      expect(result.verdict).toBe('APPROVE');
    });
  });

  // ── Input validation & sanitisation ───────────────────────────────────────

  describe('input validation and sanitisation', () => {
    it('normalises unknown severity to suggestion', async () => {
      const result = await runReview(
        JSON.stringify({
          verdict: 'COMMENT',
          summary: 'Minor stuff.',
          comments: [{ path: 'src/a.ts', line: 1, body: 'Meh.', severity: 'minor' }],
        })
      );

      expect(result.comments[0]!.severity).toBe('suggestion');
    });

    it('filters comments with missing required fields', async () => {
      const result = await runReview(
        JSON.stringify({
          verdict: 'COMMENT',
          summary: 'Some issues.',
          comments: [
            { line: 1, body: 'Missing path.', severity: 'nit' },
            { path: 'src/a.ts', body: 'Missing line.', severity: 'nit' },
            { path: 'src/a.ts', line: 5, severity: 'nit' },
            { path: 'src/a.ts', line: 5, body: 'All present.', severity: 'nit' },
          ],
        })
      );

      expect(result.comments).toHaveLength(1);
      expect(result.comments[0]!.body).toBe('All present.');
    });

    it('filters comments with zero or negative line numbers', async () => {
      const result = await runReview(
        JSON.stringify({
          verdict: 'COMMENT',
          summary: 'Issues.',
          comments: [
            { path: 'src/a.ts', line: 0, body: 'Line zero.', severity: 'nit' },
            { path: 'src/a.ts', line: -1, body: 'Negative.', severity: 'nit' },
            { path: 'src/a.ts', line: 1, body: 'Valid.', severity: 'nit' },
          ],
        })
      );

      expect(result.comments).toHaveLength(1);
    });

    it('trims whitespace from summary', async () => {
      const result = await runReview(
        JSON.stringify({ verdict: 'APPROVE', summary: '  Looks good.  ', comments: [] })
      );

      expect(result.summary).toBe('Looks good.');
    });

    it('treats a missing comments field as an empty array', async () => {
      const result = await runReview(
        JSON.stringify({ verdict: 'APPROVE', summary: 'Clean.' })
      );

      expect(result.comments).toEqual([]);
    });
  });

  // ── Diff truncation ────────────────────────────────────────────────────────

  describe('diff truncation', () => {
    it('truncates diffs exceeding maxDiffChars and notes it in the prompt', async () => {
      setupResponse(JSON.stringify({ verdict: 'APPROVE', summary: 'OK.', comments: [] }));
      const hugeDiff = 'x'.repeat(200_000);

      await generateReview(BASE.token, BASE.model, BASE.title, BASE.body, hugeDiff, 50_000);

      const call = mockCreate.mock.calls[0]![0] as { messages: Array<{ content: string }> };
      const userMsg = call.messages.find((m) => m.content.includes('xxxx'))!;
      expect(userMsg.content).toContain('truncated');
      const match = userMsg.content.match(/x+/)?.[0] ?? '';
      expect(match.length).toBeLessThanOrEqual(50_000);
    });

    it('sends the full diff when it is within the limit', async () => {
      setupResponse(JSON.stringify({ verdict: 'APPROVE', summary: 'OK.', comments: [] }));
      const smallDiff = 'small diff sentinel';

      await generateReview(BASE.token, BASE.model, BASE.title, BASE.body, smallDiff, 120_000);

      const call = mockCreate.mock.calls[0]![0] as { messages: Array<{ content: string }> };
      const userMsg = call.messages.find((m) => m.content.includes('small diff sentinel'))!;
      expect(userMsg).toBeDefined();
      expect(userMsg.content).not.toContain('truncated');
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('throws when the model returns null content', async () => {
      setupEmptyContent();

      await expect(
        generateReview(BASE.token, BASE.model, BASE.title, BASE.body, BASE.diff, BASE.maxDiffChars)
      ).rejects.toThrow('empty response');
    });

    it('throws when the response is not valid JSON', async () => {
      await expect(runReview('not json at all')).rejects.toThrow('not valid JSON');
    });

    it('throws when verdict is an unrecognised value', async () => {
      await expect(
        runReview(JSON.stringify({ verdict: 'LGTM', summary: 'Fine.', comments: [] }))
      ).rejects.toThrow('Invalid verdict');
    });

    it('throws when verdict field is absent', async () => {
      await expect(
        runReview(JSON.stringify({ summary: 'Fine.', comments: [] }))
      ).rejects.toThrow('Invalid verdict');
    });

    it('throws when summary is missing', async () => {
      await expect(
        runReview(JSON.stringify({ verdict: 'APPROVE', comments: [] }))
      ).rejects.toThrow('summary');
    });

    it('throws when summary is an empty string', async () => {
      await expect(
        runReview(JSON.stringify({ verdict: 'APPROVE', summary: '', comments: [] }))
      ).rejects.toThrow('summary');
    });

    it('throws when the response JSON is not an object', async () => {
      await expect(runReview(JSON.stringify([1, 2, 3]))).rejects.toThrow('not an object');
    });

    it('propagates OpenAI API errors', async () => {
      setupRejectWith(new Error('Rate limit exceeded'));

      await expect(
        generateReview(BASE.token, BASE.model, BASE.title, BASE.body, BASE.diff, BASE.maxDiffChars)
      ).rejects.toThrow('Rate limit exceeded');
    });
  });
});
