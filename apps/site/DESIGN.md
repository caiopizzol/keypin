---
version: alpha
name: keypin.dev
description: Visual system for the keypin landing page.
brand: ../../BRAND.md
colors:
  primary: "#121311"
  neutral: "#F4F3EE"
  tertiary: "#0B6E36"
  tertiary-on-primary: "#3FD07A"
  on-primary: "#ECECE6"
  secondary: "#6B6E66"
  body: "#3A3C37"
  outline: "#C9C7BD"
  surface: "#FFFFFF"
typography:
  title:
    fontFamily: ui-sans-serif
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: -0.03em
  tagline:
    fontFamily: ui-sans-serif
    fontSize: 19px
    lineHeight: 1.45
  label:
    fontFamily: ui-sans-serif
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1
  note:
    fontFamily: ui-sans-serif
    fontSize: 13px
  command:
    fontFamily: ui-monospace
    fontSize: 15px
    lineHeight: 1
  meta:
    fontFamily: ui-monospace
    fontSize: 12px
    lineHeight: 1
rounded:
  sm: 6px
  md: 8px
spacing:
  sm: 12px
  md: 20px
  lg: 40px
  page-top: 96px
components:
  title:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    typography: "{typography.title}"
  tagline:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.body}"
    typography: "{typography.tagline}"
  install:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.command}"
    rounded: "{rounded.md}"
    padding: 12px 12px 12px 18px
  install-prompt:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.tertiary-on-primary}"
  copy-button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
  link-button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 11px 16px
  rule:
    backgroundColor: "{colors.outline}"
    height: 1px
  note:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.secondary}"
    typography: "{typography.note}"
  footer:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.secondary}"
    typography: "{typography.meta}"
  logo-pin:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.tertiary}"
---

# keypin.dev

## Overview

This design system expresses the [keypin brand](../../BRAND.md) for the landing page. The premise is the README,
centered: the logo, the name, the tagline, the install command, and links to GitHub and npm. One column, nothing
else. A visitor should be able to install keypin without scrolling.

## Colors

| Role                  | Brand color  | Value                | Origin                      |
| --------------------- | ------------ | -------------------- | --------------------------- |
| `primary`             | Ink          | `#121311`            | Mirrored                    |
| `neutral`             | Paper        | `#F4F3EE`            | Mirrored                    |
| `tertiary`            | Green        | `#0B6E36`            | Mirrored                    |
| `tertiary-on-primary` | Green on Ink | `#3FD07A`            | Mirrored                    |
| `on-primary`          | none         | `#ECECE6`            | Derived                     |
| `body`, `secondary`   | none         | `#3A3C37`, `#6B6E66` | Derived                     |
| `outline`             | none         | `#C9C7BD`            | Derived, from the logo tile |
| `surface`             | none         | `#FFFFFF`            | Derived                     |

Green appears only in the logo and in the `$` of the install command.

## Typography

System fonts only: `ui-sans-serif` for words, `ui-monospace` for the command and the footer. No web fonts.

## Layout

One centered column with 96px above it. The logo is 80px. The footer is capped at 640px wide with a hairline rule
above it.

## Shapes

8px corners on the install command and link buttons, 6px on the copy button. The logo tile keeps its own corners.

## Do's and Don'ts

- **Do** keep the install command the only dark element on the page.
- **Do** use the logo from `.github/assets/keypin.svg` as is.
- **Don't** add sections, feature grids, or terminal transcripts. The README holds the details.
- **Don't** add shadows, gradients, web fonts, or a second accent.
