# Agents

## Writing docs

Follow the voice in [BRAND.md](BRAND.md): plain, short sentences, no emphasis or filler. Say each thing once, where a
reader looks for it. Link instead of repeating.

README and `skills/keypin/SKILL.md` stay short. Before adding a line, ask whether a reader would get stuck without it.

- Add only what someone needs to do the next step or avoid a mistake.
- Don't explain what an error message or `--help` already tells the reader.
- Leave edge cases to `docs/` or to the error message.
- When you add a line, look for one to remove. A change should rarely grow the file.

Each page in `docs/` covers one job completely and clearly, for someone building with keypin.

- Explain with the exact details a reader or an agent needs: fields, defaults, permissions, what keypin reads and
  writes, and its errors.
- List each new page in [docs/README.md](docs/README.md), which sets the order of pages.
