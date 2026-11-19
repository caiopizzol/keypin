import { isRecord } from "@keypin/core";
import { parse as parseYaml } from "yaml";

export interface WorkflowRefs {
  secrets: string[];
  vars: string[];
  environments: string[];
  uses: { environment: string | null; secrets: string[]; fromCaller: boolean }[];
  runs: KeypinRun[];
  hidesUses: boolean;
}

export interface KeypinRun {
  environment: string | null;
  env: string | null;
  dynamicEnv: boolean;
  only: string[] | null;
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
  const secretsIn = (root: unknown, skip: unknown, callerOwned = false): Set<string> => {
    const secrets = new Set<string>();
    const scan = (expression: string) => {
      if (/toJSON\(\s*secrets\s*\)/i.test(expression) || COMPUTED_SECRET.test(expression))
        refs.hidesUses = true;
      for (const match of expression.matchAll(CONTEXT_REF)) {
        const name = (match[2] ?? match[3])?.toUpperCase();
        if (!name) continue;
        (match[1]?.toLowerCase() === "secrets" ? secrets : refs.vars).add(name);
      }
    };
    const seen = new Set<unknown>([skip]);
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
  const runs: KeypinRun[] = [];
  for (const job of Object.values(jobs ?? {})) {
    const environment = isRecord(job) ? job.environment : undefined;
    const name = isRecord(environment) ? environment.name : environment;
    const named = typeof name === "string" && name.trim() ? name : null;
    if (named !== null) refs.environments.add(named);
    for (const script of scripts(job))
      for (const run of keypinRuns(script))
        runs.push({ environment: named?.trim() ?? null, ...run });
    const secrets = [...secretsIn(job, null, passedByCaller && named === null)];
    if (named?.includes("${{") && secrets.length) refs.hidesUses = true;
    uses.push({ environment: named?.trim() ?? null, secrets, fromCaller: passedByCaller });
  }
  return {
    secrets: [...refs.secrets],
    vars: [...refs.vars],
    environments: [...refs.environments],
    uses: uses.filter((use) => use.secrets.length),
    runs,
    hidesUses: refs.hidesUses,
  };
}

function scripts(job: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown, key: string | null) => {
    if (typeof value === "string") {
      if (key === "run") found.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, null);
    } else if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) visit(v, k);
    }
  };
  visit(job, null);
  return found;
}

const KEYPIN_RUN = /(?:^|[\s;&|(])(?:[\w.-]*\/)*keypin(?:@[\w.^~-]+)?\s+run(?=\s|$)([^\n]*)/g;

function keypinRuns(script: string): Omit<KeypinRun, "environment">[] {
  const runs: Omit<KeypinRun, "environment">[] = [];
  for (const match of script.replace(/\\\r?\n/g, " ").matchAll(KEYPIN_RUN)) {
    const words = shellWords(match[1] ?? "");
    let env: string | null = null;
    let dynamicEnv = false;
    let only: string[] | null = null;
    for (let i = 0; i < words.length; i++) {
      const [flag = "", inline] = (words[i] ?? "").split(/=(.*)/s);
      if (flag !== "--env" && flag !== "--only") break;
      const value = inline ?? words[++i] ?? "";
      const plain = !value.includes("$");
      if (flag === "--env") {
        env = plain ? value : null;
        dynamicEnv = !plain;
      } else if (!plain) {
        only = null;
        break;
      } else only = [...(only ?? []), ...value.split(",").map((name) => name.trim())];
    }
    runs.push({ env, dynamicEnv, only });
  }
  return runs;
}

function shellWords(line: string): string[] {
  const words: string[] = [];
  let text = "";
  let started = false;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (quote === "'") {
      if (c === "'") quote = null;
      else text += c;
    } else if (c === "\\" && (quote === null || /["\\$`]/.test(line[i + 1] ?? ""))) {
      text += line[++i] ?? "";
      started = true;
    } else if (c === quote) quote = null;
    else if (quote === null && (c === "'" || c === '"')) {
      quote = c;
      started = true;
    } else if (quote === null && /\s/.test(c)) {
      if (started) words.push(text);
      text = "";
      started = false;
    } else {
      text += c;
      started = true;
    }
  }
  if (started) words.push(text);
  return words;
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
