import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import type { PRContext, ReviewResult, ReviewThread } from './types';

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $prNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            isOutdated
            comments(first: 1) {
              nodes {
                author {
                  login
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface GraphQLThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{
          id: string;
          isResolved: boolean;
          isOutdated: boolean;
          comments: {
            nodes: Array<{ author: { login: string } | null }>;
          };
        }>;
      };
    };
  };
}

export async function getReviewerLogin(reviewerToken: string): Promise<string> {
  const octokit = getOctokit(reviewerToken);
  const { data } = await octokit.rest.users.getAuthenticated();
  return data.login;
}

export async function getReviewThreads(
  githubToken: string,
  context: PRContext
): Promise<ReviewThread[]> {
  const octokit = getOctokit(githubToken);

  const response = await octokit.graphql<GraphQLThreadsResponse>(REVIEW_THREADS_QUERY, {
    owner: context.owner,
    repo: context.repo,
    prNumber: context.prNumber,
  });

  type ThreadNode = GraphQLThreadsResponse['repository']['pullRequest']['reviewThreads']['nodes'][number];
  return response.repository.pullRequest.reviewThreads.nodes.map((node: ThreadNode) => ({
    id: node.id,
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    authorLogin: node.comments.nodes[0]?.author?.login ?? '',
  } satisfies ReviewThread));
}

export function hasBlockingUnresolvedThreads(
  threads: ReviewThread[],
  reviewerLogin: string
): boolean {
  return threads.some(
    (t) => !t.isResolved && !t.isOutdated && t.authorLogin === reviewerLogin
  );
}

export async function getPRDetails(
  githubToken: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ title: string; body: string; headSha: string }> {
  const octokit = getOctokit(githubToken);
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  return {
    title: data.title,
    body: data.body ?? '',
    headSha: data.head.sha,
  };
}

export async function getPRDiff(githubToken: string, context: PRContext): Promise<string> {
  const octokit = getOctokit(githubToken);

  const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: context.owner,
    repo: context.repo,
    pull_number: context.prNumber,
    headers: { accept: 'application/vnd.github.diff' },
  });

  return response.data as unknown as string;
}

export async function postReview(
  reviewerToken: string,
  context: PRContext,
  result: ReviewResult
): Promise<void> {
  const octokit = getOctokit(reviewerToken);

  const inlineComments = result.comments
    .filter((c) => c.line > 0 && c.path.length > 0)
    .map((c) => ({
      path: c.path,
      line: c.line,
      body: formatCommentBody(c.body, c.severity),
    }));

  try {
    const reviewBody = buildReviewBody(result.summary, result.verdict, inlineComments.length);
    await octokit.rest.pulls.createReview({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.prNumber,
      commit_id: context.headSha,
      event: result.verdict,
      body: reviewBody,
      comments: inlineComments,
    });
    core.info(`Review posted: ${result.verdict} with ${inlineComments.length} inline comment(s)`);
  } catch (err) {
    // Inline comments may fail if the model hallucinated a line not in the diff.
    // Fall back to a body-only review so the verdict is still recorded.
    core.warning(
      `Failed to post review with inline comments (${String(err)}). Retrying body-only.`
    );

    const fallbackBody = buildFallbackBody(result.summary, result.verdict, inlineComments);
    await octokit.rest.pulls.createReview({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.prNumber,
      commit_id: context.headSha,
      event: result.verdict,
      body: fallbackBody,
      comments: [],
    });
    core.info(`Review posted (body-only fallback): ${result.verdict}`);
  }
}

export async function postBlockedComment(
  reviewerToken: string,
  context: PRContext,
  unresolvedCount: number
): Promise<void> {
  const octokit = getOctokit(reviewerToken);

  const body =
    `### PairReviewer — Waiting on unresolved feedback\n\n` +
    `There ${unresolvedCount === 1 ? 'is' : 'are'} **${unresolvedCount}** unresolved review ` +
    `thread${unresolvedCount === 1 ? '' : 's'} from this reviewer. ` +
    `Please address the feedback and push new commits — I'll re-review automatically.`;

  await octokit.rest.issues.createComment({
    owner: context.owner,
    repo: context.repo,
    issue_number: context.prNumber,
    body,
  });
}

export async function reactToComment(
  reviewerToken: string,
  owner: string,
  repo: string,
  commentId: number
): Promise<void> {
  const octokit = getOctokit(reviewerToken);
  await octokit.rest.reactions.createForIssueComment({
    owner,
    repo,
    comment_id: commentId,
    content: 'eyes',
  });
}

function formatCommentBody(body: string, severity: ReviewResult['comments'][number]['severity']): string {
  const prefix =
    severity === 'blocking'
      ? '**Severity: Blocking**'
      : severity === 'suggestion'
        ? '**Severity: Suggestion**'
        : '**Severity: Nit**';
  return `${prefix}\n\n${body}`;
}

function buildReviewBody(summary: string, verdict: ReviewResult['verdict'], inlineCount: number): string {
  return (
    `<!-- This is an auto-generated comment by PairReviewer -->\n` +
    `${summary}\n\n` +
    `<details>\n` +
    `<summary>Recent review info</summary>\n\n` +
    `Verdict: \`${verdict}\`\n\n` +
    `Inline comments: \`${inlineCount}\`\n` +
    `</details>`
  );
}

function buildFallbackBody(
  summary: string,
  verdict: ReviewResult['verdict'],
  comments: Array<{ path: string; line: number; body: string }>
): string {
  if (comments.length === 0) return buildReviewBody(summary, verdict, 0);

  const commentBlock = comments
    .map((c) => `**\`${c.path}:${c.line}\`**\n${c.body}`)
    .join('\n\n---\n\n');

  return (
    `<!-- This is an auto-generated comment by PairReviewer -->\n` +
    `${summary}\n\n` +
    `> [!WARNING]\n` +
    `> Inline comments could not be posted on this run. The feedback is included below.\n\n` +
    `<details>\n` +
    `<summary>Recent review info</summary>\n\n` +
    `Verdict: \`${verdict}\`\n\n` +
    `Inline comments attempted: \`${comments.length}\`\n` +
    `</details>\n\n` +
    `---\n\n` +
    `### Inline feedback\n\n` +
    `${commentBlock}`
  );
}
