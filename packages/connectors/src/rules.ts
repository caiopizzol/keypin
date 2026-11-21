import type { IssuerRules, IssuerSpec } from "@keypin/core";
import { awsIssuerRules, secretsManagerVaultRules } from "./aws/rules";
import { bitwardenVaultRules } from "./bitwarden/rules";
import { cloudflareIssuerRules, cloudflareWorkerRules } from "./cloudflare/rules";
import { convexDeploymentRules } from "./convex/rules";
import { dopplerVaultRules } from "./doppler/rules";
import { elevenlabsIssuerRules } from "./elevenlabs/rules";
import { flyAppRules } from "./fly/rules";
import { githubActionsRules, githubPull } from "./github/rules";
import { gitlabGroupRules, gitlabProjectRules } from "./gitlab/rules";
import { googleIssuerRules, googleServiceAccountIssuerRules } from "./google/rules";
import { infisicalVaultRules } from "./infisical/rules";
import { atlasIssuerRules } from "./mongodb-atlas/rules";
import { netlifyProjectRules } from "./netlify/rules";
import { neonIssuerRules } from "./neon/rules";
import { onePasswordVaultRules } from "./onepassword/rules";
import { openaiIssuerRules } from "./openai/rules";
import { openrouterIssuerRules } from "./openrouter/rules";
import { railwayServiceRules } from "./railway/rules";
import { resendIssuerRules } from "./resend/rules";
import { sendgridIssuerRules } from "./sendgrid/rules";
import { supabaseFunctionsRules, supabaseIssuerRules } from "./supabase/rules";
import { twilioIssuerRules } from "./twilio/rules";
import { vercelProjectRules } from "./vercel/rules";
import { xaiIssuerRules } from "./xai/rules";

const ENCODINGS = ["base64", "hex"] as const;
const BETTER_AUTH = ["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS"];
const BETTER_AUTH_DOCS = "https://better-auth.com/docs/reference/options#secrets";

export interface RandomSpec extends IssuerSpec {
  readonly kind: "random";
  readonly encoding: (typeof ENCODINGS)[number];
}

export const randomIssuerRules = {
  kind: "random",
  admin: false,
  parse(read) {
    read.only(["encoding"]);
    const given = read.optional("encoding");
    const encoding = given === undefined ? "base64" : ENCODINGS.find((known) => known === given);
    if (encoding === undefined) {
      read.fail(`field "encoding" must be one of: ${ENCODINGS.join(", ")}`);
      return undefined;
    }
    return { kind: "random", encoding };
  },
  refuses: (keyName) =>
    BETTER_AUTH.includes(keyName)
      ? `Better Auth encrypts two-factor secrets and OAuth tokens with it, and a new value can't read them. Add a version to BETTER_AUTH_SECRETS by hand instead: ${BETTER_AUTH_DOCS}`
      : undefined,
} satisfies IssuerRules<RandomSpec>;

export const destinations = [
  githubActionsRules,
  cloudflareWorkerRules,
  vercelProjectRules,
  supabaseFunctionsRules,
  netlifyProjectRules,
  railwayServiceRules,
  convexDeploymentRules,
  flyAppRules,
  gitlabProjectRules,
  gitlabGroupRules,
];

export const pulls = [githubPull];

export const vaults = [
  infisicalVaultRules,
  bitwardenVaultRules,
  dopplerVaultRules,
  secretsManagerVaultRules,
  onePasswordVaultRules,
];

export const issuers = [
  resendIssuerRules,
  neonIssuerRules,
  openaiIssuerRules,
  supabaseIssuerRules,
  cloudflareIssuerRules,
  openrouterIssuerRules,
  googleIssuerRules,
  googleServiceAccountIssuerRules,
  elevenlabsIssuerRules,
  awsIssuerRules,
  sendgridIssuerRules,
  twilioIssuerRules,
  xaiIssuerRules,
  atlasIssuerRules,
  randomIssuerRules,
];

export {
  atlasIssuerRules,
  awsIssuerRules,
  bitwardenVaultRules,
  cloudflareIssuerRules,
  cloudflareWorkerRules,
  convexDeploymentRules,
  dopplerVaultRules,
  elevenlabsIssuerRules,
  flyAppRules,
  githubActionsRules,
  githubPull,
  gitlabGroupRules,
  gitlabProjectRules,
  googleIssuerRules,
  googleServiceAccountIssuerRules,
  infisicalVaultRules,
  neonIssuerRules,
  netlifyProjectRules,
  onePasswordVaultRules,
  openaiIssuerRules,
  openrouterIssuerRules,
  railwayServiceRules,
  resendIssuerRules,
  secretsManagerVaultRules,
  sendgridIssuerRules,
  supabaseFunctionsRules,
  supabaseIssuerRules,
  twilioIssuerRules,
  vercelProjectRules,
  xaiIssuerRules,
};
export type { AtlasSpec } from "./mongodb-atlas/rules";
export type { AwsSpec } from "./aws/rules";
export type { CloudflareTokenSpec } from "./cloudflare/rules";
export type { ElevenLabsSpec } from "./elevenlabs/rules";
export type { GoogleServiceAccountSpec, GoogleSpec } from "./google/rules";
export type { NeonSpec } from "./neon/rules";
export type { OpenAISpec } from "./openai/rules";
export type { OpenRouterSpec } from "./openrouter/rules";
export type { ResendSpec } from "./resend/rules";
export type { SendGridSpec } from "./sendgrid/rules";
export type { SupabaseSpec } from "./supabase/rules";
export type { TwilioSpec } from "./twilio/rules";
export type { XaiSpec } from "./xai/rules";
export type { BitwardenRef } from "./bitwarden/reference";
export type { DopplerRef } from "./doppler/reference";
export type { InfisicalRef } from "./infisical/reference";
export type { OnePasswordRef } from "./onepassword/reference";
export type { SecretsManagerRef } from "./aws/reference";
export type { ConvexTarget } from "./convex/rules";
export type { FlyTarget } from "./fly/rules";
export type { GitHubPull, GitHubTarget } from "./github/rules";
export type { GitLabGroupTarget, GitLabProjectTarget } from "./gitlab/rules";
export type { NetlifyTarget } from "./netlify/rules";
export type { RailwayTarget } from "./railway/rules";
export type { SupabaseFunctionsTarget } from "./supabase/rules";
export type { VercelTarget } from "./vercel/rules";
export type { WorkerTarget } from "./cloudflare/rules";
