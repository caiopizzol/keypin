import { isAbsolute, relative } from "node:path";
import { type ItemIds, type KeyRef, messageOf, shellWord } from "@keypin/core";
import type { Deps } from "./deps";
import { confirm, type Output } from "./output";
import { lookUpIds } from "./publishing";

export const NEEDS_APPROVAL = 3;

export function withoutPlan(args: readonly string[]): string[] {
  return args.filter((arg) => arg !== "--plan");
}

export function rerun(deps: Deps, command: string, args: readonly string[]): string {
  return `To approve, run this in a terminal:\n  ${commandLine(deps, command, withoutPlan(args))}`;
}

export function commandLine(deps: Deps, command: string, args: readonly string[]): string {
  const words = [...deps.self.command, command, ...args].map(shellWord).join(" ");
  const folder = checkoutFolder(deps);
  return folder === "" ? words : `cd ${shellWord(folder)} && ${words}`;
}

function checkoutFolder(deps: Deps): string {
  if (deps.ciCheckout === null) return deps.self.folder;
  const inside = relative(deps.ciCheckout, deps.self.folder);
  return inside.startsWith("..") || isAbsolute(inside) ? deps.self.folder : inside;
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

export async function unattendedApproval(
  deps: Deps,
  out: Output,
  gate: {
    plan: boolean;
    command: string;
    args: readonly string[];
    refs: readonly KeyRef[];
    approvals: (ids: readonly (ItemIds | null)[]) => readonly { approval: string }[];
    nothing: string;
    stopped: string;
    ids?: readonly ItemIds[];
  },
): Promise<number | null> {
  if (deps.isTerminal || gate.plan) return null;
  const say = (text: string) => out.line(text);
  let approvals = gate.approvals(gate.ids ?? []);
  if (!approvals.length && !gate.ids) {
    try {
      approvals = gate.approvals(await lookUpIds(gate.refs, deps, out));
    } catch (error) {
      say(`Stopped: couldn't find the item: ${messageOf(error)}. ${gate.nothing}`);
      return 1;
    }
  }
  if (!approvals.length) return null;
  say("Needs approval:");
  for (const needed of approvals) say(`  ${needed.approval}`);
  say(gate.stopped);
  say(rerun(deps, gate.command, gate.args));
  return NEEDS_APPROVAL;
}
