# Development lifecycle

How a change moves through this repository, from idea to shipped behavior to
whatever it does in production afterwards.

The model is a chain of **committed artifacts**. Each stage ends by writing a
file into version control; the next stage begins by reading it. Nothing is
carried in a chat window or in someone's head. Because every artifact is a
commit, the git history is also the audit trail: what was asked for, what was
produced, and who approved it.

This matters most when a human and a coding agent are working the same change,
possibly on different days with different tools. The artifact is the handoff.

## Stages and artifacts

| Stage | Artifact committed | Opened by |
| --- | --- | --- |
| Plan | `intent.md` — the problem, in the product owner's words | Someone wants something |
| Design | `spec.md` — the behavior contract | Acceptance of `intent.md` |
| Build | `plan.md` — files to change, tests to write | Approval of `spec.md` |
| Test | the diff and its tests | Approval of `plan.md` |
| Deploy | `review.md` — evidence and the gate decision | Green CI on the diff |
| Maintain | `incident.md` — what happened in production | Something went wrong |

The diff has no artifact file of its own; git already holds it.

Artifacts live in one directory per change:

```
docs/work/
  _templates/          intent.md, spec.md, plan.md, review.md, incident.md
  0001-<slug>/         one directory per change, sequentially numbered
```

Copy the templates you need, do not create empty ones. A change that never
needs a formal review record simply has no `review.md`.

## Human approval gates

Three gates separate the stages, and they are real stopping points, not
formalities:

- Accepting `intent.md` opens Design.
- Approving `spec.md` opens Build.
- Approving `plan.md` opens code generation and the PR.

An agent should stop at each gate and wait rather than reading ahead into the
next stage. Producing a spec and its implementation in one pass defeats the
point: the gate exists so a human can disagree cheaply, before the code is
written.

## When to use the full chain

Use it when a change touches:

- a frozen threshold in `config/signal_frozen_v1.yaml` or its parity-tested
  counterparts;
- a diagnostic's behavior, classification, or output labels;
- KV schema or retention bounds;
- Discord routing, mention policy, or eligibility;
- the Hyperliquid request budget or scan cadence; or
- anything that would change what the project claims its evidence supports.

**Do not use it** for typo fixes, dependency bumps, doc edits, test-only
additions, or refactors with no behavior change. An ordinary PR is correct
there. A process that gets applied to everything gets ignored by everyone.

If you are unsure, the question to ask is: *would a reviewer in six months
need to know why this was done?* If yes, write the intent.

## Review gates

The Deploy stage is where this project differs from a normal web service. A
diff being correct is not sufficient — a change to a diagnostic also has to
clear an **evidence** gate before it can alter live behavior.

Three sets of criteria already exist and are not restated here:

- **Every milestone** must satisfy the "Definition of done" in
  [`ROADMAP.md`](../ROADMAP.md): runtime behavior, TypeScript/Python parity,
  and stored schema tested; TypeScript, Python, and Worker checks passing;
  methodology, assumptions, data rights, resource use, and negative results
  documented next to the feature; and shadow data unable to change production
  behavior without an explicit versioned change.
- **Each milestone** additionally has its own **Exit gate**, stated inline in
  [`ROADMAP.md`](../ROADMAP.md) under M0–M5.
- **Any promotion of a signal or threshold** must clear "Promotion requires
  all of the following" in
  [`backtest-evaluation-plan.md`](backtest-evaluation-plan.md): positive
  out-of-sample net expectancy with a cluster-aware interval, results that
  survive predeclared slippage and cost scenarios, no single fold or crisis
  dominating the result, acceptable drawdown behavior, and separately useful
  results for the bullish and bearish tasks.

A `review.md` records which gate was applied and what it decided. The decision
is one of:

| Decision | Meaning |
| --- | --- |
| `PROMOTE` | Evidence cleared the gate; the change may alter live behavior. |
| `SHADOW_ONLY` | Collect prospectively; live behavior unchanged. |
| `RETIRE` | The feature or candidate is withdrawn. |

**A negative or inconclusive result is a completed decision**, not a reason to
retune against the same holdout. `SHADOW_ONLY` and `RETIRE` are successful
outcomes of this process.
[`fragility-v2-evaluation-report.md`](fragility-v2-evaluation-report.md) is the
worked example: a candidate model was evaluated, failed, and the finding was
written down and kept out of production.

## Relationship to the roadmap

[`ROADMAP.md`](../ROADMAP.md) and `docs/work/` are two views of the same work,
at different resolutions:

- **Milestones M0–M5 are long-lived intents.** They set direction and own the
  exit gates. They are not per-change artifacts and do not get a `docs/work/`
  directory of their own.
- **The "Next issue-sized queue" is the backlog.** Each item there becomes one
  `docs/work/NNNN-<slug>/` directory when work starts on it.

Every `intent.md` names the milestone it serves in its front matter. That link
is what keeps the two from drifting apart: if a work item cannot name a
milestone, either the roadmap needs updating or the work should not start.

## Starting a work item

1. Take the next unused number in `docs/work/`.
2. `cp docs/work/_templates/intent.md docs/work/NNNN-<slug>/intent.md`.
3. Fill it in, commit it, and stop. Wait for acceptance before writing the
   spec.

[`0001-prospective-observation-v1/`](work/0001-prospective-observation-v1/intent.md)
is a real worked example, currently paused at the Design gate.
