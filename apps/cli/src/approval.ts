import type { Deps } from "./deps";
import { confirm } from "./output";

export const NEEDS_APPROVAL = 3;

export function withoutPlan(args: readonly string[]): string[] {
  const end = args.includes("--") ? args.indexOf("--") : args.length;
  return [...args.slice(0, end).filter((arg) => arg !== "--plan"), ...args.slice(end)];
}

export function rerun(deps: Deps, command: string, args: readonly string[]): string {
  return `To approve, run this in a terminal:\n  ${commandLine(deps, command, withoutPlan(args))}`;
}

export function commandLine(deps: Deps, command: string, args: readonly string[]): string {
  const words = [...deps.self.command, command, ...args].map(shellWord).join(" ");
  return `cd ${shellWord(deps.self.folder)} && ${words}`;
}

export function planOnly(
  deps: Deps,
  command: string,
  args: readonly string[],
  needsApproval: boolean,
): number {
  const say = (text: string) => deps.stderr.write(`${text}\n`);
  say(
    needsApproval
      ? "\nThis plan needs approval in a terminal; --yes can't give it."
      : "\nThis plan is routine: --yes can approve it.",
  );
  say("Nothing was written: --plan only shows the plan.");
  say(rerun(deps, command, args));
  return NEEDS_APPROVAL;
}

export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

export async function confirmed(
  deps: Deps,
  request: {
    yes: boolean;
    args: string[];
    command: string;
    needsApproval: boolean;
    question: string;
  },
  nothing = "Nothing was written.",
  hint = "Add --yes, or confirm in a terminal.",
): Promise<boolean> {
  const say = (text: string) => deps.stderr.write(`${text}\n`);
  if (request.yes && !request.needsApproval) return true;
  if (deps.isTerminal) {
    if (await confirm(deps, request.question)) return true;
    say(`Not confirmed. ${nothing}`);
    return false;
  }
  say(
    request.needsApproval
      ? `Stopped: this plan needs approval, and --yes can't give it. ${nothing}`
      : `Stopped: no terminal to confirm on. ${nothing} ${hint}`,
  );
  say(rerun(deps, request.command, request.args));
  return false;
}
