export {
  accessKeyJson,
  awsFetch,
  type AwsWorld,
  type FakeAws,
  type FakeAwsKey,
  memoryWorld,
} from "./testing-iam";
export {
  type FakeAwsCredentials,
  type FakeAwsSecret,
  type FakeSecretsManager,
  type FakeWebIdentity,
  fileSecrets,
  memorySecrets,
  secretsManagerFetch,
  type SecretsStore,
  WEB_IDENTITY_EXPIRATION,
} from "./testing-secrets-manager";
