---
name: "keypin"
tagline: "Rotate a key everywhere it's used."
specVersion: "0.3.0"
version: 1
language: en
---

# keypin

## Strategy

### Overview

keypin is a command-line tool that replaces a key at its provider and everywhere a project publishes it, and
shows what's due across all your projects. Each project declares its keys in [secretspec](https://secretspec.dev)'s
`secretspec.toml`; keypin's settings, under `[tool.keypin]`, say where each key is published and how it's rotated.
secretspec says which keys a project needs and runs it with them. keypin keeps those keys fresh everywhere.

Before: a key may have leaked, or is due, and replacing it means making a new one at the provider, pasting it into
each CI secret and hosting setting by hand, and revoking the old one. It rarely happens, and nobody knows which
copies were missed. After: `keypin rotate` makes the new key, publishes it to every destination in
`secretspec.toml`, and revokes the old one after you approve. `keypin status` and the console show what's due in
every project.

Direction: rotation at the provider and publishing to destinations, in every repo, on a schedule in your own CI.
keypin rotates keys at the issuers in the README and publishes to its destinations. Scheduled rotation is proven for
1Password to GitHub Actions so far. Anything else stays out of the README until the code does it.

### Audience

Anyone building software with coding agents, from one developer to a company. An agent creates a provider key
(Resend, Neon, Supabase, OpenAI) in minutes, so a team ends up with dozens of keys across many repos, each copied to
GitHub Actions, Vercel or Cloudflare. They meet keypin in a moment: a key may have leaked, a key is due, someone left
the team, or an auditor asks when a key last changed. They keep secrets in a vault and distrust tools that ask to
hold them. Not for teams that want a hosted secrets manager.

### Positioning

Rotation for keys that live in many places. Not a secrets manager, not a vault, not a server. The provider issues
the key, your vault holds it, your CI and hosting receive it; keypin replaces it in all three, in that order.
secretspec declares the keys and runs apps with them; keypin works from the same file.

- "Everywhere" means every destination in `secretspec.toml`, never a copy the file doesn't list.
- It shows a plan before every write, and a first write waits for you to answer `y`.
- It revokes an old key only after you approve.
- `secretspec.toml` holds names and places, never values.
- The CLI needs no keypin server and no keypin account. The hosted console is optional and only reads.

### Pricing

- Free for personal accounts and open source.
- One flat price per organization. Never per seat or per user.
- Any paid limit lives in the hosted console. The open-source CLI stays fully usable without a keypin login.

### Personality

The careful operator. Exact, plain, cautious, quiet. Not alarmist, not clever, not salesy.

### References & Anti-References

- **Unix man pages:** borrow the exactness and the habit of saying what a command does not do. Not their density.
- **A good README:** borrow the plain sentences and the install line up front. Not the length.
- **Anti-reference, security-vendor marketing:** reject shields, padlocks, "military-grade", and selling fear.

### Promise

keypin never stores your keys. Values stay in your vault and your infrastructure, and the CLI reads one only while
a command runs or a publish writes it. The hosted console reads `secretspec.toml`, workflow files, and secret names and
dates, never a value. When keypin automates rotation, it will run in your own cloud, never on keypin's servers.

Your vault is the source for each key, and publishing sends it only to the destinations in `secretspec.toml`.
Nothing is published without a plan, and a first write or a changed account waits for you to answer `y`.

Base message: rotate a key everywhere it's used.

### Guardrails

Plain, exact, calm. keypin cannot sound like a security vendor, a hosted platform, or a growth product.
Litmus test: if a sentence would need a value to be true, or a superlative to be interesting, it's wrong. Never
promise that a key can't leak: a running command still holds it. keypin doesn't detect leaks; it replaces a key once
you know or suspect one.

## Voice

### Identity

When a key has to change, we replace it at the provider and everywhere it's used, and we tell you exactly what we
read, what we write, and what we never touch.

Essence: one key, changed everywhere.

### Tagline & Slogans

- Primary: "Rotate a key everywhere it's used." Use it as the headline, everywhere. Name the category, never a
  competitor: Infisical and Doppler are vaults keypin reads.
- Description: "keypin makes a new key at the provider, publishes it to your CI and hosting, and revokes the old one
  only after you approve."
- Short description (60 characters or fewer): "Rotate a key everywhere it's used."
- With secretspec: "secretspec says which keys a project needs and runs it with them. keypin keeps those keys fresh
  everywhere."

### Message Pillars

- **Rotation:** a new key at the provider, saved to your vault and published everywhere it's used.
- **Across projects:** `keypin status` and the console show what's due, overdue or unpublished in every repo.
- **Approval:** a plan before every write, and the old key revoked only after you approve.

### Phrases

- "Rotate a key everywhere it's used."
- "This key may have leaked." / "This key is due." / "Someone left the team."
- "Names, never values."
- "A plan before every write."

### Vocabulary

| Concept                             | We call it        | Not                       |
| ----------------------------------- | ----------------- | ------------------------- |
| A credential an app reads           | key               | token, env var            |
| Writing a key to a destination      | publish           | sync                      |
| `secretspec.toml`                   | `secretspec.toml` | config, manifest, the map |
| GitHub Actions, a Cloudflare Worker | destination       | target, sink              |
| An entry in your vault (1Password)  | vault item        | entry, record             |

The name is always lowercase: keypin.

### Tonal Rules

- Say what a command does, then what it does not do.
- Name the command, the file, or the field. Use code formatting for them.
- Short sentences, sentence case, no exclamation marks, no emoji.
- Claim only what the code does today.
- Say "your vault". Name 1Password only where a reader needs to know which vault works today.

| We Say                          | We Never Say                |
| ------------------------------- | --------------------------- |
| "Nothing to leave on a laptop." | "Bank-grade security."      |
| "It waits for you to answer y." | "Your keys can never leak." |

## Visual

### Logo & Marks

A key drawn on a pixel grid: an Ink ring and shaft whose tip rises in three Green steps, inside a Paper tile with a
thin rule. A dark variant inverts the tile. Sources: `.github/assets/keypin.svg` and `keypin-dark.svg`. Use them
as they are: never redraw the mark, smooth its pixels, or recolor it.

### Core Colors

- **Ink** `#121311` (mandatory): the text, the mark, and dark grounds. Near-black, never pure black.
- **Paper** `#F4F3EE` (mandatory): the light ground. Warm off-white, never pure white.
- **Green** `#0B6E36` (mandatory), `#3FD07A` on Ink: the pin. Used sparingly, for the mark and what is checked.

Avoid: gradients and a second accent color.

### Typefaces

No brand typeface. Words use the system sans-serif (`ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial,
sans-serif`); commands and names use the system monospace (`ui-monospace, "SF Mono", Menlo, Consolas, monospace`).
Nothing to license. Verified.

### Art Direction

Plain, exact, one accent, pixel grid, no ornament. The visual territory is a careful tool's README, printed: Ink on
Paper, one Green, and the install command as the centerpiece.
