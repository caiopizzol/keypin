import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { parseObject } from "@keypin/core";
import { TOKEN_URL } from "./auth";

export function serviceAccountJson(
  email: string,
  privateKey: string,
  keyId = "fake-key-id",
): string {
  return JSON.stringify({
    type: "service_account",
    project_id: email.split("@")[1]?.split(".")[0] ?? "fake",
    private_key_id: keyId,
    private_key: privateKey,
    client_email: email,
    token_uri: TOKEN_URL,
  });
}

export function fakePrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

export const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });
export const refuse = (status: number, code: string, message: string, details: unknown[] = []) =>
  reply(status, { error: { code: status, message, status: code, details } });

export interface TokenSigner {
  serviceAccount: string;
  privateKey: string;
  tokenPrefix?: string;
}

export function token(fake: TokenSigner, body: string | undefined, issued: Set<string>): Response {
  const form = new URLSearchParams(body ?? "");
  const [header = "", claims = "", signature = ""] = (form.get("assertion") ?? "").split(".");
  const decoded = (part: string) => parseObject(Buffer.from(part, "base64url").toString());
  const signed = verify(
    "sha256",
    Buffer.from(`${header}.${claims}`),
    createPublicKey(fake.privateKey),
    Buffer.from(signature, "base64url"),
  );
  const said = decoded(claims);
  if (
    form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" ||
    decoded(header).alg !== "RS256" ||
    !signed ||
    said.iss !== fake.serviceAccount ||
    said.aud !== TOKEN_URL ||
    typeof said.scope !== "string"
  )
    return reply(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
  const value = `${fake.tokenPrefix ?? "ya29.fake-"}${issued.size + 1}`;
  issued.add(value);
  return reply(200, { access_token: value, expires_in: 3599, token_type: "Bearer" });
}
