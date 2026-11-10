# Scoring brief (same for every evaluator)
You are an independent UX evaluator. You did not design this. Do NOT read docs/ui/scope-variants.md, docs/qa/*, DECISIONS, or any other evaluator's files. Read-only on the repo.
Mockup: /home/claude/wt-scope/docs/ui/mockups/scope-variants.html — an MSP alert console; hierarchy Customer › Project › Service. Top bar switches variants A, B, C, D, E. Inside E a PICKER switch selects E-1 Cascade, E-3 Search, and the default tree (call it E-tree). Toggles: 34 customers, persona (Junho/Haeun), portal.
Candidates to score (7): A, B, C, D, E-1, E-3, E-tree.
Drive with playwright (preinstalled: require('playwright')), take screenshots at the widths your personas use, and LOOK at them. Run the same tasks on every candidate, fresh load each. Be consistent and harsh; use the full 1–5 range; no ties out of politeness.
Criteria (score 1–5 each, integers):
 c1 where_am_i: can you tell customer/project/service within 2 seconds on every screen incl. while editing
 c2 wrong_scope_safety: prevention of reading/editing the wrong customer or level (defaults, labels, guards, hidden incidents)
 c3 findability: reaching a desired scope, incl. without knowing names (browse)
 c4 expert_speed: clicks/keys for frequent switching and editing
 c5 phone: usability at 390px (tap size, clipping, steps)
 c6 scale: 34 customers, deep trees, finding problem customers
 c7 simplicity: low clutter, learnable, few concepts
For each candidate × criterion give TWO scores: "concept" (the structural approach, ignoring fixable mockup bugs/polish) and "asbuilt" (the mockup as it is now).
If a criterion is not applicable to your personas' devices, still score it from a brief check.
Output 1: JSON file at the path given to you: {"evaluator":"<name>","personas":[...],"scores":{"A":{"c1":{"concept":n,"asbuilt":n,"why":"<=15 words"},...},...},"tasks":[{"task":"..","results":{"A":"pass/partial/fail + count",...}}],"ranking_concept":[...7 ids best→worst],"ranking_asbuilt":[...],"best_for_each_persona":{...},"notes":"<=120 words"}
Output 2: a short Korean markdown next to it (same name .md) with the tables.
Report: the two rankings and 5 lines of reasoning.
