import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  loadRotationFile,
  rotationFile,
  writeRotationFile,
  loadState,
  messageOf,
  publishEnvironment,
} from "@keypin/core";
import { type Deps, UsageError } from "../../deps";
import { output, tilde } from "../../output";
import { findMap, pickEnvironment, ROTATION_FILE } from "../../project";
import { writeStatus } from "../status";
import { locked } from "../../publishing";
import { registerProject } from "../../register";
import { type Context, jobFor } from "./job";
import { rotateDue, checkDue, approveAll } from "./due";
import { rotateLocked } from "./rotate-key";

export async function rotate(args: string[], deps: Deps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      profile: { type: "string" },
      yes: { type: "boolean", default: false },
      plan: { type: "boolean", default: false },
      due: { type: "boolean", default: false },
      "approve-revoke": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      discard: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const approve = values["approve-revoke"];
  const [keyId, ...extra] = positionals;
  if (values.due && approve)
    throw new UsageError("--due and --approve-revoke are separate runs; use one");
  if (values.due && positionals.length)
    throw new UsageError("--due takes no key: it rotates every key that is due");
  if (approve && values.plan) throw new UsageError("--approve-revoke takes no --plan");
  if (values.discard && (values.due || approve || values.check))
    throw new UsageError("--discard takes one key: keypin rotate <VARIABLE> --discard");
  if (values.check && (positionals.length || values.due || approve || values.plan || values.yes))
    throw new UsageError("--check takes only --profile: it checks every key --due rotates");
  if (extra.length || (keyId === undefined && !values.due && !approve && !values.check))
    throw new UsageError("keypin rotate takes one key: the variable name");
  const map = await findMap(deps);
  const environment = pickEnvironment(map, values.profile, publishEnvironment(map));
  if (!values.plan && !values.check) await registerProject(deps, dirname(map.file));
  const envArgs = environment === publishEnvironment(map) ? [] : ["--profile", environment];
  const out = output(deps.stderr, deps.styled.stderr, deps.columns);
  const file = join(dirname(map.file), ROTATION_FILE);
  const committed = await loadRotationFile(deps.files, file);
  const flags = {
    yes: values.yes,
    plan: values.plan,
    due: values.due,
    approve,
    check: values.check,
    discard: values.discard,
    args,
  };
  const context = { map, environment, envArgs, committed, deps, out };
  return locked(deps, async (path) => {
    const code = values.check
      ? await checkDue(context, path)
      : approve
        ? await approveAll(context, keyId, path)
        : values.due
          ? await rotateDue(context, flags, path)
          : await rotateLocked({ ...jobFor(context, keyId ?? "", flags), path });
    if (values.plan || values.check) return code;
    if (!approve && !values.due && committed === null) {
      if (code === 0) out.line(notRecorded(envArgs));
      return code;
    }
    return (await commitState(context, file, path)) ? code : 1;
  });
}

async function commitState(context: Context, file: string, path: string): Promise<boolean> {
  const { map, committed, deps, out } = context;
  try {
    const state = await loadState(deps.files, path, deps.vaults);
    const next = await rotationFile(state, map, deps.destinations, committed);
    if ((await writeRotationFile(deps.files, file, next)) === "written")
      out.line(`${out.mark(true)} wrote ${tilde(file, deps.home)}`);
    return await writeStatus(deps, map, true);
  } catch (error) {
    out.line(`keypin couldn't write ${ROTATION_FILE}: ${messageOf(error)}`);
    return false;
  }
}

function notRecorded(envArgs: readonly string[]): string {
  const due = ["keypin rotate --due", ...envArgs].join(" ");
  return `\nThis rotation is recorded only on this machine: ${ROTATION_FILE} doesn't exist. For scheduled rotation, run ${due} and commit .keypin/.`;
}
