import { definePlugin, defineRule } from "vite-plus/lint/plugins";
import type { Definition, ESTree, SourceCode } from "vite-plus/lint/plugins";

const noComments = defineRule({
  meta: { messages: { comment: "Remove this comment; make the code say it." } },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type !== "Shebang") context.report({ messageId: "comment", node: comment });
        }
      },
    };
  },
});

export function repoPath(file: string, plugin: string = import.meta.url): string {
  const repo = decodeURIComponent(new URL(".", plugin).pathname).replace(/^\/(?=[A-Za-z]:)/, "");
  const path = file.replaceAll("\\", "/");
  return path.startsWith(repo) ? path.slice(repo.length) : path;
}

const REVEAL_ALLOWED = [
  /^packages\/(vault|destination|issuer)-[^/]+\/src\//,
  /^packages\/core\/src\/secret\.ts$/,
  /^apps\/cli\/src\/commands\/run\.ts$/,
  /^(apps|packages)\/[^/]+\/tests\//,
];

function keyName(key: ESTree.Node, computed: boolean): string | null {
  if (key.type === "Literal") return typeof key.value === "string" ? key.value : null;
  if (key.type === "TemplateLiteral")
    return key.expressions.length === 0 ? (key.quasis[0]?.value.cooked ?? null) : null;
  return !computed && key.type === "Identifier" ? key.name : null;
}

function namesReveal(key: ESTree.Node, computed: boolean): boolean {
  return keyName(key, computed) === "reveal";
}

const noReveal = defineRule({
  meta: {
    messages: {
      reveal:
        "Don't read a Secret's raw value here. Compare it with secret.equals(), secret.isEmpty() or secret.includes(), or keep the value inside a vault or destination package, which hands it to the account it belongs to.",
    },
  },
  create(context) {
    const path = repoPath(context.physicalFilename);
    if (REVEAL_ALLOWED.some((allowed) => allowed.test(path))) return {};
    return {
      MemberExpression(node) {
        if (namesReveal(node.property, node.computed))
          context.report({ messageId: "reveal", node: node.property });
      },
      ObjectPattern(node) {
        for (const property of node.properties) {
          if (property.type === "Property" && namesReveal(property.key, property.computed))
            context.report({ messageId: "reveal", node: property.key });
        }
      },
    };
  },
});

const LOGIC = [/^packages\/core\/src\//, /^apps\/cli\/src\/commands\//];

function inLogic(context: { physicalFilename: string }): boolean {
  const path = repoPath(context.physicalFilename);
  return LOGIC.some((scope) => scope.test(path));
}

const GLOBAL_OBJECTS = ["globalThis", "self", "window", "global"];
const TYPE_POSITIONS = new Set([
  "TSTypeQuery",
  "TSTypeReference",
  "TSQualifiedName",
  "TSClassImplements",
  "TSInterfaceHeritage",
]);
const WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

const RUNTIME_BINDINGS = new Set([
  "CatchClause",
  "ClassName",
  "FunctionName",
  "Parameter",
  "TSEnumName",
  "TSModuleName",
  "Variable",
]);

function existsAtRuntime(definition: Definition): boolean {
  const { node, parent } = definition;
  if (definition.type === "ImportBinding")
    return !(
      (parent?.type === "ImportDeclaration" && parent.importKind === "type") ||
      (node.type === "ImportSpecifier" && node.importKind === "type")
    );
  if (!RUNTIME_BINDINGS.has(definition.type) || node.type === "TSDeclareFunction") return false;
  const declaration = definition.type === "Variable" ? parent : node;
  return !(declaration && "declare" in declaration && declaration.declare === true);
}

function outer(node: ESTree.Node): ESTree.Node {
  let current = node;
  while (
    current.parent &&
    WRAPPERS.has(current.parent.type) &&
    "expression" in current.parent &&
    current.parent.expression === current
  )
    current = current.parent;
  return current;
}

interface Read {
  name: string | null;
  node: ESTree.Node;
}

function reads(value: ESTree.Node): Read[] | null {
  const node = outer(value);
  const parent = node.parent;
  if (parent?.type === "MemberExpression" && parent.object === node)
    return [{ name: keyName(parent.property, parent.computed), node: parent }];
  const pattern =
    parent?.type === "VariableDeclarator" && parent.init === node
      ? parent.id
      : parent?.type === "AssignmentExpression" && parent.right === node
        ? parent.left
        : null;
  if (!pattern) return null;
  if (pattern.type !== "ObjectPattern") return [{ name: null, node }];
  return pattern.properties.map((property) =>
    property.type === "Property"
      ? { name: keyName(property.key, property.computed), node: property.key }
      : { name: null, node: property },
  );
}

interface GlobalUse {
  name: string;
  node: ESTree.Node;
}

function globalUses(source: SourceCode): GlobalUse[] {
  const uses: GlobalUse[] = [];
  for (const scope of source.scopeManager.scopes) {
    for (const { identifier, resolved } of scope.references) {
      if (resolved?.defs.some(existsAtRuntime) || TYPE_POSITIONS.has(identifier.parent.type))
        continue;
      const members = GLOBAL_OBJECTS.includes(identifier.name) ? reads(identifier) : null;
      if (!members) uses.push({ name: identifier.name, node: identifier });
      else
        for (const member of members)
          uses.push({ name: member.name ?? identifier.name, node: member.node });
    }
  }
  return uses;
}

const AMBIENT = ["process", "fetch", "Bun", ...GLOBAL_OBJECTS];

const noAmbient = defineRule({
  meta: {
    messages: {
      ambient:
        "Don't reach the outside world from core or a command: no process, fetch, Bun or globalThis. Take it from deps (deps.env, deps.files, deps.vault(), deps.launch…) so the command stays testable. See docs/development.md#guardrails.",
    },
  },
  create(context) {
    if (!inLogic(context)) return {};
    return {
      Program() {
        for (const use of globalUses(context.sourceCode))
          if (AMBIENT.includes(use.name)) context.report({ messageId: "ambient", node: use.node });
      },
    };
  },
});

const CLOCK = new Map([
  ["Date", ["now"]],
  ["Math", ["random"]],
  ["crypto", ["randomUUID", "getRandomValues"]],
  ["performance", ["now"]],
]);

const CLOCK_ALLOWED = new Map([["packages/core/src/files.ts", ["crypto.randomUUID"]]]);

const noHiddenClock = defineRule({
  meta: {
    messages: {
      clock:
        "Don't read the clock or randomness in core or a command. Use deps.now(), or take the value as an argument, so tests control it. See docs/development.md#guardrails.",
    },
  },
  create(context) {
    if (!inLogic(context)) return {};
    const allowed = CLOCK_ALLOWED.get(repoPath(context.physicalFilename)) ?? [];
    return {
      Program() {
        for (const use of globalUses(context.sourceCode)) {
          const members = CLOCK.get(use.name);
          if (!members) continue;
          const node = outer(use.node);
          const parent = node.parent;
          if (parent?.type === "NewExpression" && parent.callee === node && use.name === "Date")
            if (parent.arguments.length === 0) context.report({ messageId: "clock", node: parent });
          for (const read of reads(use.node) ?? []) {
            if (read.name !== null && !members.includes(read.name)) continue;
            if (!allowed.includes(`${use.name}.${read.name}`))
              context.report({ messageId: "clock", node: read.node });
          }
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: "keypin" },
  rules: {
    "no-comments": noComments,
    "no-reveal": noReveal,
    "no-ambient": noAmbient,
    "no-hidden-clock": noHiddenClock,
  },
});
