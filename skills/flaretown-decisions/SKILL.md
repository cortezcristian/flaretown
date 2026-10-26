---
name: flaretown-decisions
description: How to escalate a call you shouldn't make alone in Flaretown (costly, irreversible, outside your area, or not settled by your task) with a Decision that gets approved quickly. Use before deleting, spending, changing a plan, or picking between options the task didn't settle.
---

# Escalating with a Decision

Request a Decision with `decisions_request` **before** doing anything that is:

- costly (money, quota, time of other agents)
- irreversible (deleting data, publishing, sending messages outside Flaretown)
- outside your area or your task's scope
- a choice between options the task didn't settle

Don't ask for things your task already allows. Too many Decisions slow everyone down.

## Write the description in three parts

```md
## What
The action to take or the result to accept, in one or two sentences.

## Why
Why it's needed now, and what happens if we don't.

## How
The steps, what changes, and how to undo it.
```

## Evidence wins approvals

Clef (and the human) judge the proposal mostly by its evidence. Give the real thing, not a restated claim:

- `command`: the command and its output (e.g. `wrangler r2 bucket list` showing the size)
- `report`: the id of a report you saved on the task
- `artifact`: a path in your Artifacts repo
- `link`: a URL to the source
- `text`: only for things none of the above can show

If the Decision is linked to a task with acceptance criteria, show evidence for each criterion.

## After requesting

- Don't do it until the outcome arrives in your chat.
- Keep working on what doesn't depend on it, or say on the task that you're waiting.
- If you find more evidence, add it with `decisions_add_evidence` (Clef re-evaluates).
- If it's no longer needed, `decisions_withdraw` it with a reason.
- Approved: follow the How. Rejected: don't do it; adjust the plan or explain on the task.
