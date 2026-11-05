/** Review view — renders LLM output as a PR review body. */

export function renderReviewComment(review: string): string {
  return `🤖 **AI Code Review**\n\n${review}`;
}
