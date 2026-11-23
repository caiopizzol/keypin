import { envFileSuffix, type ProjectScan, shellWord } from "@keypin/core";

const SECRETSPEC_DEFAULT = "default";

export function saveCommands(
  users: readonly { key: string; environment: string }[],
  envFiles: ProjectScan["envFiles"],
): string[] {
  const [user, ...others] = users;
  if (!user || others.length || user.environment === SECRETSPEC_DEFAULT) return [];
  const { key, environment: profile } = user;
  const each = "Each profile has its own items.";
  const own = envFiles.find(
    (file) =>
      file.kind === "set" &&
      file.names.includes(key) &&
      envFileSuffix(file.path.split("/").at(-1) ?? "") === profile,
  );
  if (own)
    return [
      `${each} Save the ${profile} value from ${own.path}:`,
      `  SECRETSPEC_PROFILE=${shellWord(profile)} secretspec import ${shellWord(`dotenv:${own.path}`)}`,
    ];
  const set = ["secretspec", "set", key, "--profile", profile].map(shellWord).join(" ");
  return [`${each} Save the ${profile} value:`, `  ${set}`];
}
