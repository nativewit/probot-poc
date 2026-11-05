import { Probot } from "probot";
import { handleIssuesOpened } from "./controllers/issue.controller.js";
import { handlePullRequest } from "./controllers/pull-request.controller.js";

export default (app: Probot) => {
  // AI triage: comment possible solutions/opinions on new issues.
  app.on("issues.opened", async (context) => {
    try {
      await handleIssuesOpened(context);
    } catch (error) {
      context.log.error(error, "AI issue triage failed");
    }
  });

  // AI code review: comment a review on new PRs and on new commits.
  app.on(
    ["pull_request.opened", "pull_request.synchronize"],
    async (context) => {
      try {
        await handlePullRequest(context);
      } catch (error) {
        context.log.error(error, "AI PR review failed");
      }
    },
  );
  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/
};
