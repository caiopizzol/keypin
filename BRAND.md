---
name: "keypin"
tagline: "Get your team's keys out of .env files."
specVersion: "0.3.0"
version: 1
language: en
---

# keypin

## Strategy

### Overview

keypin is a command-line tool that gets a team's keys out of `.env` files. Each project lists its keys in a
`keypin.toml`: names, vault items and destinations, never values. Before: every laptop has a copy of every key in a
`.env` file, more copies sit in chats, notes and commits, and nobody has the full list. After: each value is kept
once, in the team's vault; one map says where every key comes from, where it goes and when it's due; and keypin
reads a value only while a command runs.

### Audience

A developer or a small team with `.env` files on their machines and keys in production on GitHub Actions and
Cloudflare Workers, who already keep secrets in a vault. Today that vault is 1Password. They distrust tools that ask
to hold their secrets. Not for teams that want a hosted secrets manager.

### Positioning

The way out of `.env` files for keys you already keep in a vault. Not a secrets manager, not a vault, not a server.
Your vault holds the values; GitHub and Cloudflare receive them; keypin knows the path between them.

- No key sits in a file to commit, paste, or leave on a laptop.
- The map holds names and places, never values.
- It checks the account before every write.
- It shows a plan before every publish, and a first write waits for you to answer `y`.
- No server and no account to sign up for.

### Personality

The careful operator. Exact, plain, cautious, quiet. Not alarmist, not clever, not salesy.

### References & Anti-References

- **Unix man pages:** borrow the exactness and the habit of saying what a command does not do. Not their density.
- **A good README:** borrow the plain sentences and the install line up front. Not the length.
- **Anti-reference, security-vendor marketing:** reject shields, padlocks, "military-grade", and selling fear.

### Promise

Your vault is the source for each key, and publishing sends it only to the destinations in the map. Nothing is
published without a plan, and a first write or a changed account waits for you to answer `y`.

Base message: get your team's keys out of `.env` files.

### Guardrails

Plain, exact, calm. keypin cannot sound like a security vendor, a hosted platform, or a growth product.
Litmus test: if a sentence would need a value to be true, or a superlative to be interesting, it's wrong. Never
promise that a key can't leak: a running command still holds it. Say what keypin removes instead.

## Voice

### Identity

We get your keys out of files and into one place, and we tell you exactly what we read, what we write, and what we
never touch.

Essence: one source, one map.

### Tagline & Slogans

- Primary: "Get your team's keys out of `.env` files." Use it as the headline, everywhere.
- Description: "keypin runs your apps with keys from your vault, and keeps one map of every key your team uses.
  Nothing to commit, paste in a chat, or leave on a laptop."
- Short description (60 characters or fewer): "Get your team's keys out of .env files."

### Message Pillars

- **No files:** keypin runs your apps with keys from your vault. Nothing to commit, paste, or leave behind.
- **One map:** every key your team uses, where it goes, and when it's due, in one committed file per project.
- **Approval:** a plan before every publish, and a checked account behind it.

### Phrases

- "Get your team's keys out of `.env` files."
- "Nothing to commit, paste in a chat, or leave on a laptop."
- "Names, never values."
- "A plan before every publish."

### Vocabulary

| Concept                             | We call it  | Not              |
| ----------------------------------- | ----------- | ---------------- |
| A credential an app reads           | key         | token, env var   |
| `keypin.toml`                       | the map     | config, manifest |
| GitHub Actions, a Cloudflare Worker | destination | target, sink     |
| An entry in your vault (1Password)  | vault item  | entry, record    |

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
