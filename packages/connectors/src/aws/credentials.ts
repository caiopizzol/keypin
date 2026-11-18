import type { SignInReason } from "@keypin/core";
import type { Credentials } from "./sigv4";

export const KEY_ID = "AWS_ACCESS_KEY_ID";
export const SECRET_KEY = "AWS_SECRET_ACCESS_KEY";
export const SESSION_TOKEN = "AWS_SESSION_TOKEN";
export const PROFILE = "AWS_PROFILE";
const CREDENTIALS_FILE = "AWS_SHARED_CREDENTIALS_FILE";
const CONFIG_FILE = "AWS_CONFIG_FILE";

export const NO_CREDENTIALS = `set ${KEY_ID} and ${SECRET_KEY} (and ${SESSION_TOKEN} for temporary credentials), or ${PROFILE} to a profile with keys in ~/.aws/credentials`;

export type AwsSignIn =
  | { credentials: Credentials; source: string }
  | { problem: string; reason: SignInReason };

const SIGNS_IN_ITSELF: readonly [string, string][] = [
  ["sso_session", "IAM Identity Center (SSO)"],
  ["sso_start_url", "IAM Identity Center (SSO)"],
  ["login_session", "aws login"],
  ["credential_process", "credential_process"],
  ["role_arn", "an assumed role"],
  ["web_identity_token_file", "a web identity token"],
];

type Sections = Map<string, Map<string, string>>;

export function awsSignIn(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  read: (path: string) => string | null,
): AwsSignIn {
  const id = env[KEY_ID]?.trim() ?? "";
  const secret = env[SECRET_KEY]?.trim() ?? "";
  const token = env[SESSION_TOKEN]?.trim() ?? "";
  if (id && secret) {
    const profile = env[PROFILE]?.trim();
    return {
      credentials: { id, secret, ...(token ? { token } : {}) },
      source: `the ${token ? "temporary credentials" : "access key"} in ${KEY_ID}${profile ? `, not the profile in ${PROFILE}` : ""}`,
    };
  }
  if (id || secret)
    return {
      problem: `${id ? KEY_ID : SECRET_KEY} is set but ${id ? SECRET_KEY : KEY_ID} isn't; set both, or neither to use ${PROFILE}`,
      reason: { kind: "no-credentials" },
    };

  const named = env[PROFILE]?.trim() || "";
  const profile = named || "default";
  const credentialsFile = env[CREDENTIALS_FILE]?.trim() || `${home}/.aws/credentials`;
  const configFile = env[CONFIG_FILE]?.trim() || `${home}/.aws/config`;
  const fromCredentials = sections(read(credentialsFile) ?? "").get(profile);
  const config = sections(read(configFile) ?? "");
  const fromConfig = config.get(profile === "default" ? "default" : `profile ${profile}`);
  if (!fromCredentials && !fromConfig)
    return named
      ? {
          problem: `${PROFILE} names the profile ${profile}, which isn't in ${credentialsFile} or ${configFile}`,
          reason: { kind: "other" },
        }
      : { problem: NO_CREDENTIALS, reason: { kind: "no-credentials" } };
  const settings = new Map([...(fromConfig ?? []), ...(fromCredentials ?? [])]);
  const itself = SIGNS_IN_ITSELF.find(([setting]) => settings.has(setting));
  if (itself)
    return {
      problem: `the AWS profile ${profile} signs in with ${itself[1]}, which keypin doesn't do itself; run eval "$(aws configure export-credentials --profile ${profile} --format env)" first, so keypin uses the temporary credentials it exports`,
      reason: { kind: "other" },
    };
  const profileId = settings.get("aws_access_key_id") ?? "";
  const profileSecret = settings.get("aws_secret_access_key") ?? "";
  const profileToken = settings.get("aws_session_token") ?? "";
  if (!profileId || !profileSecret)
    return {
      problem: `the AWS profile ${profile} has no aws_access_key_id and aws_secret_access_key; ${NO_CREDENTIALS}`,
      reason: { kind: "no-credentials" },
    };
  return {
    credentials: {
      id: profileId,
      secret: profileSecret,
      ...(profileToken ? { token: profileToken } : {}),
    },
    source: `the AWS profile ${profile}`,
  };
}

function sections(text: string): Sections {
  const found: Sections = new Map();
  let current: Map<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[\s*(.+?)\s*\]$/.exec(line);
    if (header) {
      const name = (header[1] ?? "").replace(/\s+/g, " ");
      current = found.get(name) ?? new Map();
      found.set(name, current);
      continue;
    }
    const at = line.indexOf("=");
    if (current === null || at < 0 || /^\s/.test(raw)) continue;
    current.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return found;
}
