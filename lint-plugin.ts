import { definePlugin, defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

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
  /^packages\/(vault|destination|provider)-[^/]+\/src\//,
  /^packages\/core\/src\/secret\.ts$/,
  /^apps\/cli\/src\/commands\/run\.ts$/,
  /^(apps|packages)\/[^/]+\/tests\//,
  /^verification\/agents\/src\/fakes\.ts$/,
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
        "Don't read a Secret's raw value here. Compare it with secret.equals(), secret.isEmpty() or secret.includes(), or keep the value inside a vault, destination or provider package, which hands it to the account it belongs to.",
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

export default definePlugin({
  meta: { name: "keypin" },
  rules: { "no-comments": noComments, "no-reveal": noReveal },
});
