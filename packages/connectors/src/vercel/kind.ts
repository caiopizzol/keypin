import { type DestinationKind, type Prerequisite, sentence } from "@keypin/core";
import { signInProblem, TOKEN_VARIABLE, TOKENS_PAGE, vercelSignIn } from "./token";
import { NAME, REDEPLOY, STANDARD, VercelEnvDestination } from "./vercel";

export type VercelTarget = {
  to: "vercel-project";
  account: string;
  project: string;
  environment: string;
};

type Env = Readonly<Record<string, string | undefined>>;

export interface VercelPublisher {
  signInEnv: Env;
}

export interface VercelHost {
  readonly env: Env;
}

const RESERVED = new Set([
  "AWS_SECRET_KEY",
  "AWS_EXECUTION_ENV",
  "AWS_LAMBDA_LOG_GROUP_NAME",
  "AWS_LAMBDA_LOG_STREAM_NAME",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
  "AWS_LAMBDA_FUNCTION_VERSION",
  "NOW_REGION",
  "TZ",
  "LAMBDA_TASK_ROOT",
  "LAMBDA_RUNTIME_DIR",
  "_HANDLER",
  "AWS_ACCESS_KEY",
  "PATH",
  "HOME",
  "TEMP",
]);

function prerequisites(env: Env): Prerequisite[] {
  if (env[TOKEN_VARIABLE]?.trim()) return [];
  return [
    {
      name: "Vercel",
      status: "not logged in",
      fix: `set ${TOKEN_VARIABLE} to a Vercel token (${TOKENS_PAGE})`,
      title: "Sign in to Vercel",
      body: [sentence(signInProblem(env))],
      coversFailures: true,
    },
  ];
}

const place = ({ project, environment }: VercelTarget) => `${project}/${environment}`;

export const vercelProject: DestinationKind<VercelTarget, VercelPublisher, VercelHost> = {
  kind: "vercel-project",
  label: "Vercel",
  parse(read) {
    read.only(["team", "project", "environment"]);
    const team = read.filledIn(
      read.required("team"),
      "team",
      "the Vercel team the project belongs to: its ID (team_...) or its slug, from the team's settings",
    );
    const project = read.filledIn(
      read.required("project"),
      "project",
      "the Vercel project's name or ID (prj_...)",
    );
    const environment = read.filledIn(
      read.required("environment"),
      "environment",
      `the Vercel environment: ${STANDARD.join(", ")}, or a custom environment's name`,
    );
    for (const [field, value] of [
      ["team", team],
      ["project", project],
      ["environment", environment],
    ] as const)
      if (value !== undefined && !NAME.test(value))
        read.fail(`field "${field}" must use only letters, digits, ".", "_" and "-"`);
    return team === undefined || project === undefined || environment === undefined
      ? undefined
      : { to: "vercel-project", account: team, project, environment };
  },
  id: place,
  secretId: (target, secretName) => `${target.account}/${place(target)}:${secretName}`,
  checkId: (target) => `${target.account}/${place(target)}`,
  fromId(id, pinned) {
    const [project, environment, ...rest] = id.split("/");
    return project && environment && !rest.length && !id.includes(":")
      ? { to: "vercel-project", account: pinned, project, environment }
      : undefined;
  },
  describe: ({ project, environment }) => `${project} (${environment})`,
  named: ({ project, environment }) => `the Vercel project ${project} (${environment})`,
  where: ({ project, environment }) => `the Vercel project ${project} (${environment})`,
  login: () => `the token in ${TOKEN_VARIABLE}`,
  signInVariables: [TOKEN_VARIABLE],
  writeNote: REDEPLOY,
  publisher: async (host) => ({ fields: { signInEnv: host.env } }),
  prerequisites: async ({ targets }, host) => (targets.length ? prerequisites(host.env) : []),
  refuses: (secretName) =>
    RESERVED.has(secretName) ? `Vercel reserves the name ${secretName}` : undefined,
  connect: ({ account, project, environment }, { signInEnv }) =>
    new VercelEnvDestination({
      team: account,
      project,
      environment,
      token: () => vercelSignIn(signInEnv).token(),
    }),
};
