---
name: Cross-team blocker
about: Something another team (or an external dependency) must resolve before we can proceed
title: "[SEE-TEAM BLOCKER] "
labels: ["blocked", "needs:see-team"]
---

<!--
Use this when the work is blocked on someone outside this repo's build.
Keep the title prefix. Add a block:Pn priority label (P0 highest). If the owner
is not the See team, change the needs:* label and the title prefix accordingly.
Delete these comments before filing.
-->

> **BLOCKING (<team>).** Owner of the dependency: **<who>**.
> Needed by **<date/time>** to leave room for <what happens next>.

## Impact: why this needs you, and what breaks without it

<!-- The most important section. Three things, concretely:
     1. What breaks if this is not done (name the failure: a 401, a flapping
        container on camera, an unmeasured claim). Not "it would be nice".
     2. Why only you can resolve it (your runbook, your sandbox, your secret).
     3. The knock-on: what else is blocked downstream. -->

## What we need from you

<!-- A short, checkable list. Mark which item is the actual blocker if several. -->

- [ ]
- [ ]

## What is already done on our side

<!-- Prove the blocker is the ONLY thing missing. Link the code/tests/docs that
     are ready and waiting, so the reader knows their part is the last mile. -->

## Definition of done

- [ ]
