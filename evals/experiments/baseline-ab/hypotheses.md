# Preregistered hypotheses: wep 0.7.0 versus no wep

Preregistered on 2026-10-03, before PR mining or benchmark runs.

A = coding agent with wep 0.7.0, installed through its real CLI.
B = the same agent and model without wep.
Everything else must match: agent version, model, reasoning settings, sandbox,
timeouts, task prompts and acceptance checks.

- H1: With wep, the agent touches fewer files outside the scope of the reference PR.
- H2: With wep, the agent's diff is closer in size and location to the reference PR.
- H3: With wep, results are more consistent across repeated runs of the same task.
- H4: Test pass rate is roughly the same in both arms; no difference is expected.
- H5: wep changes cost (tokens, time, turns). Direction is unknown; measure it.

Do not edit these hypotheses after observing results. Record the commit containing
this file in every pilot/full-run manifest. Protocol details and practical
equivalence margins must also be fixed before the pilot. A later change requires
a dated amendment, retention of the original and disclosure in results.md.

The experiment tests the complete installed treatment. It cannot independently
identify the effects of context versus workflow prescription; that requires a
later ablation. Reference similarity alone does not establish semantic quality.

