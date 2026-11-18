import { definePlugin, defineRule } from "vite-plus/lint/plugins";
import type { Definition, ESTree, Reference, Scope, SourceCode } from "vite-plus/lint/plugins";

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
  /^packages\/connectors\/src\/[^/]+\//,
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
        "Don't read a Secret's raw value here. Compare it with secret.equals(), secret.isEmpty() or secret.includes(), or keep the value inside a connector, which hands it to the account it belongs to.",
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

function globalUses(source: SourceCode): Reference["identifier"][] {
  const uses: Reference["identifier"][] = [];
  for (const scope of source.scopeManager.scopes) {
    for (const { identifier, resolved } of scope.references) {
      if (resolved?.defs.some(existsAtRuntime) || TYPE_POSITIONS.has(identifier.parent.type))
        continue;
      uses.push(identifier);
    }
  }
  return uses;
}

const AMBIENT = ["process", "fetch", "Bun", ...GLOBAL_OBJECTS];

const noAmbient = defineRule({
  meta: {
    messages: {
      ambient:
        "Don't reach the outside world from core or a command: no process, fetch, Bun or the global object (globalThis, self, window, global). Take it from deps (deps.env, deps.files, deps.vault(), deps.launch…) so the command stays testable, and use Date or Math directly so no-hidden-clock sees them. See docs/development.md#guardrails.",
    },
  },
  create(context) {
    if (!inLogic(context)) return {};
    return {
      Program() {
        for (const use of globalUses(context.sourceCode))
          if (AMBIENT.includes(use.name)) context.report({ messageId: "ambient", node: use });
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
          const node = outer(use);
          const parent = node.parent;
          if (parent?.type === "NewExpression" && parent.callee === node && use.name === "Date")
            if (parent.arguments.length === 0) context.report({ messageId: "clock", node: parent });
          for (const read of reads(use) ?? []) {
            if (read.name !== null && !members.includes(read.name)) continue;
            if (!allowed.includes(`${use.name}.${read.name}`))
              context.report({ messageId: "clock", node: read.node });
          }
        }
      },
    };
  },
});

const TEXT_TESTS = new Set(["includes", "startsWith", "endsWith", "search"]);
const CASE_CHANGES = new Set(["toLowerCase", "toUpperCase", "trim"]);
const EQUALITY = new Set(["===", "!==", "==", "!="]);

const TEXT_MATCH_ALLOWED = [/^packages\/connectors\/src\/onepassword\/backend\.ts$/];

type Held = "text" | "match" | null;

function propertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.property.type === "Literal" && typeof node.property.value === "string")
    return node.property.value;
  return null;
}

const isNullish = (node: ESTree.Node) =>
  (node.type === "Literal" && node.value === null) ||
  (node.type === "Identifier" && node.name === "undefined");

const noErrorTextMatching = defineRule({
  meta: {
    messages: {
      text: "Don't branch on an error's text. Throw a typed error from @keypin/core, like SignInFailed or HeldForApproval, and check it with instanceof. See docs/development.md#guardrails.",
    },
  },
  create(context) {
    if (TEXT_MATCH_ALLOWED.some((allowed) => allowed.test(repoPath(context.physicalFilename))))
      return {};
    const report = (node: ESTree.Node) => context.report({ messageId: "text", node });

    const constant = (node: ESTree.Node, name: string): ESTree.Expression | null => {
      for (
        let scope: Scope | null = context.sourceCode.getScope(node);
        scope;
        scope = scope.upper
      ) {
        const variable = scope.set.get(name);
        if (!variable) continue;
        const [def] = variable.defs;
        if (variable.defs.length !== 1 || def?.type !== "Variable") return null;
        if (def.parent?.type !== "VariableDeclaration" || def.parent.kind !== "const") return null;
        return def.node.type === "VariableDeclarator" ? def.node.init : null;
      }
      return null;
    };

    const held = (node: ESTree.Node, seen = new Set<ESTree.Node>()): Held => {
      if (seen.has(node)) return null;
      seen.add(node);
      const either = (...nodes: ESTree.Node[]): Held => {
        const kinds = nodes.map((each) => held(each, seen));
        return kinds.includes("match") ? "match" : kinds.includes("text") ? "text" : null;
      };
      if (
        node.type === "ChainExpression" ||
        node.type === "TSNonNullExpression" ||
        node.type === "TSAsExpression"
      )
        return held(node.expression, seen);
      if (node.type === "LogicalExpression") return either(node.left, node.right);
      if (node.type === "ConditionalExpression") return either(node.consequent, node.alternate);
      if (node.type === "Identifier") {
        const init = constant(node, node.name);
        return init ? held(init, seen) : null;
      }
      if (node.type === "MemberExpression") {
        if (node.property.type === "Literal" && typeof node.property.value === "number")
          return held(node.object, seen) === null ? null : "text";
        const name = propertyName(node);
        return name === "message" || name === "problem" ? "text" : null;
      }
      if (node.type !== "CallExpression") return null;
      if (node.callee.type === "Identifier")
        return node.callee.name === "messageOf" ? "text" : null;
      if (node.callee.type !== "MemberExpression") return null;
      const name = propertyName(node.callee);
      if (CASE_CHANGES.has(name ?? "")) return held(node.callee.object, seen);
      if (name === "match") return held(node.callee.object, seen) ? "match" : null;
      if (name === "exec" && node.arguments[0])
        return held(node.arguments[0], seen) ? "match" : null;
      return null;
    };

    const reported = new Set<ESTree.Node>();
    const tested = (node: ESTree.Node) => {
      if (reported.has(node) || held(node) !== "match") return;
      reported.add(node);
      report(node);
    };

    const condition = (node: ESTree.Node | null | undefined) => {
      if (!node) return;
      if (node.type === "UnaryExpression" && node.operator === "!") return condition(node.argument);
      if (node.type === "LogicalExpression") {
        condition(node.left);
        return condition(node.right);
      }
      tested(node);
    };

    return {
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "Boolean" &&
          node.arguments[0]
        )
          tested(node.arguments[0]);
        if (node.callee.type !== "MemberExpression") return;
        const name = propertyName(node.callee);
        if (TEXT_TESTS.has(name ?? "") && held(node.callee.object)) report(node);
        else if (name === "test" && node.arguments[0] && held(node.arguments[0])) report(node);
      },
      BinaryExpression(node) {
        if (!EQUALITY.has(node.operator)) return;
        const [text, other] = held(node.left) ? [node.left, node.right] : [node.right, node.left];
        const kind = held(text);
        if (kind === "match" || (kind === "text" && !isNullish(other))) report(node);
      },
      SwitchStatement(node) {
        if (held(node.discriminant)) report(node.discriminant);
      },
      UnaryExpression(node) {
        if (node.operator === "!" && node.argument.type !== "UnaryExpression")
          tested(node.argument);
      },
      LogicalExpression(node) {
        if (node.operator !== "??") tested(node.left);
      },
      IfStatement: (node) => condition(node.test),
      ConditionalExpression: (node) => condition(node.test),
      WhileStatement: (node) => condition(node.test),
      DoWhileStatement: (node) => condition(node.test),
      ForStatement: (node) => condition(node.test),
    };
  },
});

const EXACT_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual", "toContain"]);
export const COPIED_LINES = 4;

function textLines(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

function knownText(node: ESTree.Node | null): string | null {
  if (node?.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node?.type === "TemplateLiteral")
    return node.quasis.map((quasi) => quasi.value.cooked ?? "").join("${}");
  return null;
}

function outputLines(node: ESTree.Node): number {
  const text = knownText(node);
  if (text !== null) return textLines(text);
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression" ||
    node.callee.object.type !== "ArrayExpression" ||
    propertyName(node.callee) !== "join"
  )
    return 0;
  const separator = knownText(node.arguments[0] ?? null);
  if (separator === null || !separator.includes("\n")) return 0;
  const parts = node.callee.object.elements.map((element) =>
    element?.type === "SpreadElement" ? null : knownText(element),
  );
  return parts.every((part) => part !== null)
    ? textLines(parts.join(separator))
    : node.callee.object.elements.length;
}

const noHandCopiedOutput = defineRule({
  meta: {
    messages: {
      copied:
        "Don't write out output by hand. Record it with toMatchFileSnapshot, then read the recording, so a change in behavior shows up as a diff.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        if (!EXACT_MATCHERS.has(propertyName(node.callee) ?? "")) return;
        const [expected] = node.arguments;
        if (expected && outputLines(expected) >= COPIED_LINES)
          context.report({ messageId: "copied", node: expected });
      },
    };
  },
});

export default definePlugin({
  meta: { name: "keypin" },
  rules: {
    "no-hand-copied-output": noHandCopiedOutput,
    "no-comments": noComments,
    "no-reveal": noReveal,
    "no-ambient": noAmbient,
    "no-hidden-clock": noHiddenClock,
    "no-error-text-matching": noErrorTextMatching,
  },
});
