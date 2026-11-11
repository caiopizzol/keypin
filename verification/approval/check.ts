import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  KeyEntry,
  KeyRef,
  PublishTarget,
  Receipt,
  State,
} from "../../packages/core/src/index";

type Core = typeof import("../../packages/core/src/index");
type Rule = "NoSilentWrite" | "NoStaleSkip" | "ApprovalsAgree";

const here = import.meta.dir;
const repo = resolve(here, "../..");
const coreSrc = join(repo, "packages/core/src");

const SYNC = "f58c3333097fe40b7eb4d04bf14a7ef0ef98d808";
const COVERED = [
  "packages/core/src/plan.ts",
  "packages/core/src/map.ts",
  "packages/core/src/state.ts",
  "packages/core/src/reference.ts",
  "apps/cli/src/commands/publish.ts",
  "apps/cli/src/commands/rotate.ts",
];

const GUARDS: { file: string; code: string; why: string }[] = [
  {
    file: "apps/cli/src/commands/publish.ts",
    code: "needsApproval ||= plan.needsApproval;",
    why: "publish asks for approval when any key's plan needs it",
  },
  {
    file: "apps/cli/src/commands/publish.ts",
    code: "if (request.yes && !needsApproval) return true;",
    why: "publish lets --yes through only when no step needs approval",
  },
  {
    file: "apps/cli/src/commands/publish.ts",
    code: "if (!(await confirmed(deps, needsApproval, request))) return NEEDS_APPROVAL;",
    why: "publish confirms before any write",
  },
  {
    file: "apps/cli/src/commands/publish.ts",
    code: "approvalsFor({ key, environment, mapFile: owner.mapFile, receipts: state.receipts }),",
    why: "publish stops without a terminal before reading, from approvalsFor",
  },
  {
    file: "apps/cli/src/commands/rotate.ts",
    code: 'if (!(await confirmed(run, approvals.length > 0, "make the new token"))) return NEEDS_APPROVAL;',
    why: "a first rotate run confirms from approvalsFor, then publishes without asking again",
  },
  {
    file: "apps/cli/src/commands/rotate.ts",
    code: "if (run.yes && !needsApproval) return true;",
    why: "rotate lets --yes through only when no step needs approval",
  },
];

const MUTANTS: { name: string; file: string; find: string; replace: string; breaks: Rule }[] = [
  {
    name: "skip-account-check",
    file: "plan.ts",
    find: "if (receipt.account.pinned !== target.account) {",
    replace: "if (false) {",
    breaks: "NoSilentWrite",
  },
  {
    name: "skip-item-check",
    file: "plan.ts",
    find: "if (!receipt.source || !sameRef(receipt.source, entry.ref)) {",
    replace: "if (!receipt.source) {",
    breaks: "NoSilentWrite",
  },
  {
    name: "github-name-case",
    file: "map.ts",
    find: ":${secretName.toUpperCase()}`",
    replace: ":${secretName}`",
    breaks: "NoSilentWrite",
  },
  {
    name: "github-repo-case",
    file: "map.ts",
    find: "`github-actions:${target.repo.toLowerCase()}:",
    replace: "`github-actions:${target.repo}:",
    breaks: "NoSilentWrite",
  },
  {
    name: "skip-any-generation",
    file: "plan.ts",
    find: "if (receipt?.generation === generation) {",
    replace: "if (receipt) {",
    breaks: "NoStaleSkip",
  },
  {
    name: "approvals-drop-first-write",
    file: "plan.ts",
    find: "return judge(input).flatMap(({ id, approval }) =>",
    replace: "return judge(input).filter((j) => j.receipt).flatMap(({ id, approval }) =>",
    breaks: "ApprovalsAgree",
  },
];

interface Place {
  label: string;
  target: PublishTarget;
  secret: (name: string) => string;
}

const CF_A = "a".repeat(32);
const CF_B = "b".repeat(32);
const github = (name: string) => `GitHub secret ${name.toUpperCase()} of me/app`;
const PLACES: Place[] = [
  {
    label: "github me/app (account me)",
    target: { to: "github-actions", repo: "me/app", account: "me" },
    secret: github,
  },
  {
    label: "github Me/App (account me)",
    target: { to: "github-actions", repo: "Me/App", account: "me" },
    secret: github,
  },
  {
    label: "github me/app (account org)",
    target: { to: "github-actions", repo: "me/app", account: "org" },
    secret: github,
  },
  {
    label: "worker app (account aaaa…)",
    target: { to: "cloudflare-worker", worker: "app", account: CF_A },
    secret: (name) => `Cloudflare secret ${name} of worker app in account aaaa…`,
  },
  {
    label: "worker app (account bbbb…)",
    target: { to: "cloudflare-worker", worker: "app", account: CF_B },
    secret: (name) => `Cloudflare secret ${name} of worker app in account bbbb…`,
  },
];

interface Item {
  label: string;
  item: string;
  ref: KeyRef;
}

const ref = (account: string, vault: string, item: string): KeyRef => ({
  kind: "1password",
  account,
  vault,
  item,
  section: null,
  field: "password",
});
const ITEMS: Item[] = [
  {
    label: "op://Private/app prod",
    item: "X",
    ref: ref("my.1password.com", "Private", "app prod"),
  },
  {
    label: "op://private/APP PROD (same item, other case)",
    item: "X",
    ref: ref("my.1password.com", "private", "APP PROD"),
  },
  {
    label: "op://Private/app prod 2",
    item: "Y",
    ref: ref("my.1password.com", "Private", "app prod 2"),
  },
  {
    label: "op://Private/app prod in 1Password account other.1password.com",
    item: "Z",
    ref: ref("other.1password.com", "Private", "app prod"),
  },
];
const ENTRY_ITEMS = [ITEMS[0], ITEMS[2]].filter((i): i is Item => i !== undefined);

interface Owner {
  label: string;
  keyId: string;
  environment: string;
  mapFile: string;
}

const SELF: Owner = {
  label: "API_TOKEN (prod) in /p/app",
  keyId: "API_TOKEN",
  environment: "prod",
  mapFile: "/p/app/keypin.toml",
};
const OWNERS: Owner[] = [
  SELF,
  { ...SELF, label: "api_token (prod) in /p/app", keyId: "api_token" },
  { ...SELF, label: "API_TOKEN (prod) in /p/other", mapFile: "/p/other/keypin.toml" },
  { ...SELF, label: "API_TOKEN (dev) in /p/app", environment: "dev" },
];

const NEW = "generation-new";
const OLD = "generation-old";

interface Publish {
  owner: Owner;
  place: Place;
  source: Item | null;
  generation: string;
}

const PUBLISHES: Publish[] = OWNERS.flatMap((owner) =>
  PLACES.flatMap((place) =>
    [...ITEMS, null].flatMap((source) =>
      [NEW, OLD].map((generation) => ({ owner, place, source, generation })),
    ),
  ),
);

const DEPTH = Number(process.env.DEPTH ?? 2);

function* histories(depth: number): Generator<Publish[]> {
  yield [];
  let layer: Publish[][] = [[]];
  for (let n = 1; n <= depth; n++) {
    const next: Publish[][] = [];
    for (const prefix of layer) for (const p of PUBLISHES) next.push([...prefix, p]);
    yield* next;
    layer = next;
  }
}

function* placeLists(): Generator<Place[]> {
  for (let i = 0; i < PLACES.length; i++) {
    const a = PLACES[i];
    if (!a) continue;
    yield [a];
    for (let j = i + 1; j < PLACES.length; j++) {
      const b = PLACES[j];
      if (b) yield [a, b];
    }
  }
}

function stateAfter(core: Core, history: readonly Publish[]): State {
  return history.reduce(
    (state, { owner, place, source, generation }, i): State =>
      core.recordReceipt(state, {
        keyId: owner.keyId,
        environment: owner.environment,
        mapFile: owner.mapFile,
        source: source?.ref ?? null,
        destinationId: core.destinationId(place.target, owner.keyId),
        generation,
        account: {
          pinned: place.target.account,
          publisher: "publisher",
          destinationAccount: place.target.account,
        },
        at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        evidence: {},
      } satisfies Receipt),
    core.emptyState(),
  );
}

function lastWrite(history: readonly Publish[], place: Place): Publish | undefined {
  const secret = place.secret(SELF.keyId);
  return history.filter((p) => p.place.secret(p.owner.keyId) === secret).at(-1);
}

function mayWriteSilently(history: readonly Publish[], place: Place, item: Item): boolean {
  const last = lastWrite(history, place);
  return (
    last !== undefined &&
    last.place.target.account === place.target.account &&
    last.source?.item === item.item
  );
}

interface Broken {
  rule: Rule;
  history: Publish[];
  item: Item;
  places: Place[];
  what: string;
}

function check(core: Core, depth: number): { cases: number; broken: Map<Rule, Broken> } {
  const broken = new Map<Rule, Broken>();
  let cases = 0;
  const fail = (b: Broken) => {
    if (!broken.has(b.rule)) broken.set(b.rule, b);
  };
  for (const history of histories(depth)) {
    const receipts = stateAfter(core, history).receipts;
    for (const item of ENTRY_ITEMS) {
      for (const places of placeLists()) {
        cases++;
        const key: KeyEntry = {
          name: SELF.keyId,
          rotateEvery: null,
          environments: { prod: { ref: item.ref, publish: places.map((p) => p.target) } },
        };
        const input = { key, environment: SELF.environment, mapFile: SELF.mapFile, receipts };
        const plan = core.planPublish({ ...input, generation: NEW });
        const approvals = core.approvalsFor(input);
        plan.steps.forEach((step, i) => {
          const place = places[i];
          if (!place) throw new Error("the plan has more steps than destinations");
          const base = { history, item, places };
          if (
            step.action === "write" &&
            step.approval === null &&
            !mayWriteSilently(history, place, item)
          )
            fail({
              ...base,
              rule: "NoSilentWrite",
              what: `the plan writes ${place.label} without approval (${step.reason})`,
            });
          if (step.action === "skip" && lastWrite(history, place)?.generation !== NEW)
            fail({
              ...base,
              rule: "NoStaleSkip",
              what: `the plan skips ${place.label}, but its last write was ${lastWrite(history, place)?.generation ?? "never"}`,
            });
        });
        const asked = plan.steps.filter((s) => s.approval !== null).map((s) => s.destinationId);
        const listed = approvals.map((a) => a.destinationId);
        if (asked.join("\n") !== listed.join("\n"))
          fail({
            history,
            item,
            places,
            rule: "ApprovalsAgree",
            what: `planPublish asks approval for [${asked.join(", ")}] but approvalsFor lists [${listed.join(", ")}]`,
          });
      }
    }
  }
  return { cases, broken };
}

function story(b: Broken): string {
  const lines = b.history.map(
    (p, i) =>
      `  ${i + 1}. ${p.owner.label} is published from ${p.source?.label ?? "an item its receipt doesn't record"} to ${p.place.label}, ${p.generation}`,
  );
  if (!lines.length) lines.push("  (no earlier publish)");
  return [
    ...lines,
    `  then: publish ${SELF.label} from ${b.item.label} to ${b.places.map((p) => p.label).join(" and ")}, ${NEW}`,
    `  ${b.what}`,
  ].join("\n");
}

async function loadCore(dir: string): Promise<Core> {
  return import(pathToFileURL(join(dir, "index.ts")).href);
}

const say = (text: string) => process.stdout.write(`${text}\n`);
const RULES: Rule[] = ["NoSilentWrite", "NoStaleSkip", "ApprovalsAgree"];
let failed = false;
const started = performance.now();

for (const guard of GUARDS) {
  const text = await readFile(join(repo, guard.file), "utf8");
  if (!text.includes(guard.code)) {
    say(`FAIL  guard missing in ${guard.file} (${guard.why}):\n        ${guard.code}`);
    failed = true;
  }
}

try {
  const changed = execFileSync("git", ["-C", repo, "diff", "--name-only", SYNC, "--", ...COVERED], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (changed)
    say(
      `NOTE  covered code changed since the sync commit ${SYNC.slice(0, 7)}; this run checks that code, but the rules may no longer describe it:\n${changed.replace(/^/gm, "        ")}`,
    );
} catch {
  say(`NOTE  sync commit ${SYNC.slice(0, 7)} isn't in this clone; can't tell what changed`);
}

const real = check(await loadCore(coreSrc), DEPTH);
for (const rule of RULES) {
  const b = real.broken.get(rule);
  if (b) {
    say(`FAIL  ${rule} breaks:\n${story(b)}`);
    failed = true;
  } else say(`ok    ${rule}: holds`);
}

const only = process.argv[2];
if (only !== "--no-mutants") {
  for (const m of MUTANTS) {
    const dir = await mkdtemp(join(tmpdir(), `keypin-approval-${m.name}-`));
    try {
      await cp(coreSrc, dir, { recursive: true });
      const file = join(dir, m.file);
      const text = await readFile(file, "utf8");
      if (text.split(m.find).length !== 2) {
        say(`FAIL  mutant-${m.name}: ${m.file} doesn't contain its code exactly once`);
        failed = true;
        continue;
      }
      await writeFile(file, text.replace(m.find, m.replace));
      const got = check(await loadCore(dir), DEPTH).broken.has(m.breaks);
      if (got) say(`ok    mutant-${m.name}: breaks ${m.breaks}`);
      else {
        say(`FAIL  mutant-${m.name}: ${m.breaks} still holds, so the rule can't see this bug`);
        failed = true;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

say(
  `      ${real.cases} plans checked at depth ${DEPTH} in ${((performance.now() - started) / 1000).toFixed(1)} s`,
);
process.exit(failed ? 1 : 0);
