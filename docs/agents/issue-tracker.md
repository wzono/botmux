# Issue tracker: Local Markdown

Issues and specs for this repo live as Markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file; use `triage-labels.md` for role strings
- Comments and conversation history append under a `## Comments` heading

## Skill operations

- When a skill says "publish to the issue tracker", create a file under `.scratch/<feature-slug>/`.
- When a skill says "fetch the relevant ticket", read the referenced local Markdown file.
- For `/wayfinder`, use `.scratch/<effort>/map.md` as the map and one child file per ticket under `issues/`.
- A child ticket records `Type:`, `Status:`, and `Blocked by:` near the top.
- The frontier contains open, unblocked, unclaimed tickets; lowest issue number wins.
- Claim by setting `Status: claimed`; resolve by setting `Status: resolved`, adding `## Answer`, and linking the result from the map.
