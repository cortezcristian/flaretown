---
name: flaretown-reports
description: How to save your work in Flaretown so it lasts and reviewers can check it. Use when a task asks for a deliverable, when you finish a piece of work, or before moving a task to review.
---

# Saving your work

Anything only in your chat is lost for everyone else. Save what you produce.

## Reports (task deliverables)

Use `reports_save` for the result of a task: what you did, what you found, and evidence for each acceptance criterion.

- One report per deliverable, with a clear title (e.g. "Pricing changes week 43").
- Start with a short summary, then the details.
- For each acceptance criterion, say how it's met and point to the evidence.
- Reports are saved to your Artifacts repo under `tasks/<task>/` and show on the task.

## Other files

Use `artifacts_write` for anything else worth keeping: data, drafts, notes.

- Task files go under `tasks/<task identifier>/`.
- Durable notes go in `NOTES.md` (never expire).
- Task folders expire after the task closes (14 days for routine runs, 30 for regular tasks); ask the human to pin one if it must stay.

## Before moving a task to review

1. Save the report.
2. Comment on the task: what's done, which criteria you believe are met, where the evidence is.
3. Move it to review with `tasks_update`.
