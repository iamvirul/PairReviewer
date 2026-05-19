import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  getReviewerLogin,
  getReviewThreads,
  hasBlockingUnresolvedThreads,
  getPRDetails,
  getPRDiff,
  postReview,
  postBlockedComment,
  reactToComment,
} from './github-client';
import { generateReview } from './models-client';
import type { PRContext } from './types';

async function run(): Promise<void> {
  const reviewerToken = core.getInput('reviewer-token', { required: true });
  const githubToken = core.getInput('github-token', { required: true });
  const model = core.getInput('model') || 'openai/gpt-4.1';
  const approveOnClean = core.getInput('approve-on-clean') !== 'false';
  const maxDiffChars = parseInt(core.getInput('max-diff-chars') || '120000', 10);

  const { context } = github;
  const { owner, repo } = context.repo;

  const reviewerLogin = await getReviewerLogin(reviewerToken);
  core.info(`Reviewer account: @${reviewerLogin}`);

  // Skip events triggered by the reviewer bot itself to prevent loops
  const eventSender = context.payload.sender?.login as string | undefined;
  if (eventSender === reviewerLogin) {
    core.info('Event was triggered by the reviewer account itself. Skipping to prevent loops.');
    return;
  }

  // For issue_comment events: only proceed if the comment mentions the reviewer
  if (context.eventName === 'issue_comment') {
    const commentBody = (context.payload.comment?.body as string | undefined) ?? '';
    if (!commentBody.includes(`@${reviewerLogin}`)) {
      core.info(`Comment does not mention @${reviewerLogin}. Skipping.`);
      return;
    }

    // Only act on PR comments, not plain issue comments
    const issue = context.payload.issue as { number: number; pull_request?: unknown } | undefined;
    if (!issue?.pull_request) {
      core.info('Comment is on an issue, not a pull request. Skipping.');
      return;
    }

    core.info(`@${reviewerLogin} mentioned in PR #${issue.number} — triggering review.`);

    // React with 👀 so the author knows the bot has picked up the request
    const commentId = context.payload.comment?.id as number | undefined;
    if (commentId) {
      await reactToComment(reviewerToken, owner, repo, commentId);
    }
  }

  const prContext = await extractPRContext(context, owner, repo, githubToken);
  if (!prContext) {
    core.info('Event does not contain a pull request. Skipping.');
    return;
  }

  core.info(`PairReviewer — PR #${prContext.prNumber}: "${prContext.title}"`);

  const threads = await getReviewThreads(githubToken, prContext);
  core.info(`Found ${threads.length} review thread(s)`);

  const blocked = hasBlockingUnresolvedThreads(threads, reviewerLogin);
  if (blocked) {
    const unresolvedCount = threads.filter(
      (t) => !t.isResolved && !t.isOutdated && t.authorLogin === reviewerLogin
    ).length;
    core.info(`${unresolvedCount} unresolved thread(s) from reviewer. Posting blocked comment.`);
    await postBlockedComment(reviewerToken, prContext, unresolvedCount);
    return;
  }

  core.info('No blocking unresolved threads. Fetching diff...');
  const diff = await getPRDiff(githubToken, prContext);

  if (!diff || diff.trim().length === 0) {
    core.warning('PR diff is empty. Nothing to review.');
    return;
  }

  core.info(`Diff size: ${diff.length} chars. Generating review with model: ${model}`);
  const reviewResult = await generateReview(
    githubToken,
    model,
    prContext.title,
    prContext.body,
    diff,
    maxDiffChars
  );

  core.info(
    `Review complete — verdict: ${reviewResult.verdict}, ` +
      `${reviewResult.comments.length} comment(s)`
  );

  if (!approveOnClean && reviewResult.verdict === 'APPROVE') {
    reviewResult.verdict = 'COMMENT';
    core.info('approve-on-clean=false — downgraded APPROVE to COMMENT');
  }

  await postReview(reviewerToken, prContext, reviewResult);
}

export interface PRPayload {
  number: number;
  title: string;
  body: string | null;
  head: { sha: string };
}

export async function extractPRContext(
  context: typeof github.context,
  owner: string,
  repo: string,
  githubToken: string
): Promise<PRContext | null> {
  // pull_request and pull_request_review events carry a pull_request object directly
  const rawPR = context.payload.pull_request as PRPayload | undefined;
  if (rawPR) {
    return {
      owner,
      repo,
      prNumber: rawPR.number,
      title: rawPR.title,
      body: rawPR.body ?? '',
      headSha: rawPR.head.sha,
    };
  }

  // issue_comment events: fetch the PR details via API since the payload only has issue data
  if (context.eventName === 'issue_comment') {
    const issue = context.payload.issue as { number: number; pull_request?: unknown } | undefined;
    if (!issue?.pull_request) return null;

    const details = await getPRDetails(githubToken, owner, repo, issue.number);
    return {
      owner,
      repo,
      prNumber: issue.number,
      title: details.title,
      body: details.body,
      headSha: details.headSha,
    };
  }

  return null;
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(`PairReviewer failed: ${message}`);
});
