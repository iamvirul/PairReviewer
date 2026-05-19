export type ReviewVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
export type CommentSeverity = 'blocking' | 'suggestion' | 'nit';

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  severity: CommentSeverity;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  comments: ReviewComment[];
}

export interface PRContext {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  body: string;
  headSha: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  authorLogin: string;
}
