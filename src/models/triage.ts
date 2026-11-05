/** Data models for issue triage. */

/** Raw issue data extracted by the controller. */
export interface IssueData {
  number: number;
  title: string;
  body: string;
}

/** Rendered triage payload ready to be posted as a comment. */
export interface TriageComment {
  body: string;
}
