---
name: web-research
description: Research facts, products, people, companies, current events, documentation, or options on the web using search and source fetching. Use when the user asks to investigate, compare, find sources, verify claims, prepare a brief, or answer questions needing current or external information.
---

# Web Research

Use this skill for web-backed investigation and source-grounded answers.

## Default workflow

1. Turn the task into 1-3 focused search queries. Prefer specific nouns, dates, model names, locations, or source types.
2. Use `web_search` first unless the user provided specific URLs.
3. Open promising sources with `web_fetch`; do not rely only on snippets for important claims.
4. Cross-check important facts with at least two independent sources when practical.
5. Answer with citations as source titles/URLs inline or in a short Sources section.

## Source quality

Prefer:
- official docs, primary sources, government/standards pages
- reputable publications with dates and named authors
- vendor pages for product specs, then third-party reviews for tradeoffs

Be careful with:
- SEO pages, anonymous claims, old cached content, generated spam
- pages without dates when recency matters
- forum posts unless the user wants anecdotes or troubleshooting clues

## Research patterns

### Quick answer
Use one good search plus one or two fetches. Keep the answer short and cite the source URLs.

### Comparison or buying help
Create criteria first, then search/fetch per option. Summarize tradeoffs, not just specs.

### Verification
State the claim, what evidence supports it, what evidence contradicts it, and confidence.

### Deep brief
Break into sub-questions, gather sources per sub-question, then synthesize. Include open questions and next steps.

## Output rules

- Say when the web evidence is thin or conflicting.
- Include dates for time-sensitive information.
- Do not overstate certainty.
- If search/fetch fails, explain what failed and suggest a narrower query or user-provided source.
