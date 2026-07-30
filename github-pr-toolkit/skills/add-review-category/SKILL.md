---
name: add-review-category
description: >-
  Wizard that adds a user-defined review category to /code-critic: interview the user
  and generate a code-reviewer-<slug> agent from the trusted template, or import one
  from a local file or GitHub — always validated and shown in full before install to
  ~/.claude/agents (user-global) or the project's .claude/agents. Use when the user
  wants to add/create/define a custom code review category or reviewer, import a
  review category, or extend code-critic's category list.
---

# add-review-category

Adds a **custom review category** to this plugin's `/code-critic` flow. A category is
one agent file, `code-reviewer-<slug>.md`, installed OUTSIDE the plugin (so plugin
updates never overwrite it). code-critic's L3 step discovers these files and offers
the category alongside the six built-ins; the guard hook auto-grants any
`code-reviewer-*` agent read-only inspection Bash and nothing more.

## Hard gates (never violate)

- **Nothing installs sight-unseen.** Whatever the source (wizard, local file,
  GitHub), show the user the COMPLETE final file content and get explicit approval
  before writing it. An imported definition is untrusted input that will run with an
  auto-granted Bash allowlist.
- **Validation is mandatory for imports** (see below); on failure, the default remedy
  is re-wrapping the import's checklist into the trusted template — installing a
  deviant file as-is requires the user to explicitly acknowledge each flagged issue.
- **Never install into the plugin's own `agents/` dir** (`${CLAUDE_PLUGIN_ROOT}` or
  the plugin cache) — updates would silently delete it.

## Step 1 — Source

Ask (AskUserQuestion): **Create with the wizard (default)** / **Import a local
file** (they give a path) / **Import from GitHub** (they give a raw URL, or
`owner/repo` + path [+ ref]).

## Step 2a — Wizard branch

Interview the user (free text is fine; use AskUserQuestion only where options are
natural). Collect:
1. **Slug** — kebab-case, becomes `code-reviewer-<slug>`. Reject collisions with the
   built-ins (general, security, design, adherence, performance, tests) and with any
   existing custom file in either install dir.
2. **Title** — the human name shown in the L3 picker (e.g. "Accessibility").
3. **Charter** — one sentence: what this lens hunts for (goes in the description).
4. **Checklist** — 4–10 concrete bullet items. Push for reviewable specifics
   ("missing aria-labels on interactive elements added by the diff"), not vibes
   ("code should be accessible"). Offer to draft the list from the charter and let
   them edit.
Then `Read` `${CLAUDE_PLUGIN_ROOT}/skills/add-review-category/template.md` and
substitute `{{SLUG}}`, `{{TITLE}}`, `{{CHARTER}}`, `{{CHECKLIST}}` (checklist items
as `- ` bullets). Change nothing else in the template.

## Step 2b — Import branches

Local: `Read` the ENTIRE file. GitHub: fetch it (WebFetch on the raw URL, or
`gh api repos/<owner>/<repo>/contents/<path>` / raw.githubusercontent.com via Bash).
Then validate:

- `name:` matches `code-reviewer-<slug>` (kebab-case) and doesn't collide (as in 2a).
  The filename must equal `<name>.md`.
- Frontmatter parses; there is **no `tools:` allowlist** (the template deliberately
  omits it so the agent inherits the session's tools — that is how any memory MCP
  server reaches it, with nothing to enumerate) and **`disallowedTools:` is present
  and includes at minimum `Write, Edit, MultiEdit, NotebookEdit` plus
  `mcp__plugin_github-pr-toolkit_github`**. A CODE REVIEW MUST NOT ALTER CODE, and
  that deny-list is the structural guarantee — if a `tools:` allowlist was added, or
  any of those deny entries is missing, flag it and restore the template's list.
- `permissionMode:` present → flag it and strip it (outside the plugin it IS honored,
  and `bypassPermissions` would unbound the agent's Bash — the guard hook is the
  intended grant).
- `model:` present → flag it and strip it. Review agents take the reviewer model the
  user picks per review (code-critic L3 Tab 4), applied to every category alike via the
  dispatch-time override; a static pin here would run this one category on a different
  model than the rest of the review.
- Body carries the static-review contract: the STATIC-pass hard rules, the
  `file:line` requirement, the uncertainty convention, and the standard return shape
  (`category:` / `findings:` with severity/file/problem/action/certainty).

Anything flagged → present the issues and ask: **Re-wrap into the trusted template
(recommended)** — keep their title/charter/checklist, regenerate everything else from
template.md — or **Install as-is** (only after they acknowledge the specific flags),
or **Abort**.

## Step 3 — Show & approve

Print the complete final file in a fenced block. Ask for approval (AskUserQuestion:
Install / Amend something / Abort). Tab-to-amend applies.

## Step 4 — Install location & write

Ask (AskUserQuestion):
- **User-global (default)** — `~/.claude/agents/code-reviewer-<slug>.md`: available
  in every repo, never committed.
- **This project** — `<repo>/.claude/agents/code-reviewer-<slug>.md`: committable, so
  teammates get the category too.
Create the directory if needed and `Write` the file.

## Step 5 — Post-install notes (tell the user all of these)

- The category appears in `/code-critic`'s picker immediately (L3.0 discovers the
  file), but the SUBAGENT type loads at session start — until a new/reloaded session,
  a review of this category falls back to the advisor/main-agent path and code-critic
  will say so.
- The guard hook grants it read-only, non-outbound inspection Bash automatically (by
  the `code-reviewer-*` name); no permission setup is needed.
- To remove or edit the category later: delete or edit the installed file — nothing
  else references it.
- Project-installed categories are worth committing so the team shares them.
