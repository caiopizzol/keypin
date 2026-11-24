# Agents

## Writing docs

Follow the voice in [BRAND.md](BRAND.md): plain, short sentences, no emphasis or filler. Say each thing once, where a
reader looks for it. Link instead of repeating.

README and `skills/keypin/SKILL.md` stay short. Before adding a line, ask whether a reader would get stuck without it.

- Add only what someone needs to do the next step or avoid a mistake.
- Don't explain what an error message or `--help` already tells the reader.
- Leave edge cases to `docs/` or to the error message.
- When you add a line, look for one to remove. A change should rarely grow the file.

Pages in `docs/` are minimal, clean and concise: one job each, for someone building with keypin, with only what
that job needs. Remove the rest, and link instead of repeating.

- Open with one sentence on what the page is for. keypin.dev shows it under the title and as the page's description.
- Give the exact details a reader needs to do the job or avoid a mistake: fields, defaults, permissions, what keypin
  reads and writes. Leave out what the CLI's output or an error already says.
- Show output only where the reader acts on it, trimmed to exact recorded lines.
- When you move a page, leave a `Moved to` page at the old path with its old anchors. Released keypins print links
  to it.
