import { isRecord } from "@keypin/core";
import { parse as parseYaml } from "yaml";

export interface WorkflowRefs {
  secrets: string[];
  vars: string[];
  environments: string[];
  uses: { environment: string | null; secrets: string[]; fromCaller: boolean }[];
  hidesUses: boolean;
}

export function usesSecrets(workflows: readonly { refs: WorkflowRefs }[]): boolean {
  return workflows.some(
    (w) => w.refs.hidesUses || w.refs.secrets.some((name) => !name.startsWith("GITHUB_")),
  );
}

const COMPUTED_SECRET = /(?<![\w.])secrets\s*\[(?!\s*'[A-Za-z_][A-Za-z0-9_]*'\s*\])/i;

const CONTEXT_REF =
  /(?<![\w.])(secrets|vars)\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\])/gi;

export function workflowRefs(text: string): WorkflowRefs | null {
  let data: unknown;
  try {
    data = parseYaml(text, { logLevel: "error" });
  } catch {
    return null;
  }
  const refs = {
    secrets: new Set<string>(),
    vars: new Set<string>(),
    environments: new Set<string>(),
    hidesUses: false,
  };
  const secretsIn = (
    root: unknown,
    skip: unknown,
    callerOwned = false,
    onlyKeypinReads: readonly unknown[] = [],
  ): Set<string> => {
    const secrets = new Set<string>();
    let into = secrets;
    const scan = (expression: string) => {
      if (/toJSON\(\s*secrets\s*\)/i.test(expression) || COMPUTED_SECRET.test(expression))
        refs.hidesUses = true;
      for (const match of expression.matchAll(CONTEXT_REF)) {
        const name = (match[2] ?? match[3])?.toUpperCase();
        if (!name) continue;
        (match[1]?.toLowerCase() === "secrets" ? into : refs.vars).add(name);
      }
    };
    const seen = new Set<unknown>([skip, ...onlyKeypinReads]);
    const visit = (value: unknown, key: string | null) => {
      if (typeof value === "string") {
        if (key === "if" && !value.includes("${{")) scan(withoutStrings(value));
        for (const expression of expressions(value)) scan(expression);
        if (key === "secrets" && value.trim() === "inherit") refs.hidesUses = true;
        return;
      }
      if (typeof value !== "object" || value === null || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) visit(item, null);
      } else if (isRecord(value)) {
        for (const [k, v] of Object.entries(value)) visit(v, k);
      }
    };
    visit(root, null);
    const keypinCredentials = new Set<string>();
    into = keypinCredentials;
    for (const step of onlyKeypinReads) {
      seen.delete(step);
      visit(step, null);
    }
    if (callerOwned) secrets.clear();
    for (const name of secrets) refs.secrets.add(name);
    return secrets;
  };
  const passedByCaller = onlyWorkflowCall(isRecord(data) ? data.on : undefined);
  const jobs = isRecord(data) && isRecord(data.jobs) ? data.jobs : null;
  const uses: WorkflowRefs["uses"] = [
    {
      environment: null,
      secrets: [...secretsIn(data, jobs, passedByCaller)],
      fromCaller: passedByCaller,
    },
  ];
  for (const job of Object.values(jobs ?? {})) {
    const environment = isRecord(job) ? job.environment : undefined;
    const name = isRecord(environment) ? environment.name : environment;
    const named = typeof name === "string" && name.trim() ? name : null;
    if (named !== null) refs.environments.add(named);
    uses.push({
      environment: named?.trim() ?? null,
      secrets: [
        ...secretsIn(job, null, passedByCaller && named === null, stepsOnlyKeypinReads(job)),
      ],
      fromCaller: passedByCaller,
    });
  }
  return {
    secrets: [...refs.secrets],
    vars: [...refs.vars],
    environments: [...refs.environments],
    uses: uses.filter((use) => use.secrets.length),
    hidesUses: refs.hidesUses,
  };
}

const KEYPIN_COMMAND_NOT_RUN =
  /^(?:(?:npx|bunx)\s+(?:--yes\s+|-y\s+)?)?keypin(?:@\S+)?\s+(?!run\b)[a-z]/;
const ONE_COMMAND = /^(?:[^\n;&|`$]|\$(?!\())*$/;
const GH_LOGIN = /^(?:(?:echo|printf)\s[^;&|]*\|\s*)?gh\s+auth\s+login\s[^;&|]*$/;

function stepsOnlyKeypinReads(job: unknown): unknown[] {
  const steps: unknown[] = isRecord(job) && Array.isArray(job.steps) ? job.steps : [];
  const command = (step: unknown) =>
    isRecord(step) && typeof step.run === "string" && !("uses" in step)
      ? step.run.replaceAll(/\$\{\{[\s\S]*?\}\}/g, "''").trim()
      : "";
  const keypin = steps.filter((step) => {
    const run = command(step);
    return ONE_COMMAND.test(run) && KEYPIN_COMMAND_NOT_RUN.test(run);
  });
  return keypin.length ? [...keypin, ...steps.filter((step) => GH_LOGIN.test(command(step)))] : [];
}

function onlyWorkflowCall(on: unknown): boolean {
  const events =
    typeof on === "string" ? [on] : Array.isArray(on) ? on : isRecord(on) ? Object.keys(on) : [];
  return events.length === 1 && events[0] === "workflow_call";
}

function expressions(text: string): string[] {
  const found: string[] = [];
  for (let start = text.indexOf("${{"); start !== -1; start = text.indexOf("${{", start)) {
    let i = start + 3;
    while (i < text.length && !text.startsWith("}}", i))
      i = text[i] === "'" ? endOfString(text, i) : i + 1;
    found.push(withoutStrings(text.slice(start + 3, i)));
    start = i + 2;
  }
  return found;
}

function withoutStrings(expression: string): string {
  let code = "";
  for (let i = 0; i < expression.length;) {
    if (expression[i] !== "'") {
      code += expression[i];
      i++;
      continue;
    }
    const end = endOfString(expression, i);
    const literal = expression.slice(i, end);
    code += /(?:secrets|vars)\s*\[\s*$/i.test(code) ? literal : "''";
    i = end;
  }
  return code;
}

function endOfString(text: string, open: number): number {
  let i = open + 1;
  while (i < text.length) {
    if (text[i] !== "'") i++;
    else if (text[i + 1] === "'") i += 2;
    else return i + 1;
  }
  return i;
}
