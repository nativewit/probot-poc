/** Data models for pull request review. */

/** Raw PR data extracted by the controller. */
export interface PullRequestData {
  number: number;
  title: string;
  body: string;
  repoFullName: string;
}

/** Rendered review payload ready to be posted via createReview. */
export interface ReviewComment {
  body: string;
}
