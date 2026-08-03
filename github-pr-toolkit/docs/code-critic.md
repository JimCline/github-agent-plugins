# /code-critic (github-pr-toolkit)

**Adversarially review a local diff or a GitHub PR — then act on the findings.**

> **Companion to [`/resolve-pr-comments`](../README.md), not a duplicate.** That command
> *resolves* the review threads reviewers already opened. code-critic **authors** the
> review: it critiques a diff, triages the findings by severity, and either fixes them
> locally or posts inline review comments on the PR. Both ship in the
> **github-pr-toolkit** plugin and share its setup, PAT, and architecture — see the
> [main README](../README.md) for installation.

Same clean split of labor as /resolve-pr-comments:

### Who reviews, and what they can touch

L3's **Reviewer** tab picks one of four, and advisor consultation is decided by the
**model you pick at Tab 4**: consulted when you explicitly choose a cheaper one (Sonnet,
Haiku, Fable), withheld on Opus or a session default left alone — the run cannot read its
own tier, so the choice you made is the test. A same-tier advisor costs full price for no extra
strength, and it is the one expense the Review-stats block cannot measure — so it is
chosen, never assumed. The `advisor_policy` setting (`auto`/`always`/`never`) overrides
the rule, and so does simply asking — "consult the advisor" and "have them work
independently" are both first-class answers, just not tab slots, since
`AskUserQuestion` caps at four options:

| Reviewer | Dispatches | Tradeoff |
|---|---|---|
| **Category subagents** *(default)* | one `code-reviewer-<category>` per selected category, up to a cap you set | strongest — each lens reaches its verdict independently and can't be coloured by the others |
| **One subagent, all categories** | a single `code-reviewer-all` | one dispatch instead of six, and it can see cross-lens interactions — but it's one reasoner, so `security` is coloured by what it just decided about `design`. Cheaper and quieter; a weaker review. Returns a **roll-call** so a skipped lens is visible rather than inferable |
| **The advisor** | one `advisor` pass | no subagent return to cross-check, so scope discipline has to hold inline |
| **The main agent** | none — reviews inline | spends orchestrator context on reviewing |

**The recommended reviewer follows the diff's size.** L2 already measures the change, so
the question names it: at **≤5 files and ≤200 changed lines** the single all-lens agent is
recommended — six independent reviewers cost roughly 5× and, on a small diff, mostly
re-read the same lines six times. Larger diffs recommend the fan-out, as before. It is a
recommendation on a question you already answer, and the prompt always adds *"pick the
fan-out if this change is high-stakes"*: size says how much there is to review, not how
much is at risk, and a 20-line auth change deserves six lenses.

If the orchestrator itself reads the change as high-stakes — auth, permissions, a
migration, crypto, a payment path — it says so **in the question** ("2 files / 40 lines,
but it changes an auth check — I'd recommend the fan-out") and asks. It never quietly
re-weights the recommendation: a risk judgement is surfaced for you to decide on, not
applied on your behalf. The thresholds are reasoned rather than measured — treat them as a
default worth overriding.

**You set the fan-out width.** Picking the per-category path with 2+ categories triggers
one more question, naming the actual count: how many reviewers run at once — **6 at a
time, rolling** (the default; for the standard six that's the same as "all", so the usual
path is unchanged), **all N at once**, **one at a time**, or a number you name. Past the
cap it's a rolling queue — each freed slot refills the moment a reviewer returns, rather
than waiting on the slowest of a batch. A cap of **1** is the no-fan-out answer, which is
why there's no separate on/off toggle; it still runs N independent reviewers, just never
two at once (different from "one subagent, all categories", which is one reasoner holding
every lens). **0** isn't a valid cap — zero subagents describes the advisor path as much
as the main-agent path, so which reviewer runs stays the Reviewer tab's decision.

**A code review must not alter code**, and that's structural rather than requested. The
reviewer agents ship **no `tools:` allowlist** — they inherit the session's tools, so any
memory MCP server present comes along without the plugin having to enumerate it — and a
`disallowedTools` list removes `Write`/`Edit`/`MultiEdit`/`NotebookEdit` and the GitHub
MCP server. `disallowedTools` is applied *first*, so it's the real boundary.
Bash stays reachable, because read-only git is how a reviewer recomputes
the diff and a deny-list can't express "read-only shell" — the guard hook holds it to
read-only inspection at runtime instead.

**Memory.** If the session has memory tooling, reviewers read it before reviewing —
mainly to find a recorded decision explaining why odd code is odd, which is the best
defence against reporting a deliberate choice as a defect. They may write durable
repo-level facts, and are forbidden from writing **findings**: a finding is unverified at
the moment a reviewer holds it, and one written to memory becomes a permanent claim every
later review recalls as fact. Findings-derived lessons are the orchestrator's to record,
only after you've decided at L6. With no memory tooling, all of this is skipped silently.

- **A higher-reasoning agent (the orchestrator)** — or, by default, **the `advisor`** —
  performs the adversarial review, then the orchestrator triages findings and drives you
  through them issue-by-issue. The orchestrator has **no GitHub tools**, but it
  **generates every diff itself** with read-only git (`git fetch` + `git diff` against a
  fresh `origin/<base>`) — the review is only as trustworthy as its input, so diffs are
  never delegated to a small model.
- **Haiku (`critic-worker`)** does the GitHub writes and repo mutations: the PR worktree
  checkout, posting inline review comments via the GitHub MCP server, and any
  `git commit`/`push`. It hands back short, verifiable results that the orchestrator
  cross-checks against local git.

A **PreToolUse guard hook** enforces the split, in two tiers.

**Always on** — no lock, no review, no session scope. Both routes to GitHub are denied
to the main agent and granted to the workers: the plugin's GitHub MCP tools
(`mcp__plugin_github-pr-toolkit_github__*`) and the **`gh` CLI**. These are deliberately
symmetric, because gating one transport while leaving the other open just relocates the
mistake — with no review armed, an orchestrator that can't call `create_pull_request`
will reach for `gh pr create` instead. The reason for delegating doesn't depend on a
review being in progress, so neither does the rule. Two carve-outs, both local
credential checks that return no repository data: `gh auth status` and `gh --version` —
`/github-pr-toolkit:doctor` and resolve-pr-comments' step 0.3 need them precisely when
the MCP path is broken.

**Armed only** — remote-mutating git (`push`/`commit`/`pull`/`worktree`) is blocked for
the duration of a review and **scoped to the initiating session**: the self-healing lock
file is *named* after that session (`.git/code-critic-<session_id>.lock`), so other
Claude Code sessions in the same repo are never blocked, and two concurrent reviews each
hold their own lock. This tier stays lock-scoped on purpose — it's plain git against
whatever remote the repo has, not GitHub API access, and blocking it always would stop
ordinary committing in every session the plugin is installed in. `git fetch` and
read-only git stay allowed throughout.

---

## Usage

```
/code-critic                      # review local commits vs main (default)
/code-critic --branch develop     # review local commits vs another branch
/code-critic --against v1.2.0     # review local commits vs a tag/commit
/code-critic 1234                  # review GitHub PR #1234 (worktree + inline comments)
```

Or just ask in natural language ("review my local changes", "critique PR 1234") — the
`code-critic` skill triggers the same flow.

### Flow

**Local:** declare the **outcome** — the first question of every run: report only
(default — zero code changes; a review's product is findings, and fixing is the
opt-in), fix approved findings, or decide after the review; it
rides as Tab 1 of the base ask, and is skipped only when you already said which you
want → pick a base → orchestrator fetches and generates per-file diffs vs
`origin/<base>` → pick the **review categories** (multi-select: General, Security,
Design & Architecture, Rules & Idioms Adherence, Performance & Efficiency, Test
Quality & Coverage — all six is the default) and the **reviewer** (parallel
per-category `code-reviewer-*` subagents by default; or the advisor / the orchestrator
itself) → if you chose subagents, pick the **reviewer model** (*Default (model I'm
using)*, or Opus / Sonnet / Fable) — one model runs *every* selected category, so
picking Opus means all six subagents are Opus → and whether the reviewer(s) should
**consult the advisor** for second opinions on borderline and high-severity findings
(default: yes,
when an advisor is available; each consulted finding records the advisor's
concurrence or dissent) → per-category adversarial review — subagent
findings are cross-checked against the orchestrator's own diff, then merged and
deduped across categories → severity-ranked findings, each with an **impact line** and a
succinct action (nits batched separately; a clean review ends here and says so), and
(at 3+ findings) **turned into a tracked task list** → then, in fix mode, choose
one-by-one / fix all / fix by severity → apply fixes, one task in progress at a time →
one ask (commit and push / commit only / neither) → one worker dispatch commits (and
pushes) → a closing summary by disposition. **Report-only runs offer no fix option**:
the ranked list is the deliverable, with an optional no-edits walkthrough that records
agree / decline / defer dispositions — switching to fixing takes an explicit mode
change from you, never a finding the orchestrator wants to act on.

**PR mode asks the same first question** with PR-shaped answers: **comment on the PR**
(default — approved findings post as one review, zero code changes) or **fix on the PR
branch** — fixes land in the checked-out worktree and one confirmed worker dispatch
commits & pushes them to the PR branch, SHA-verified before the worktree is cleaned up;
each issue can still take a comment instead.

The closing summary ends with a **Review stats** block: which model each agent ran on,
how many agents were used, and — when the environment reports it — tokens per agent,
which for per-category reviewers is also tokens per area. It prints on **every** exit,
including a clean review: agents and models are always reported even when tokens
aren't. Numbers are copied from
dispatch metadata as each agent returns (captured in a running note, since results can
be compacted away in a long review), never estimated: environments that don't report
usage (stock Claude
Code doesn't, as of v2.1.218) get `Token usage not reported by this environment` rather
than invented figures, and the orchestrator's own and the advisor's consumption are
listed as not measurable — so the printed total is explicitly "of what was measured".

The task list is created when the findings are **presented**, and every task stays
`pending` until you choose how to proceed — it exists to track the review, not to
authorize it. Each task carries the severity, `file:line`, and category, and ends up
with what actually happened (fixed / declined / skipped / deferred, or posted / skipped
on a PR), so the closing summary says more than "12 done". In PR mode a queued comment
stays open until it genuinely posts.

### Severity is always visible

Every time a finding is shown to you it leads with its severity —
`[Critical] parser.ts:88 — …` — in the ranked list, in each per-issue prompt, in the
task list's subjects, in the final table, and in the closing summary (which names every
unfixed Critical/High individually). List ordering conveys severity only while the whole
list is in front of you; once you're deciding on one issue at a time, or reading the task
list on its own, that signal is gone. So it's carried on the finding itself rather than
inferred from position.

### Feedback tone

A setting, not a wizard step — **`/plugin` → `github-pr-toolkit` → Configure →
`review_tone`**, defaulting to **balanced**:

| Tone | Voice |
|---|---|
| `terse` | Declarative and minimal. No hedging, no preamble. |
| `balanced` *(default)* | States the problem, brief reasoning, recommended action. |
| `suggestion` | Collaborative framing — proposals rather than verdicts. |

Override for one run with `--tone terse\|balanced\|suggestion`, or just say so in the
session ("be blunt about this one"); a spoken instruction wins over the setting. Anything
unset or unrecognized falls back to balanced silently — you are never prompted for it.

**It lands hardest on the inline PR comments.** Everything else code-critic renders is it
talking to you, in a session you're sitting in. A review comment is outbound: it outlives
the session and is read by someone who wasn't here, can't ask what you meant, and may have
written the code being criticized. That's the artifact the setting exists for.

**Wording only.** Tone never changes which findings are reported, never a severity, and
never what an impact line says. The `[Severity]` label, the `file:line`, and the impact
line are identical in all three tones — in the presented list and in the posted comment.
Suggestion tone is not a downgrade (a Critical stays Critical and still says what breaks);
terse is not omission (fewer words around the facts, never fewer facts). Task subjects and
metadata stay tone-neutral in every tone, since they're the record the closing summary
reads back.

Reviewers are never told the tone — subagents return factual findings and the orchestrator
renders. So the tone can change mid-review without re-running anything.

### Ephemeral comments

Part of **General Review**. A code comment's audience is the *next person to read the
code*, not the reviewer of this PR — and LLM-written code is full of comments that only
make sense while the diff is on screen. Once it merges, `// changed from foo to bar`
describes a transition nobody can see. Git history already records what changed.

| Flagged | Never flagged |
|---|---|
| `// changed from foo to bar`, `// NEW: added validation`, `// now uses the new API` | a public API's documented behavior or contract |
| `// as suggested, kept this for backwards compat` | **why** non-obvious code is that way — a workaround, constraint, tradeoff, spec/bug reference |
| `// increment counter` above `counter++` | any comment the diff didn't touch |
| `// Step 1: validate input` over obvious code | **the absence of a comment** |
| `// temporary` / `// for now`, with no issue ref or removal condition | |

**It never asks for prose.** "You should document this" is not a finding here, however
undocumented the code — a lens that demands comments becomes its own noise generator. It
only removes what the diff added.

These are `Nit` for the most part (`Low` when the clutter obscures the code, `Medium` only
when a comment actively misstates current behavior), so they arrive in the batched nit
block: one collective *strip these* decision rather than a prompt per comment. And like
every other lens it's scoped to the change — a stale pre-existing comment on an untouched
line stays out, however wrong it is.

### Signal, not quota

A finding has to matter. The bar is one question — **what goes wrong if this ships?** —
and every finding answers it in an `impact:` field shaped `when <trigger>, <observable
consequence>`, which must justify the severity it claims. The trigger is what makes the
bar checkable: "when the list is empty, this throws" can be tested against the diff;
"bad practice" can't. Findings whose impact names no trigger and no failure get demoted
or dropped — but only after the orchestrator has tried to name the consequence itself, so
a real defect with a lazily-written impact line gets its line fixed rather than binned.
Drops are counted in the same one-line note as scope drops.

**Finding nothing is a successful review.** A clean diff ends at a clean report — the
categories that ran, the base spec, the file count, and any drop count — not at a
manufactured list. That's a defined exit in the procedure, not an edge case, because the
fan-out itself creates the pressure to pad: several reviewers, one small diff, each
inclined to justify its own dispatch.

Genuine small things live at `severity: Nit`, the one severity exempt from the ships-test.
Nits are **batched** — one collapsed block, one collective ask (apply all / skip all /
pick), counted separately from findings — instead of each costing a task, a prompt, and a
drafted comment. Per-item cost is what made valid nits feel like noise.

None of this is licence to stay quiet. The bar decides what counts as a finding; it never
justifies withholding or softening one that clears it, and severity is never graded down
to look less noisy.

### Posted comments lead with a colour-coded severity banner

Every inline comment code-critic drafts onto a PR opens with its severity as the first
line, above the prose:

| Severity | Banner | | Severity | Banner |
|---|---|---|---|---|
| Critical | 🔴 **CRITICAL** | | Low | 🔵 **LOW** |
| High | 🟠 **HIGH** | | Nit | ⚪ **NIT** |
| Medium | 🟡 **MEDIUM** | | | |

```
🔴 **CRITICAL** — unchecked null deref on the new error path

**Impact:** when the upstream call times out, `resolve()` returns `null` and this throws
instead of returning the 503 the caller expects.

Guard the return before `.parse()`.
```

**Emoji, deliberately — not an alert block or a badge image.** GitHub alerts
(`> [!CAUTION]`) aren't verified to render in *inline review comments*; a sweep of ~10,000
of them found zero using alerts, and an alert that doesn't render shows the reader a
literal `[!CAUTION]` line. Shields.io badges do work in this surface, but cost an external
image request per comment — which breaks on air-gapped GitHub Enterprise and can serve
stale content through GitHub's camo proxy. Emoji render identically in the web UI, email
notifications, the REST API, and a terminal, and fetch nothing.

The severity **word** always sits beside the dot. Colour never carries the meaning alone —
the comment gets read through email, through the API, and by people who can't distinguish
the dots. Feedback tone shapes the prose beneath the banner but never the banner itself.

### What gets reviewed

**The change, not the codebase.** A finding is in scope only if the diff *introduces* it,
or *newly exposes or worsens* it — and in the second case the finding has to say how
("the new caller at `api.ts:40` reaches it with unvalidated input", not "this was already
unsafe"). Pre-existing bugs, old design decisions, and untouched code in a file the diff
happens to open are out of scope, however real they are. Reviewers read surrounding code
to judge the change fairly, but that's input, not review surface.

This binds every review path — the category subagents, the advisor, and the orchestrator
itself — and it's enforced, not just requested: each finding carries a
`scope: introduced-by-diff | newly-exposed-by-diff` tag, the orchestrator drops findings
that land on unchanged lines without an exposure claim, and triage filters again before
anything reaches you. (`git diff` prints ~3 unchanged context lines around each hunk, so
"the line is in the diff" is not by itself proof that the change caused it — that gap is
what let pre-existing code into reviews before.) Ask for a broader review and you'll get
one; absent that, it stays on the change.

The **Rules & Idioms Adherence** category reviews against the project's own
directives (CLAUDE.md, `.claude/rules/`, lint configs). If none exist, you choose:
infer the house style from the codebase, or state the rules yourself. It is scoped like
every other category — it flags directives *this change* violates, not a conformance
audit of the repo.

### Custom categories

The **`add-review-category`** skill ("add a custom review category") extends the
picker with your own lenses. It either interviews you (slug, title, charter,
checklist) and generates the agent from the plugin's trusted template, or imports a
definition from a local file or GitHub — validated (naming, tool allowlist, no
`permissionMode`, static-review contract present) and shown to you in full before
anything installs. Categories install outside the plugin — `~/.claude/agents/`
(user-global) or `<repo>/.claude/agents/` (committable) — so plugin updates never
touch them; the guard hook auto-grants any `code-reviewer-*` agent read-only
inspection Bash only. New agent types load at session start, so a just-added
category is picker-visible immediately but runs via the advisor/main-agent path
until the next session.

**GitHub PR:** preflight/onboard the PAT → choose the worktree location (default:
`.claude/worktrees/pr-<N>` inside the repo, excluded via `.git/info/exclude`; or a path
you pick) → **one** worker dispatch checks out a worktree at exactly that path *and*
returns the PR's existing review threads (orchestrator verifies the handoff, path
included) → orchestrator diffs in the worktree vs `origin/<base>` → same review →
findings are deduped against the existing threads (an already-flagged issue — especially
one already resolved/addressed — gets **Skip** as the recommended option instead of
double-flagging) → issue-by-issue: queue the comment / skip / other, with Tab-to-amend
on the proposed wording (nothing posts mid-loop) → **one** final worker dispatch
publishes every approved comment as **a single PR review** and removes the worktree.

Batching everything into ~3 worker dispatches keeps the orchestrator's context lean:
each dispatch carries fixed harness overhead (plus anything ambient hooks inject, which
can run to a
~1.1k-token injected routing block), so the flow pays it three times instead of once
per finding — and the PR gets one review event instead of N single-comment reviews.

---

## Requirements

Same as the rest of the toolkit (recent Claude Code; the GitHub MCP server is GitHub's
hosted remote, connected directly from the plugin's `.mcp.json` — nothing to install;
`gh` optional). The PAT scope `/code-critic` specifically needs beyond
`/resolve-pr-comments`:

| Fine-grained PAT scope | Why |
|---|---|
| **Metadata: Read** | Base access |
| **Pull requests: Read & write** | Read the diff; post inline review comments |
| **Contents: Read** | Check out the PR branch into a worktree |

Set the token in **`/plugin` → `github-pr-toolkit` → Configure** (stored in your OS
keychain as `github_pat`) — **once for the whole toolkit**; both commands share it.
**Re-enter it after Claude Code restarts or plugin upgrades if GitHub access breaks**
(sensitive config values can be lost — claude-code#62442); an empty PAT surfaces as
`No such tool available: mcp__plugin_github-pr-toolkit_github__*`. Run
**`/github-pr-toolkit:doctor`** to verify the MCP wiring for both workers without
starting a review.
