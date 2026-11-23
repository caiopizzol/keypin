import { envFileProfile, type KeysMap, type ProjectScan } from "@keypin/core";

const SECRETSPEC_DEFAULT = "default";

export function saveCommands(
  users: readonly { key: string; environment: string }[],
  envFiles: ProjectScan["envFiles"],
  map: Pick<KeysMap, "environments">,
): string[] {
  const [user, ...others] = users;
  if (!user || others.length || user.environment === SECRETSPEC_DEFAULT) return [];
  const { key, environment: profile } = user;
  const set = `  secretspec set ${key} --profile ${profile}`;
  const from = (path: string) => `  SECRETSPEC_PROFILE=${profile} secretspec import dotenv:${path}`;
  const each = "Each profile has its own items.";
  const setting = envFiles.filter((file) => file.kind === "set" && file.names.includes(key));
  const own = setting.find((file) => envFileProfile(file.path, map) === profile);
  const other = setting[0];
  if (own) return [`${each} Save the ${profile} value from ${own.path}:`, from(own.path)];
  if (other)
    return [
      `${each} If ${other.path} holds the ${profile} value:`,
      from(other.path),
      "Otherwise:",
      set,
    ];
  return [`${each} Save the ${profile} value:`, set];
}
