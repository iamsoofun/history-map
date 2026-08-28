# CONT-01 — Severity-Triggered Contagion: Frozen Specification

**Status:** FROZEN SPECIFICATION — NOT YET EXECUTED
**Frozen:** 2026-08-27
**Author:** Shane Justin Hladinec
**Prerequisites:** IA-01 (hazard non-constant, clustering is national not spatial),
DUR-01 (plain elapsed-time self-excitation: Hawkes beats duration but fails calibration)

---

## 0. What this is — and the honest limit stated first

This tests whether a **high-severity** incident raises the short-horizon
national hazard of a *subsequent* incident more than an average incident does
— i.e. whether contagion/self-excitation is **severity-dependent** rather than
uniform.

**It does NOT test media-publicity contagion, and this spec will not claim to.**
The popular "contagion" hypothesis is about *media coverage* — that heavily
covered attacks inspire imitators. NHIRA has **no publicity, coverage, or
media-volume field** on any record (verified: only date, location, casualties).
Testing media-contagion would require a data source that does not yet exist in
this project. What the data CAN support is a severity proxy: fatalities are
complete on all 667 US records. So CONT-01 asks the severity question honestly
and leaves the media question explicitly open and unbuilt.

If CONT-01 finds a severity-contagion effect, that is **not** evidence for the
media-contagion hypothesis — severity and publicity are correlated but not the
same thing, and this study cannot separate them. That caveat is frozen into the
result in advance.

## 1. Why it exists (provenance, recorded before results)

DUR-01 tested self-excitation where every past event contributes **equally**
to present hazard (the standard Hawkes kernel). It never asked whether
**larger** events contribute **more**. That is a distinct, untested question,
and it is the closest thing to the "contagion effect" idea that NHIRA's data
can actually address. CONT-01 isolates it.

## 2. The frozen question

> Does a **severity-weighted** self-exciting hazard — where each past
> incident's excitation is scaled by its fatality count — provide
> **incremental** out-of-sample predictive information beyond the
> **unweighted** Hawkes model DUR-01 already fit, on the same
> walk-forward / RPSS / calibration machinery?

The comparison is severity-weighted Hawkes **vs** the DUR-01 unweighted Hawkes
(the stable EM fit), both anchored to the frozen COUNT-01 baseline. As in
DUR-01, the pairwise comparison is interpretable only if at least one model
clears the baseline.

## 3. Pre-declared null

> Severity weighting provides **no** incremental information beyond the
> unweighted Hawkes model: its calibration and RPSS are statistically
> indistinguishable from unweighted Hawkes, and the paired bootstrap CI on the
> difference includes zero. A result consistent with this null is a real,
> reportable finding — it would mean contagion (to the extent it exists at all)
> is not severity-graded in this record.

## 4. Data (frozen input)

- **Series:** US eligible records, 2000-01-01 to 2025-12-31, on the
  1,031-record artifact (raw SHA-256
  `e54be167bad4cbb2c5db14000e4e738463719c2c137e9bfad4bd1ad0ec38d64b`).
- **Trigger events:** 176 US records with fatalities >= 4 (the mass-killing
  threshold) serve as the high-severity events whose excitation is up-weighted.
- **Severity weight:** each event i contributes excitation proportional to
  w_i = 1 + log(1 + fatalities_i). Frozen form — log to prevent the single
  168-fatality outlier (Las Vegas) from dominating, exactly the tail-sparsity
  problem SEV-01 documented. No other weight function is tried post hoc.
- **Artifact rule:** executed against the hashed artifact; not silently re-run
  when history.json changes. Any later re-run is a separately-recorded
  replication (as with IA-01/SEV-01).

## 5. Models compared (identical folds)

1. **Baseline** — frozen COUNT-01 empirical month-matched baseline, unchanged.
2. **Unweighted Hawkes** — the DUR-01 stable EM Hawkes, refit per fold.
3. **Severity-weighted Hawkes** — identical kernel and EM procedure, except
   each event's excitation is scaled by w_i above. One free structural change
   only; everything else held to DUR-01.

## 6. Overfitting & fairness controls (inherited from DUR-01)

- **Walk-forward only**, same four expanding folds, 7/10/15-day horizons.
- **Comparator must be validated, not just the challenger.** This is the
  standing lesson from DUR-01's near-miss: the unweighted Hawkes fit must show
  the same init-independent EM convergence (branching-ratio std < 1e-3 across
  restarts) before any comparison is recorded. If it does not, execution stops
  and nothing is filed.
- **Effective-units honesty:** ~10 effective units per horizon expected (same
  ACF ceiling). CIs reported with effective-unit counts.
- **Parameter-bound gate:** if the severity-weighted fit pins a parameter to a
  bound in the majority of folds, overfitting verdict, regardless of Brier.

## 7. Primary evaluation

- **Calibration** (the bar everything has failed so far): reliability
  chi-square, p >= 0.05 required to call any model calibrated. Honest prior,
  given COUNT-01/DUR-01: severity-weighted Hawkes will also fail calibration.
  Say so if it does.
- **Incremental test:** paired circular block bootstrap on
  (severity-weighted RPS − unweighted RPS) over identical folds. Null rejected
  only if that CI on the **difference** excludes zero.

## 8. Three-layer reporting (inherited from COUNT-01/DUR-01)

(1) frozen result as specified; (2) mandatory caveats — including the
severity-is-not-publicity caveat from Section 0 and the no-calibration caveat;
(3) any post-hoc descriptive content, clearly labelled non-frozen. Layer 1 is
never quoted without Layer 2.

## 9. What a positive result would and would not authorize

- **Would:** record that contagion is severity-graded at the national timing
  level — one honestly-earned refinement of the DUR-01 finding.
- **Would NOT:** (a) support the media-contagion hypothesis — severity is not
  publicity (Section 0); (b) put any number on the public map; (c) localize
  anything (IA-01: national, not spatial); (d) create a live "contagion" or
  "temporary risk score" feature. A validated research finding is not a
  deployed forecast input. Any such feature would require its own separately
  pre-registered calibration bar, which this spec does not grant.

## 10. Estimation-failure rules (declared before execution)

1. Unweighted Hawkes comparator fails EM stability check -> stop, file nothing.
2. Baseline beaten by neither model -> pairwise comparison uninterpretable,
   no winner named.
3. Severity-weighted fit pins a bound in majority of folds -> overfitting
   verdict.
4. Effective units < 10 at a horizon -> that horizon's CI non-informative.

---

*Frozen 2026-08-27 against the 1,031-record artifact. No parameter, weight
function, model form, fold structure, or evaluation rule may change once
execution begins; any change requires a new spec ID. This spec tests
severity-contagion only; media-publicity contagion remains unspecified and
unbuilt for lack of a data source.*
