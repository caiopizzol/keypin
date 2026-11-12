---
name: "keypin"
tagline: "Values stay in your vault."
specVersion: "0.3.0"
version: 1
language: en
---

# keypin

## Strategy

### Overview

keypin is a command-line tool that keeps a map of every app key across your projects and publishes each key to the
account it's pinned to. Each project lists its keys in a `keypin.toml`: names, vault items and destinations, never
values. Before: keys live in `.env` files and get pasted into GitHub and Cloudflare by hand. After: one map says
where every key comes from and where it goes, and keypin reads the values from 1Password only while a command runs.

### Audience

A developer with `.env` files on their machine and keys in production on GitHub Actions and Cloudflare Workers, who
already keeps secrets in 1Password. They distrust tools that ask to hold their secrets. Not for teams that want a
hosted secrets manager, or for anyone without 1Password.

### Positioning

A key map for your own projects. Not a secrets manager, not a vault, not a server. 1Password holds the values;
GitHub and Cloudflare receive them; keypin knows the path between them.

- The map holds names and places, never values.
- It checks the account before every write.
- It shows a plan before every publish, and a first write waits for you to type `yes`.
- No server and no account to sign up for.

### Personality

The careful operator. Exact, plain, cautious, quiet. Not alarmist, not clever, not salesy.

### References & Anti-References

- **Unix man pages:** borrow the exactness and the habit of saying what a command does not do. Not their density.
- **A good README:** borrow the plain sentences and the install line up front. Not the length.
- **Anti-reference, security-vendor marketing:** reject shields, padlocks, "military-grade", and selling fear.

### Promise

Values stay in your vault. Nothing is published without a plan, and a first write or a changed account waits for
you to type `yes`.

Base message: keypin knows where every key goes, never what it is.

### Guardrails

Plain, exact, calm. keypin cannot sound like a security vendor, a hosted platform, or a growth product.
Litmus test: if a sentence would need a value to be true, or a superlative to be interesting, it's wrong.

## Voice

### Identity

We map your keys and move them where they belong, and we tell you exactly what we read, what we write, and what
we never touch.

Essence: names, never values.

### Tagline & Slogans

- Primary: "Values stay in your vault." Use it under the name, everywhere.
- Description: "A map of every app key across your projects, published to the account it's pinned to."

### Message Pillars

- **Map:** each project's keys, by name, in one committed file.
- **Vault:** values stay in 1Password and are never written to disk.
- **Approval:** a plan before every publish, and a checked account behind it.

### Phrases

- "Names, never values."
- "Values stay in your vault."
- "A plan before every publish."

### Vocabulary

| Concept                             | We call it  | Not              |
| ----------------------------------- | ----------- | ---------------- |
| A credential an app reads           | key         | token, env var   |
| `keypin.toml`                       | the map     | config, manifest |
| GitHub Actions, a Cloudflare Worker | destination | target, sink     |
| A 1Password entry                   | vault item  | entry, record    |

The name is always lowercase: keypin.

### Tonal Rules

- Say what a command does, then what it does not do.
- Name the command, the file, or the field. Use code formatting for them.
- Short sentences, sentence case, no exclamation marks, no emoji.
- Claim only what the code does today.

| We Say                          | We Never Say                    |
| ------------------------------- | ------------------------------- |
| "Values stay in your vault."    | "Bank-grade security."          |
| "It waits for you to type yes." | "Seamless, effortless deploys." |

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
