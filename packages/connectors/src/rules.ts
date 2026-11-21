import type { IssuerRules, IssuerSpec } from "@keypin/core";
import { awsIssuerRules, secretsManagerVaultRules } from "./aws/rules";
import { bitwardenVaultRules } from "./bitwarden/rules";
import { cloudflareIssuerRules } from "./cloudflare/rules";
import { dopplerVaultRules } from "./doppler/rules";
import { elevenlabsIssuerRules } from "./elevenlabs/rules";
import { googleIssuerRules, googleServiceAccountIssuerRules } from "./google/rules";
import { infisicalVaultRules } from "./infisical/rules";
import { atlasIssuerRules } from "./mongodb-atlas/rules";
import { neonIssuerRules } from "./neon/rules";
import { onePasswordVaultRules } from "./onepassword/rules";
import { openaiIssuerRules } from "./openai/rules";
import { openrouterIssuerRules } from "./openrouter/rules";
import { resendIssuerRules } from "./resend/rules";
import { sendgridIssuerRules } from "./sendgrid/rules";
import { supabaseIssuerRules } from "./supabase/rules";
import { twilioIssuerRules } from "./twilio/rules";
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
  dopplerVaultRules,
  elevenlabsIssuerRules,
  googleIssuerRules,
  googleServiceAccountIssuerRules,
  infisicalVaultRules,
  neonIssuerRules,
  onePasswordVaultRules,
  openaiIssuerRules,
  openrouterIssuerRules,
  resendIssuerRules,
  secretsManagerVaultRules,
  sendgridIssuerRules,
  supabaseIssuerRules,
  twilioIssuerRules,
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
