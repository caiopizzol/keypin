import { parseArgs } from "node:util";
import { UsageError } from "../../deps";

export interface Request {
  envFile: string;
  names: string[];
  vault: string;
  account: string | undefined;
  env: string | undefined;
  yes: boolean;
  args: string[];
}

export function parseRequest(args: string[]): Request {
  const { values, positionals } = parseArgs({
    args,
    options: {
      vault: { type: "string" },
      account: { type: "string" },
      env: { type: "string" },
      yes: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const [envFile, ...names] = positionals;
  if (envFile === undefined)
    throw new UsageError("keypin import takes an env file, such as .env or .dev.vars");
  const vault = values.vault?.trim();
  if (!vault)
    throw new UsageError("--vault is required: the 1Password vault to create the items in");
  if (vault.includes("/")) throw new UsageError("--vault is a vault name, without /");
  const account = values.account?.trim();
  if (values.account !== undefined && !account)
    throw new UsageError("--account is your 1Password sign-in address, such as my.1password.com");
  return {
    envFile,
    names: [...new Set(names)],
    vault,
    account,
    env: values.env,
    yes: values.yes,
    args,
  };
}
