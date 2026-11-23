import { isRecord } from "@keypin/core";
import { parse as parseYaml } from "yaml";

export interface WorkflowRefs {
  secrets: string[];
  vars: string[];
  environments: string[];
  uses: SecretUse[];
  hidesUses: boolean;
  secretspec: (string | null)[];
  runs: SecretspecRun[];
  keypin: string[];
}

export interface SecretspecRun {
  profile: string | null;
  folder: string | null;
  checkouts: Checkout[];
}

export interface Checkout {
  repository: string | null;
  path: string | null;
}

export interface SecretUse {
  environment: string | null;
  secrets: string[];
  fromCaller: boolean;
  secretspec: (string | null)[];
}

export function usesSecrets(workflows: readonly { refs: WorkflowRefs }[]): boolean {
  return workflows.some((w) => w.refs.hidesUses || stored(w.refs.secrets));
}

function stored(secrets: readonly string[]): boolean {
  return secrets.some((name) => !name.startsWith("GITHUB_"));
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
  const inherited = [...secretsIn(data, jobs, passedByCaller)];
  const uses: SecretUse[] = [
    { environment: null, secrets: inherited, fromCaller: passedByCaller, secretspec: [] },
  ];
  const top: Record<string, unknown> = isRecord(data) ? data : {};
  const profiles = new Set<Profile>();
  const runs: SecretspecRun[] = [];
  const pins = new Set<string>();
  for (const job of Object.values(jobs ?? {})) {
    const environment = isRecord(job) ? job.environment : undefined;
    const name = isRecord(environment) ? environment.name : environment;
    const named = typeof name === "string" && name.trim() ? name : null;
    if (named !== null) refs.environments.add(named);
    const callerOwned = passedByCaller && named === null;
    const steps = isRecord(job) && Array.isArray(job.steps) ? job.steps : [];
    for (const step of steps)
      if (isRecord(step) && typeof step.run === "string")
        for (const pin of keypinPins(step.run)) pins.add(pin);
    const own = [...secretsIn(job, steps, callerOwned)];
    const checkouts = steps.flatMap(checkoutOf);
    const parts = steps.map((step) => {
      const found =
        isRecord(job) && isRecord(step) ? secretspecSteps(top, job, step, checkouts) : [];
      runs.push(...found);
      return {
        secrets: [...secretsIn(step, null, callerOwned)],
        secretspec: [...new Set(found.map((run) => run.profile))],
      };
    });
    for (const part of parts) for (const profile of part.secretspec) profiles.add(profile);
    const all = [...own, ...parts.flatMap((part) => part.secrets)];
    if (named?.includes("${{") && stored([...all, ...inherited])) refs.hidesUses = true;
    const everyStep = parts.reduce<Profile[]>(
      (common, part) => common.filter((profile) => part.secretspec.includes(profile)),
      parts[0]?.secretspec ?? [],
    );
    const unread = parts.filter((part) => !part.secretspec.length).flatMap((part) => part.secrets);
    for (const part of [
      { secrets: [...new Set(everyStep.length ? unread : [...own, ...unread])], secretspec: [] },
      ...(everyStep.length ? [{ secrets: own, secretspec: everyStep }] : []),
      ...parts.filter((part) => part.secretspec.length),
    ])
      uses.push({ environment: named?.trim() ?? null, fromCaller: passedByCaller, ...part });
  }
  return {
    secrets: [...refs.secrets],
    vars: [...refs.vars],
    environments: [...refs.environments],
    uses: uses.filter((use) => use.secrets.length),
    hidesUses: refs.hidesUses,
    secretspec: [...profiles],
    runs,
    keypin: [...pins],
  };
}

const KEYPIN_PIN = /(?<![\w@./-])keypin@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![\w.+-])/g;

function withoutComments(script: string): string {
  return script
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let at = 0; at < line.length; at++) {
        const char = line[at];
        if (quote === "'") {
          if (char === "'") quote = null;
        } else if (char === "\\") at++;
        else if (quote === '"') {
          if (char === '"') quote = null;
        } else if (char === '"' || char === "'") quote = char;
        else if (char === "#" && (at === 0 || /\s/.test(line[at - 1] ?? "")))
          return line.slice(0, at);
      }
      return line;
    })
    .join("\n");
}

function keypinPins(script: string): string[] {
  const live = withoutComments(script);
  return [...live.matchAll(KEYPIN_PIN)].flatMap((match) => (match[1] ? [match[1]] : []));
}

const PROFILE_VARIABLE = "SECRETSPEC_PROFILE";
const FILE_VARIABLE = "SECRETSPEC_FILE";
const DEFAULT_PROFILE = "default";

type Profile = string | null;

function secretspecSteps(
  top: Record<string, unknown>,
  job: Record<string, unknown>,
  step: Record<string, unknown>,
  checkouts: Checkout[],
): SecretspecRun[] {
  if (typeof step.run !== "string") return [];
  const env = { ...envOf(top), ...envOf(job), ...envOf(step) };
  const folder =
    env[FILE_VARIABLE] === undefined
      ? folderOf(step["working-directory"] ?? runDefault(job) ?? runDefault(top))
      : null;
  return secretspecRuns(step.run).map((run) => ({
    profile: profileOf(run.profile, env[PROFILE_VARIABLE]),
    folder: run.moved || run.file ? null : folder,
    checkouts,
  }));
}

function checkoutOf(step: unknown): Checkout[] {
  if (!isRecord(step) || typeof step.uses !== "string") return [];
  if (!/^actions\/checkout(?:@|$)/i.test(step.uses.trim())) return [];
  const inputs = isRecord(step.with) ? step.with : {};
  const repository = inputs.repository ?? "";
  if (typeof repository !== "string") return [];
  return [{ repository: repository.trim() || null, path: folderOf(inputs.path) }];
}

function runDefault(scope: Record<string, unknown>): unknown {
  const run = isRecord(scope.defaults) ? scope.defaults.run : undefined;
  return isRecord(run) ? run["working-directory"] : undefined;
}

function folderOf(directory: unknown): string | null {
  if (directory === undefined) return "";
  if (typeof directory !== "string" || /^[/~]|\$/.test(directory.trim())) return null;
  const parts: string[] = [];
  for (const part of directory.trim().split("/"))
    if (part === "..") {
      if (!parts.pop()) return null;
    } else if (part && part !== ".") parts.push(part);
  return parts.join("/");
}

function profileOf(flag: string | undefined, variable: unknown): string | null {
  const given = flag ?? (variable === undefined || variable === "" ? DEFAULT_PROFILE : variable);
  return typeof given === "string" && given && !given.includes("$") ? given : null;
}

function envOf(scope: Record<string, unknown>): Record<string, unknown> {
  return isRecord(scope.env) ? scope.env : {};
}

const SECRETSPEC_RUN = /(?:^|[\s;&|(])(?:[\w.-]*\/)*secretspec\s+run(?=\s|$)([^\n]*)/g;

const CHANGES_FOLDER = /(?:^|[\s;&|(])(?:cd|pushd)(?=\s|$)/;

interface Run {
  profile: string | undefined;
  file: boolean;
  moved: boolean;
}

function secretspecRuns(script: string): Run[] {
  const runs: Run[] = [];
  const text = script.replace(/\\\r?\n/g, " ");
  for (const match of text.matchAll(SECRETSPEC_RUN)) {
    const words = shellWords(match[1] ?? "");
    let profile: string | undefined;
    let file = false;
    for (let i = 0; i < words.length && words[i] !== "--"; i++) {
      const word = words[i] ?? "";
      const [flag = "", inline] = word.startsWith("--") ? word.split(/=(.*)/s) : [word];
      if (flag === "--profile" || flag === "-P") profile = inline ?? words[++i] ?? "";
      else if (/^-P./.test(flag)) profile = flag.slice(2);
      else if (flag === "--file" || flag.startsWith("-f")) file = true;
    }
    runs.push({ profile, file, moved: CHANGES_FOLDER.test(text.slice(0, match.index)) });
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

function events(on: unknown): unknown[] {
  return typeof on === "string"
    ? [on]
    : Array.isArray(on)
      ? on
      : isRecord(on)
        ? Object.keys(on)
        : [];
}

function onlyWorkflowCall(on: unknown): boolean {
  const all = events(on);
  return all.length === 1 && all[0] === "workflow_call";
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
