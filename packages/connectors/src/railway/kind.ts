import { type DestinationKind, type Prerequisite, sentence } from "@keypin/core";
import { RailwayVariablesDestination, REDEPLOY } from "./railway";
import { railwaySignIn, signInProblem, TOKEN_VARIABLE, TOKENS_PAGE } from "./token";

export type RailwayTarget = {
  to: "railway-service";
  account: string;
  environment: string;
  service: string;
};

type Env = Readonly<Record<string, string | undefined>>;

export interface RailwayPublisher {
  signInEnv: Env;
}

export interface RailwayHost {
  readonly env: Env;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

function prerequisites(env: Env): Prerequisite[] {
  if (env[TOKEN_VARIABLE]?.trim()) return [];
  return [
    {
      name: "Railway",
      status: "not logged in",
      fix: `set ${TOKEN_VARIABLE} to a Railway token (${TOKENS_PAGE})`,
      title: "Sign in to Railway",
      body: [sentence(signInProblem(env))],
      coversFailures: true,
    },
  ];
}

const place = ({ environment, service }: RailwayTarget) => `${environment}/${service}`;

export const railwayService: DestinationKind<RailwayTarget, RailwayPublisher, RailwayHost> = {
  kind: "railway-service",
  label: "Railway",
  parse(read) {
    read.only(["project", "environment", "service"]);
    const project = read.filledIn(
      read.required("project"),
      "project",
      "the Railway project's ID, from Project Settings or Cmd/Ctrl+K in the project",
    );
    const environment = read.filledIn(
      read.required("environment"),
      "environment",
      "the Railway environment's name, such as production, or its ID",
    );
    const service = read.filledIn(
      read.required("service"),
      "service",
      "the Railway service's name or ID",
    );
    if (project !== undefined && !ID.test(project))
      read.fail(
        `field "project" must be the project's ID, such as 1d01c0c0-4554-4747-93b8-34ce3448ab95`,
      );
    for (const [field, value] of [
      ["environment", environment],
      ["service", service],
    ] as const)
      if (value !== undefined && !NAME.test(value))
        read.fail(
          `field "${field}" must use only letters, digits, ".", "_" and "-"; use the ${field}'s ID if its name has others`,
        );
    return project === undefined || environment === undefined || service === undefined
      ? undefined
      : { to: "railway-service", account: project, environment, service };
  },
  id: place,
  secretId: (target, secretName) => `${target.account}/${place(target)}:${secretName}`,
  checkId: (target) => `${target.account}/${place(target)}`,
  fromId(id, pinned) {
    const [environment, service, ...rest] = id.split("/");
    return environment && service && !rest.length && !id.includes(":")
      ? { to: "railway-service", account: pinned, environment, service }
      : undefined;
  },
  describe: ({ environment, service }) => `${service} (${environment})`,
  named: ({ environment, service }) => `the Railway service ${service} (${environment})`,
  where: ({ environment, service }) => `the Railway service ${service} (${environment})`,
  login: () => `the token in ${TOKEN_VARIABLE}`,
  signInVariables: [TOKEN_VARIABLE],
  writeNote: REDEPLOY,
  publisher: async (host) => ({ fields: { signInEnv: host.env } }),
  prerequisites: async ({ targets }, host) => (targets.length ? prerequisites(host.env) : []),
  refuses: (secretName) =>
    secretName.startsWith("RAILWAY_")
      ? "Railway reserves names that start with RAILWAY_"
      : undefined,
  connect: ({ account, environment, service }, { signInEnv }) =>
    new RailwayVariablesDestination({
      project: account,
      environment,
      service,
      token: () => railwaySignIn(signInEnv).token(),
    }),
};
