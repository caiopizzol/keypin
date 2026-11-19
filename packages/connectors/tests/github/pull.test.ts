import { describe, expect, test } from "vite-plus/test";
import { checkId, pullName, pullPlace } from "@keypin/core";
import { githubActions, githubPull } from "../../src/github/index";

describe("a GitHub Actions job that pulls a key", () => {
  test.each([
    ["Acme/Web", undefined, "acme/web"],
    ["acme/web", "Production", "Acme/web"],
  ])(
    "is at the same place as the destination for that repo or environment",
    (repo, environment, target) => {
      const where = environment === undefined ? {} : { environment };
      expect(pullPlace({ by: "github-actions", repo, ...where }, [githubPull])).toBe(
        checkId({ to: "github-actions", repo: target, account: "acme", ...where }, [githubActions]),
      );
    },
  );

  test("a repo and one of its environments are different places", () => {
    const repo = pullPlace({ by: "github-actions", repo: "acme/web" }, [githubPull]);
    const environment = { by: "github-actions", repo: "acme/web", environment: "production" };
    expect(pullPlace(environment, [githubPull])).not.toBe(repo);
  });

  test("is named for the reader", () => {
    const reader = { by: "github-actions", repo: "acme/web", environment: "production" };
    expect(pullName(reader, [githubPull])).toBe("GitHub Actions acme/web environment production");
  });
});
