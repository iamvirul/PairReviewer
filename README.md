# PairReviewer

An AI-powered GitHub Action that acts as a dedicated code reviewer on your pull requests, using [GitHub Models](https://github.com/marketplace/models) to review diffs, post inline comments, and approve PRs once all feedback is addressed.

## How It Works

1. A PR is opened or new commits are pushed
2. PairReviewer checks if there are **unresolved review threads** from the reviewer account
   - If yes → posts a reminder comment and waits
   - If no → proceeds to review
3. The diff is sent to a GitHub Models AI (default: `gpt-4.1`)
4. The AI posts a review **as your reviewer account** with:
   - Inline comments on specific lines
   - An overall verdict: `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`
5. When the author pushes new commits addressing the feedback, the cycle repeats automatically

## Setup

### Step 1 — Create a reviewer GitHub account

This is the account that will post reviews. It needs to be added as a **collaborator** with Write access to your repository (so its approvals count toward branch protection rules).

### Step 2 — Generate a PAT for the reviewer account

Log in as the reviewer account and create a **Personal Access Token** with these scopes:

| Scope | Why |
|-------|-----|
| `repo` | Read PR diffs and post reviews |
| `read:user` | Identify the reviewer account to prevent event loops |

### Step 3 — Add the PAT as a repo secret

In your repository: **Settings → Secrets and variables → Actions → New repository secret**

Name it `REVIEWER_PAT`.

### Step 4 — Add the workflow to your repository

Create `.github/workflows/pair-reviewer.yml`:

```yaml
name: PairReviewer

on:
  pull_request:
    types: [opened, synchronize, reopened]
  pull_request_review:
    types: [submitted]
  workflow_dispatch:

jobs:
  review:
    name: AI Code Review
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - uses: virulnirmala/PairReviewer@v1
        with:
          reviewer-token: ${{ secrets.REVIEWER_PAT }}
```

That's it. Open a PR and the reviewer account will post its first review within seconds.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `reviewer-token` | Yes | (required) | PAT of the reviewer GitHub account |
| `github-token` | No | `${{ github.token }}` | Token for reading PR data and calling GitHub Models |
| `model` | No | `openai/gpt-4.1` | GitHub Models model ID |
| `approve-on-clean` | No | `true` | Set to `false` to post COMMENT instead of APPROVE |
| `max-diff-chars` | No | `120000` | Max diff characters sent to the model |

## Supported Models

Any model available in [GitHub Marketplace Models](https://github.com/marketplace/models). Recommended:

| Model ID | Best for |
|----------|----------|
| `openai/gpt-4.1` | Best overall code review quality (default) |
| `openai/gpt-4o` | Faster, slightly lower quality |
| `meta/llama-4-maverick` | Open model alternative |

## Review Cycle

```
PR opened / commits pushed
        │
        ▼
Unresolved threads from reviewer?
   YES → Post reminder comment → stop
   NO  ▼
Fetch PR diff
        │
        ▼
GitHub Models AI review
        │
        ├─ Blocking issues found → REQUEST_CHANGES + inline comments
        └─ No issues → APPROVE
                │
                ▼
        Author addresses feedback
        → Pushes commits → cycle repeats
```

## Branch Protection (Recommended)

To enforce reviews before merging:

1. **Settings → Branches → Branch protection rules** for `main`
2. Enable **Require a pull request before merging**
3. Enable **Require approvals** → set to `1`
4. Add the reviewer account under **Restrict who can dismiss pull request reviews**

Now PRs cannot merge until the AI reviewer approves.

## Notes

- The action skips events triggered by the reviewer account itself to prevent infinite loops
- If the AI returns invalid line numbers (outside the diff), inline comments fall back to the review body
- Large diffs are truncated at `max-diff-chars`; increase for large PRs if needed
- GitHub Models API calls use your repository's `GITHUB_TOKEN` (free tier rate limits apply)

## Publishing to GitHub Marketplace

1. Push this repository to GitHub
2. Tag a release: `git tag v1.0.0 && git push origin v1.0.0`
3. The release workflow automatically rebuilds `dist/` and creates a `v1` major tag
4. Go to the release on GitHub → click **Publish this Action to the GitHub Marketplace**
