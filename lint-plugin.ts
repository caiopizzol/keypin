import { definePlugin, defineRule } from "vite-plus/lint/plugins";
import type { ESTree, Scope, SourceCode } from "vite-plus/lint/plugins";

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

function namesReveal(key: ESTree.Node, computed: boolean): boolean {
  if (key.type === "Literal") return key.value === "reveal";
  if (key.type === "TemplateLiteral")
    return key.expressions.length === 0 && key.quasis[0]?.value.cooked === "reveal";
  return !computed && key.type === "Identifier" && key.name === "reveal";
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

function isGlobal(node: ESTree.Node, name: string, sourceCode: SourceCode): boolean {
  if (node.type !== "Identifier" || node.name !== name) return false;
  for (let scope: Scope | null = sourceCode.getScope(node); scope; scope = scope.upper) {
    if (scope.type !== "global" && scope.set.has(name)) return false;
  }
  return true;
}

function propertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.property.type === "Literal" && typeof node.property.value === "string")
    return node.property.value;
  return null;
}

const noAmbient = defineRule({
  meta: {
    messages: {
      ambient:
        "Don't reach the outside world from core or a command. Take it from deps (deps.env, deps.files, deps.vault(), deps.launch…) so the command stays testable. See docs/development.md#guardrails.",
    },
  },
  create(context) {
    if (!inLogic(context)) return {};
    const source = context.sourceCode;
    return {
      MemberExpression(node) {
        const name = propertyName(node);
        if (
          (isGlobal(node.object, "process", source) && name === "env") ||
          isGlobal(node.object, "Bun", source)
        )
          context.report({ messageId: "ambient", node });
      },
      CallExpression(node) {
        if (isGlobal(node.callee, "fetch", source))
          context.report({ messageId: "ambient", node: node.callee });
      },
    };
  },
});

const noHiddenClock = defineRule({
  meta: {
    messages: {
      clock:
        "Don't read the clock or randomness in core or a command. Use deps.now(), or take the value as an argument, so tests control it. See docs/development.md#guardrails.",
    },
  },
  create(context) {
    if (!inLogic(context)) return {};
    const source = context.sourceCode;
    return {
      NewExpression(node) {
        if (node.arguments.length === 0 && isGlobal(node.callee, "Date", source))
          context.report({ messageId: "clock", node });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        const name = propertyName(callee);
        if (
          (isGlobal(callee.object, "Date", source) && name === "now") ||
          (isGlobal(callee.object, "Math", source) && name === "random")
        )
          context.report({ messageId: "clock", node });
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
