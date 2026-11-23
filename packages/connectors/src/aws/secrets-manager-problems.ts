import { type JsonReply, returned } from "./api";
import { KEY_ID } from "./credentials";
import type { SecretsManagerRef as Ref } from "./reference";

export function problem(ref: Ref, action: string, reply: JsonReply): string {
  const said = returned(action, reply);
  if (reply.code === "ResourceNotFoundException")
    return `no secret ${ref.name} in ${ref.region} (${said}); check the region and the name; keypin doesn't create a secret, so save it first, such as with secretspec set`;
  if (reply.code === "AccessDeniedException")
    return `the signed-in identity isn't allowed secretsmanager:${action} on the secret, or its KMS key (${said})`;
  if (reply.code === "DecryptionFailure" || reply.code === "EncryptionFailure")
    return `the signed-in identity can't use the secret's KMS key (${said})`;
  return said;
}

export function hidden(text: string, secret: string): string {
  return text.replaceAll(secret, "[hidden]");
}

export function refusedSignIn(
  reply: { status: number; code: string | null },
  source: string,
): string {
  const said = returned("GetCallerIdentity", reply);
  if (reply.code === "ExpiredToken")
    return `the temporary credentials in ${source} expired (${said}); get new ones`;
  if (reply.code === "SignatureDoesNotMatch")
    return `the secret access key in ${source} doesn't match its key ID, or this computer's clock is off (${said})`;
  if (reply.code === "InvalidClientTokenId")
    return `AWS doesn't accept ${source}: the key was deleted or deactivated, or ${KEY_ID} isn't a key ID (${said})`;
  return said;
}
