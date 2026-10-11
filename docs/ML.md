# ToolTrace intelligence: model card

What the nightly job predicts, how it learns, how well it works, and where it should not be trusted. Code: [`ml/tooltrace_ml`](../ml/tooltrace_ml). Tests: [`ml/tests`](../ml/tests).

## What it does

Every night (GitHub Actions schedule, or the `ml` service in Docker Compose) the job:

1. **Learns** from every check-out whose outcome is known.
2. **Scores every tool that is out** with two probabilities:
   - **late risk**: it comes back after its due time (30-minute grace),
   - **loss risk**: it is still not back a week after its due time.
3. **Flags unusual check-outs** from the last 14 days for a person to review.
4. **Writes the results in one transaction** as the `tooltrace_ml` database role, and the run lands in the tamper-evident audit trail (`ml.run_completed`, `anomaly.flagged`).

Crib staff see the results on the **Insights** page, with the reasons behind each score. Technicians never see scores, not even their own. That rule is enforced by the database itself (row-level security), not just by the page.

![Insights](screenshots/insights.png)

## Intended use, and what it is not for

| Use it for | Do not use it for |
|---|---|
| Deciding which tools to chase first at the end of a shift | Judging, ranking or disciplining people |
| Spotting a tool that is probably lost while it can still be found | Automatic decisions of any kind: nothing happens because of a score |
| Prompting a conversation about an odd check-out | Proof that anything wrong happened. Most flags have an innocent reason. |

A flag must be confirmed or dismissed by a person, and that decision, its note and who made it are audited.

## Data

ToolTrace is new, so there is no real history yet. **Demo and test databases use synthetic history** ([`synth.py`](../ml/tooltrace_ml/synth.py)): a year of check-outs for 16 fictional people and the 9 demo tools, generated from a known model with deliberate patterns:

| Planted pattern | Effect on the odds of being late (log-odds) |
|---|---|
| Personal tendency: 2 chronically late people, 3 very reliable, the rest random | +1.7 / −1.3 / normal(0, 0.7) |
| Longer check-out | +0.55 × log(planned hours / 8) |
| Checked out at night (21:00 to 05:00 site time) | +0.9 |
| Spans a weekend | +0.7 |
| Category: power tools, inspection gear / calibrated instruments | +0.45, +0.25 / −0.25, −0.3 |
| Already holding another tool | +0.5 |
| Odd check-outs: 3 a.m. for a day-shift worker, 2 to 3 week loans | about 2% of check-outs |

About 25% of check-outs are late and 3% to 4% are lost. Because the truth is known, the tests can check that the models really find these patterns (see Evaluation).

The import is recorded in the audit trail as one `data.imported` entry with its size and seed, and refuses to run twice.

**Privacy.** The job's database role can read only what it learns from: user id, role and active flag; tool id, tag and category; check-out times and outcomes. It cannot read names, emails, notes, passkeys or the audit log, and it cannot change any check-out (tested in `ml/tests/test_database.py`). Person ids are never model inputs; a person enters the model only through their own return history.

## Features

All features are computed **as of the moment of check-out**, using only outcomes that were already known then (no data leakage). A past check-out counts in someone's history only if it had been returned, or was already overdue, at that moment. A test rewrites the future and checks that no earlier feature changes.

| Feature | Meaning |
|---|---|
| `log_planned_hours` | log(1 + hours between check-out and due) |
| `is_night`, `spans_weekend` | In the site's time zone (`TOOLTRACE_SITE_TZ`, default Asia/Kolkata) |
| `holder_late_rate` | Holder's known late rate, smoothed toward the overall rate (weight 5), so a newcomer starts at average |
| `log_holder_history` | How much history that rate rests on |
| `tool_late_rate` | Same, for the tool |
| `holder_open_count` | Tools the holder already has out |
| `issued_by_other` | Issued by crib staff rather than self-service |
| tool category | One column per category |

## Models and selection

Two candidates per target: **logistic regression** (standardised inputs, L2) and **gradient boosting** (depth 3, 250 rounds). History is split **by time**: the oldest 70% to train, the next 15% to choose a model, the newest 15% to test. The test slice is never used for fitting or choosing. The chosen model is then refit on all labelled history to score.

- Boosting is chosen only if it beats logistic regression by more than 0.01 ROC AUC on validation (the simpler model is easier to explain).
- **If the validation slice has fewer than 10 positives, the simpler model is kept by default**: a comparison on a handful of cases is noise. This always applies to the loss model (see below).

**Overdue tools: the "still not back" update.** A score made at check-out time doesn't know the tool is now two days overdue. Bayes' rule adds that:

```
P(lost | still out d hours after due) = P(lost) / P(still out at d)
P(still out at d) = P(late) × S(d),   S(d) = share of past late returns later than d
```

So loss risk rises the longer a tool stays out, and reaches 1 once it is later than any late return ever seen. The tests check that it is monotonic and bounded.

**Explanations.** For each scored tool the page lists up to three reasons: the factors whose replacement by a typical value lowers the risk the most (an *occlusion* explanation, which works the same for any model). For example: "Returned 9 of 12 past check-outs late · Long check-out: 3.0 days".

**Unusual check-outs.** An Isolation Forest (300 trees) on three features: how far the hour is from that person's usual hour (a circular mean, needing at least 5 earlier check-outs), the log planned duration, and how new the tool's category is to that person. Anything as unusual as the strangest 2% of history is flagged. Robust z-scores against the typical check-out turn the flag into readable reasons ("Checked out at 02:33; usually around 11:45"). Each check-out is flagged at most once.

## Evaluation (synthetic history, three independent histories)

Late returns, on the newest 15% held out (about 165 check-outs each):

| History seed | Model ROC AUC | Oracle ROC AUC | Baseline: holder's own record | Brier | Chosen |
|---|---|---|---|---|---|
| 7 | 0.842 | 0.853 | 0.642 | 0.110 | logistic (validation 0.85 vs 0.82) |
| 11 | 0.721 | 0.744 | 0.674 | 0.170 | logistic (0.80 vs 0.74) |
| 3 | 0.758 | 0.777 | 0.704 | 0.157 | logistic (0.80 vs 0.75) |
| **Mean** | **0.774** | **0.791** | **0.673** | | |

- The **oracle** scores each check-out with its *true* probability from the generator: no model can beat it on average. The model is within 0.01 to 0.02 of it, so it has found nearly everything there is to find. The tests require it to stay within 0.06.
- It adds about 0.10 ROC AUC over "this person is often late". On a single 165-row slice that comparison is noisy (on one other seed even the oracle lost to the baseline), so the test checks it on the average.
- Logistic regression won every time. That is expected, since the truth is logistic; with about 1,000 rows, boosting mostly fits noise.

**Losses: honestly unmeasured.** Only 1 to 4 lost tools fall in each test slice. A ROC AUC on 4 cases means nothing; on one seed, an earlier version of this code picked boosting on such thin evidence and scored 0.21 on test. The model is therefore logistic by default, its metrics carry `testReliable: false`, and the Insights page says "too few to measure" instead of quoting a number. Loss risk should be read as a ranking aid, mainly driven by the overdue update above.

**Unusual check-outs** (planted oddities found in the strangest 2%):

| Seed | Recall | Precision |
|---|---|---|
| 7 | 0.94 | 0.73 |
| 11 | 0.91 | 0.91 |
| 3 | 0.79 | 0.96 |

**A feature that hurt.** The detector first also used "tools already held". In a 9-tool crib, holding two is rare enough for the forest to isolate but not actually suspicious, and it drowned out the real oddities: recall fell to 0.29 / 0.43 / 0.39 and precision to 0.23 / 0.43 / 0.48. It was removed. The risk model keeps it, because there it really does predict lateness.

## Limitations and risks

- **Synthetic data.** All numbers above are on generated history. Real shop floors will differ, and the first months of real data will be thin (the job falls back to the overall rate until there are at least 50 labelled check-outs with enough late ones).
- **Feedback loops.** If staff chase high-risk people harder, those people return on time more, and the model learns that the risk was lower than it was. Review the effect periodically.
- **Fairness.** The model can't see who someone is, only how their past returns went, but shift patterns and job roles correlate with lateness for reasons that are not the person's fault (night work, remote bays). That is why scores are staff-only, explained, and never acted on automatically.
- **Data poisoning.** Someone who can write check-outs could shape their own history. All writes are permission-checked and audited; the model's inputs are the same audited records.
- **Freshness.** Scores are as of the last run; check-outs made since show as "Not scored yet", and the page warns when scores are more than a day old.

## Running it

```bash
cd ml
pip install -r requirements-dev.txt
export DATABASE_URL=postgres://...            # migrated by the API, with the demo tools seeded
python -m tooltrace_ml seed-history --open    # demo only: a year of synthetic history + 3 tools out now
python -m tooltrace_ml run                    # the nightly job
TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres python -m pytest
```

In production, set the repository secret `ML_DATABASE_URL` and the `ML nightly` workflow runs it at 02:47 India time.
