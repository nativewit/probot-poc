import type { Context } from "probot";
import { chat, truncate } from "./llm.js";

const SYSTEM_PROMPT = `You are a senior software engineer performing code reviews.
Review the pull request diff and respond with:
1. A one-line summary of what the PR does.
2. Findings as a bullet list: bugs, security issues, performance concerns, style problems. Reference file names. If there are none, say the changes look good.
3. One or two concrete suggestions (optional).
Be concise (max ~300 words). Use GitHub-flavored markdown. Do not invent code that is not in the diff.`;

/** Max tokens of diff we send to the model. */
const MAX_DIFF_TOKENS = 6000;

export async function reviewPullRequest(
  context: Context<"pull_request.opened" | "pull_request.synchronize">,
): Promise<void> {
  const { pull_request: pr, repository } = context.payload;

  // Skip bots (including our own app) and drafts to avoid loops/noise.
  if (pr.draft || pr.user?.type === "Bot") return;

  context.log.info(`Reviewing PR #${pr.number} in ${repository.full_name}`);

  const diffResponse = await context.octokit.rest.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: pr.number,
    mediaType: { format: "diff" },
  });
  const diff = truncate(
    String(diffResponse.data),
    MAX_DIFF_TOKENS,
  );

  const review = await chat([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `PR title: ${pr.title}\nPR body:\n${pr.body ?? "(none)"}\n\nDiff:\n\`\`\`diff\n${diff}\n\`\`\``,
    },
  ]);

  await context.octokit.rest.pulls.createReview({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: pr.number,
    event: "COMMENT",
    body: `🤖 **AI Code Review**\n\n${review}`,
  });

  context.log.info(`Posted AI review on PR #${pr.number}`);
}
