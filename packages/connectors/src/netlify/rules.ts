import type { DestinationRules } from "@keypin/core";

export const CONTEXTS = ["production", "deploy-preview", "branch-deploy", "dev-server"];

export type NetlifyTarget = {
  to: "netlify-project";
  account: string;
  project: string;
  context: string;
};

const TEAM = /^[A-Za-z0-9_-]{1,100}$/;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const LETTER_FIRST = /^[A-Za-z]/;

const READ_ONLY = new Set([
  "NETLIFY",
  "BUILD_ID",
  "CONTEXT",
  "NETLIFY_PREVIEW_SERVER",
  "REPOSITORY_URL",
  "BRANCH",
  "HEAD",
  "COMMIT_REF",
  "CACHED_COMMIT_REF",
  "PULL_REQUEST",
  "REVIEW_ID",
  "URL",
  "DEPLOY_URL",
  "DEPLOY_PRIME_URL",
  "DEPLOY_ID",
  "SITE_NAME",
  "SITE_ID",
  "ACCOUNT_ID",
  "INCOMING_HOOK_TITLE",
  "INCOMING_HOOK_URL",
  "INCOMING_HOOK_BODY",
]);

const place = ({ project, context }: NetlifyTarget) => `${project}/${context}`;

export const netlifyProjectRules: DestinationRules<NetlifyTarget> = {
  kind: "netlify-project",
  label: "Netlify",
  parse(read) {
    read.only(["team", "project", "context"]);
    const team = read.filledIn(
      read.required("team"),
      "team",
      "the Netlify team the project belongs to: its slug, from the team's settings",
    );
    const project = read.filledIn(
      read.required("project"),
      "project",
      "the Netlify project's ID, from Project configuration > General, or its domain, such as my-project.netlify.app",
    );
    const context = read.filledIn(
      read.required("context"),
      "context",
      `the Netlify deploy context: ${CONTEXTS.join(", ")}`,
    );
    if (team !== undefined && !TEAM.test(team))
      read.fail(`field "team" must use only letters, digits, "_" and "-"`);
    if (project !== undefined && !PROJECT_ID.test(project) && !DOMAIN.test(project))
      read.fail(
        `field "project" must be the project's ID or its domain, such as ${project}.netlify.app`,
      );
    if (context === "dev")
      read.fail(
        `field "context" can't be "dev": Netlify keeps local development values readable to the team. Run keypin run -- netlify dev instead`,
      );
    else if (context !== undefined && !CONTEXTS.includes(context))
      read.fail(`field "context" must be one of ${CONTEXTS.join(", ")}`);
    return team === undefined || project === undefined || context === undefined
      ? undefined
      : { to: "netlify-project", account: team, project, context };
  },
  id: place,
  secretId: (target, secretName) => `${target.account}/${place(target)}:${secretName}`,
  checkId: (target) => `${target.account}/${place(target)}`,
  fromId(id, pinned) {
    const [project, context, ...rest] = id.split("/");
    return project && context && !rest.length && !id.includes(":")
      ? { to: "netlify-project", account: pinned, project, context }
      : undefined;
  },
  describe: ({ project, context }) => `${project} (${context})`,
  named: ({ project, context }) => `the Netlify project ${project} (${context})`,
  refuses(secretName) {
    if (READ_ONLY.has(secretName)) return `Netlify reserves the name ${secretName}`;
    if (!LETTER_FIRST.test(secretName)) return "Netlify names must start with a letter";
    return undefined;
  },
};
