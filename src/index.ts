import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  getReviewerLogin,
  getReviewThreads,
  hasBlockingUnresolvedThreads,
  getPRDiff,
  postReview,
  postBlockedComment,
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

  const prContext = extractPRContext(context, owner, repo);
  if (!prContext) {
    core.info('Event does not contain a pull request. Skipping.');
    return;
  }

  core.info(`PairReviewer — PR #${prContext.prNumber}: "${prContext.title}"`);

  const reviewerLogin = await getReviewerLogin(reviewerToken);
  core.info(`Reviewer account: @${reviewerLogin}`);

  // Skip if this event was triggered by the reviewer bot itself (prevents loops)
  const eventSender = context.payload.sender?.login as string | undefined;
  if (eventSender === reviewerLogin) {
    core.info('Event was triggered by the reviewer account itself. Skipping to prevent loops.');
    return;
  }

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

  // Downgrade APPROVE to COMMENT when approve-on-clean is disabled
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

export function extractPRContext(
  context: typeof github.context,
  owner: string,
  repo: string
): PRContext | null {
  // Both pull_request and pull_request_review events carry a pull_request object
  const rawPR = (context.payload.pull_request ?? context.payload['pull_request']) as PRPayload | undefined;
  if (!rawPR) return null;

  return {
    owner,
    repo,
    prNumber: rawPR.number,
    title: rawPR.title,
    body: rawPR.body ?? '',
    headSha: rawPR.head.sha,
  };
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(`PairReviewer failed: ${message}`);
});
