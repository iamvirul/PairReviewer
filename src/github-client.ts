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
    await octokit.rest.pulls.createReview({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.prNumber,
      commit_id: context.headSha,
      event: result.verdict,
      body: result.summary,
      comments: inlineComments,
    });
    core.info(`Review posted: ${result.verdict} with ${inlineComments.length} inline comment(s)`);
  } catch (err) {
    // Inline comments may fail if the model hallucinated a line not in the diff.
    // Fall back to a body-only review so the verdict is still recorded.
    core.warning(
      `Failed to post review with inline comments (${String(err)}). Retrying body-only.`
    );

    const fallbackBody = buildFallbackBody(result.summary, inlineComments);
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

function formatCommentBody(body: string, severity: ReviewResult['comments'][number]['severity']): string {
  const prefix =
    severity === 'blocking'
      ? '🚨 **Blocking**'
      : severity === 'suggestion'
        ? '💡 **Suggestion**'
        : '🔧 **Nit**';
  return `${prefix}\n\n${body}`;
}

function buildFallbackBody(
  summary: string,
  comments: Array<{ path: string; line: number; body: string }>
): string {
  if (comments.length === 0) return summary;

  const commentBlock = comments
    .map((c) => `**\`${c.path}:${c.line}\`**\n${c.body}`)
    .join('\n\n---\n\n');

  return `${summary}\n\n---\n\n### Inline Feedback\n\n${commentBlock}`;
}
