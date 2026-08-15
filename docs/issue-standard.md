# How we write issues

Every issue in this repo answers one question before anything else: **why does
this matter, and what breaks if it is not done?** An issue that only says what to
do, with no impact, is not done being written.

This applies however the issue is created, through the GitHub template or through
`gh issue create --body`. The templates in `.github/ISSUE_TEMPLATE/` are the same
structure; this doc is the version that survives copy-paste and CLI use.

## The required sections

**1. A one-line banner** stating it blocks something and who owns it.

> **BLOCKING (See team).** Owner: See team. Needed by 14:00 Saturday.

For self-owned work the banner is a single line of priority and consequence
instead.

**2. Impact: why this needs the owner, and what breaks without it.** The section
that must never be skipped. Three things, concretely:

- **What breaks**, named as a real failure: a 401, a container flapping on camera,
  an unmeasured headline claim, invented tool names in the audit ledger. Not "it
  would be good to".
- **Why this owner specifically.** Their runbook, their sandbox, their secret,
  their decision. If anyone could do it, say who is fastest and why.
- **The knock-on.** What else is blocked downstream, linked by issue number.

**3. What we need** from the owner: a short, checkable list. If several items,
mark which one is the actual blocker.

**4. What is already done on our side.** Prove the blocker is the *only* thing
missing. Link the code, tests, or docs that are ready and waiting. This is what
turns "your move" from an assertion into something the reader can verify.

**5. Definition of done:** checkboxes that make "resolved" unambiguous.

## Highlighting a blocker

Name the owning team when you file; do not default to one.

- Title prefix `[<TEAM> BLOCKER]`, e.g. `[SEE-TEAM BLOCKER]`.
- Labels: `blocked`, `needs:<team>` for whichever team owns it, and a `block:Pn`
  priority (P0 highest). The template pre-applies only `blocked`; you add the team.
- If you do not know the owner, say so in the issue and make identifying them the
  first item to resolve.
- One filter surfaces a given team's blockers: `label:needs:<team>`.

## The test

Read the issue as the person who has to act on it. Can they tell, without asking,
why it landed on them and what goes wrong if they ignore it? If not, the impact
section is not finished. #13 and #26 are the reference bar.
