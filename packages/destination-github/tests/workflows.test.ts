import { assert, describe, expect, test } from "vite-plus/test";
import { workflowRefs } from "../src/index";

describe("workflows", () => {
  test("finds secrets and vars in expressions and if conditions, not in comments", () => {
    const refs = workflowRefs(`
on: push
jobs:
  deploy:
    if: secrets.DEPLOY_ON != ''
    environment: production
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ secrets.API_TOKEN }} \${{ vars.REGION }}"
        env:
          # OLD: \${{ secrets.COMMENTED_OUT }}
          KEY: \${{ secrets['BRACKET_KEY'] }}
          GH: \${{ secrets.GITHUB_TOKEN }}
          lower: \${{ secrets.lower_name }}
`);
    assert(refs);
    expect(refs.secrets.toSorted()).toEqual([
      "API_TOKEN",
      "BRACKET_KEY",
      "DEPLOY_ON",
      "GITHUB_TOKEN",
      "LOWER_NAME",
    ]);
    expect(refs.vars).toEqual(["REGION"]);
    expect(refs.environments).toEqual(["production"]);
    expect(refs.hidesUses).toBe(false);
  });

  test("keeps which secrets each job uses with the environment it declares", () => {
    const refs = workflowRefs(`
on: push
env:
  TOP: \${{ secrets.TOP_LEVEL }}
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ secrets.TEST_TOKEN }}
  deploy:
    environment:
      name: production
      url: https://example.com
    steps:
      - run: echo \${{ secrets.API_TOKEN }}
  preview:
    environment: \${{ github.ref_name }}
    steps:
      - run: echo \${{ secrets.PREVIEW_TOKEN }}
`);
    assert(refs);
    expect(refs.uses).toEqual([
      { environment: null, secrets: ["TOP_LEVEL"] },
      { environment: null, secrets: ["TEST_TOKEN"] },
      { environment: "production", secrets: ["API_TOKEN"] },
      { environment: "${{ github.ref_name }}", secrets: ["PREVIEW_TOKEN"] },
    ]);
    expect(refs.secrets.toSorted()).toEqual([
      "API_TOKEN",
      "PREVIEW_TOKEN",
      "TEST_TOKEN",
      "TOP_LEVEL",
    ]);
  });

  test("notices secrets: inherit and toJSON(secrets), which can hide uses", () => {
    expect(
      workflowRefs(`
jobs:
  call:
    uses: ./.github/workflows/deploy.yml
    secrets: inherit
`)?.hidesUses,
    ).toBe(true);
    expect(
      workflowRefs("jobs:\n  a:\n    steps:\n      - run: echo '${{ toJSON(secrets) }}'\n")
        ?.hidesUses,
    ).toBe(true);
  });

  test("matches toJSON(secrets) and context names in any case, as GitHub does", () => {
    for (const call of ["tojson(secrets)", "TOJSON( secrets )", "toJSON(Secrets)"]) {
      expect(
        workflowRefs(`jobs:\n  a:\n    steps:\n      - run: echo '\${{ ${call} }}'\n`)?.hidesUses,
      ).toBe(true);
    }
    const refs = workflowRefs(
      "jobs:\n  a:\n    steps:\n      - run: echo ${{ Secrets.API_TOKEN }} ${{ SECRETS['KEY'] }} ${{ VARS.REGION }}\n",
    );
    expect(refs).toMatchObject({ secrets: ["API_TOKEN", "KEY"], vars: ["REGION"] });
  });

  test("an alias that refers to itself is read once instead of recursing forever", () => {
    const refs = workflowRefs(
      "loop: &x\n  again: *x\njobs:\n  a:\n    steps:\n      - run: echo ${{ secrets.TOKEN }}\n",
    );
    expect(refs).toMatchObject({ secrets: ["TOKEN"], hidesUses: false });
  });

  test("strings inside an expression neither end it nor count as references", () => {
    const refs = workflowRefs(`
jobs:
  a:
    if: "'secrets.IN_IF' != secrets.REAL_IF"
    steps:
      - run: "\${{ format('{{\\"t\\":\\"{0}\\"}}', secrets.API_TOKEN) }}"
      - run: "\${{ 'secrets.MISSING' }} \${{ 'it''s' }} \${{ secrets['QUOTED'] }}"
`);
    assert(refs);
    expect(refs.secrets.toSorted()).toEqual(["API_TOKEN", "QUOTED", "REAL_IF"]);
  });

  test("reads a workflow saved with a byte order mark", () => {
    const refs = workflowRefs(
      "\uFEFFjobs:\n  a:\n    steps:\n      - run: echo ${{ secrets.TOKEN }}\n",
    );
    assert(refs);
    expect(refs.secrets).toEqual(["TOKEN"]);
  });

  test("returns null for a file that isn't YAML", () => {
    expect(workflowRefs("jobs: [unclosed")).toBeNull();
  });
});
