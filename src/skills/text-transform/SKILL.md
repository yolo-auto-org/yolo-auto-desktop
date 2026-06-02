---
name: text-transform
description: Rewrite, summarize, translate, extract, classify, clean up, or reformat text and local documents into a new text output. Use for text-to-text work such as making notes clearer, drafting emails, creating outlines, extracting action items, comparing versions, or converting rough notes into polished prose.
---

# Text Transform

Use this skill for text-to-text work: rewrite, summarize, translate, classify, extract, outline, compare, or format text.

## Workflow

1. Identify the requested output shape: summary, rewrite, email, table, checklist, outline, cleaned notes, translation, or extraction.
2. If the input is in a file, inspect it first with `read`. For folders or file discovery, use `exec` to list/search before reading.
3. Preserve the user's meaning. Do not invent facts, names, dates, or commitments.
4. Ask a short clarifying question only when the desired audience, tone, length, or source is genuinely ambiguous.
5. If the user wants a file, write a new file by default. Do not overwrite source material unless explicitly asked.

## Output rules

- Be concise unless the user asks for depth.
- Keep original proper nouns, dates, numbers, and constraints intact.
- For summaries, separate facts from recommendations when useful.
- For action items, include owner/date only when present or explicitly requested.
- For rewrites, match the requested tone and keep the same core content.
- For translations, preserve formatting and note any ambiguous terms.

## Common formats

- **Short summary:** 3-6 bullets plus key takeaway.
- **Meeting notes:** Decisions, action items, open questions, useful context.
- **Email draft:** Subject + body, with placeholders for missing details.
- **Comparison:** What changed, impact, risks, next steps.
- **Cleanup:** Correct grammar, tighten wording, preserve voice.
