import ModelClient, { isUnexpected } from '@azure-rest/ai-inference';
import { AzureKeyCredential } from '@azure/core-auth';
import type { ReviewResult, ReviewComment, CommentSeverity, ReviewVerdict } from './types';

const GITHUB_MODELS_ENDPOINT = 'https://models.github.ai/inference';

const VALID_VERDICTS = new Set<ReviewVerdict>(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
const VALID_SEVERITIES = new Set<CommentSeverity>(['blocking', 'suggestion', 'nit']);

const SYSTEM_PROMPT = `You are a senior software engineer performing a production-grade code review.

Your responsibilities:
- Catch bugs, logic errors, and off-by-one mistakes
- Flag security vulnerabilities (OWASP Top 10: injection, XSS, SSRF, broken auth, etc.)
- Identify missing error handling and unhandled edge cases
- Spot N+1 queries, unbounded operations, and performance traps
- Note architectural violations (e.g. business logic leaking into controllers)

Your style:
- Be direct and specific — cite the exact line and what's wrong
- Explain WHY something is a problem, not just that it is
- Suggest the correct fix, not just the issue
- Do NOT comment on whitespace, formatting, or naming style unless it causes ambiguity
- Do NOT comment on things outside the diff

Respond ONLY with a valid JSON object. No markdown fences, no explanation outside the JSON.`;

function buildUserPrompt(
  title: string,
  body: string,
  diff: string,
  maxDiffChars: number
): string {
  const truncatedDiff =
    diff.length > maxDiffChars
      ? diff.slice(0, maxDiffChars) +
        `\n\n... [diff truncated at ${maxDiffChars} characters — focus review on what's shown]`
      : diff;

  return `Review this pull request:

PR Title: ${title}
PR Description: ${body || '(no description provided)'}

Diff:
${truncatedDiff}

Respond with exactly this JSON structure:
{
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  "summary": "2–4 sentence overall assessment covering what the PR does and your verdict rationale",
  "comments": [
    {
      "path": "relative/path/to/file.ts",
      "line": 42,
      "body": "Precise description of the issue and how to fix it",
      "severity": "blocking" | "suggestion" | "nit"
    }
  ]
}

Verdict rules:
- APPROVE: No significant issues. Code is correct, secure, and production-ready.
- REQUEST_CHANGES: One or more blocking issues (bugs, security holes, missing critical error handling).
- COMMENT: Only minor suggestions or nits. Nothing that blocks merging.
- If any comment has severity "blocking", the verdict MUST be REQUEST_CHANGES.
- An empty comments array is valid and expected for a clean APPROVE.

Inline comment rules:
- Only reference file paths and line numbers that appear in the diff above.
- Do not fabricate line numbers. If unsure of the exact line, omit the inline comment and mention it in the summary instead.`;
}

export async function generateReview(
  githubToken: string,
  model: string,
  title: string,
  body: string,
  diff: string,
  maxDiffChars: number
): Promise<ReviewResult> {
  const client = ModelClient(
    GITHUB_MODELS_ENDPOINT,
    new AzureKeyCredential(githubToken)
  );

  const userPrompt = buildUserPrompt(title, body, diff, maxDiffChars);

  const response = await client.path('/chat/completions').post({
    body: {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
    },
  });

  if (isUnexpected(response)) {
    const detail = response.body
      ? JSON.stringify(response.body.error)
      : `HTTP ${response.status}`;
    throw new Error(`GitHub Models API error: ${detail}`);
  }

  const rawContent = response.body.choices[0]?.message?.content;
  if (!rawContent) {
    throw new Error('GitHub Models API returned an empty response');
  }

  return parseAndValidateReview(rawContent);
}

function parseAndValidateReview(raw: string): ReviewResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Model response is not valid JSON: ${raw.slice(0, 200)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Model response JSON is not an object');
  }

  const obj = parsed as Record<string, unknown>;

  const verdict = obj['verdict'];
  if (typeof verdict !== 'string' || !VALID_VERDICTS.has(verdict as ReviewVerdict)) {
    throw new Error(`Invalid verdict value: ${String(verdict)}`);
  }

  const summary = obj['summary'];
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw new Error('Missing or empty summary field');
  }

  const rawComments = Array.isArray(obj['comments']) ? obj['comments'] : [];
  const comments: ReviewComment[] = rawComments
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .filter((c) => typeof c['path'] === 'string' && typeof c['line'] === 'number' && typeof c['body'] === 'string')
    .map((c) => ({
      path: c['path'] as string,
      line: Math.round(c['line'] as number),
      body: c['body'] as string,
      severity: VALID_SEVERITIES.has(c['severity'] as CommentSeverity)
        ? (c['severity'] as CommentSeverity)
        : 'suggestion',
    }))
    .filter((c) => c.path.length > 0 && c.line > 0 && c.body.trim().length > 0);

  // Enforce verdict consistency: any blocking comment forces REQUEST_CHANGES
  const hasBlocking = comments.some((c) => c.severity === 'blocking');
  const finalVerdict: ReviewVerdict =
    hasBlocking && verdict === 'APPROVE' ? 'REQUEST_CHANGES' : (verdict as ReviewVerdict);

  return { verdict: finalVerdict, summary: summary.trim(), comments };
}
