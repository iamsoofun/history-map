
// =====================================================================
// COUNT-01 — EXECUTED. Result recorded in three mandatory layers that
// must NEVER be collapsed: (1) the frozen result as specified, (2) the
// artifact decomposition showing the frozen headline is 95-98% a
// baseline-smoothing artifact, (3) the post-hoc descriptive sensitivity
// that carries the genuine scientific content. Citing layer 1 without
// layer 2 misrepresents this experiment.
// =====================================================================

const COUNT_01_RESULT = Object.freeze({
    id: "COUNT-01",
    executed: "2026-08-22",
    status: "EXECUTED — ESTIMATION COMPLETE",
    executionAdditions: "Two resolutions frozen immediately before execution, before any scoring: (a) unconditional NB — no calendar-month, recency, duration, or event-history covariates; duration/recency terms explicitly reserved for a separately specified study so IA-01 could not influence this specification after the fact; (b) NB estimation by method of moments, MLE/Poisson-limit fallback only when sample variance <= sample mean (never triggered). RNG seeds frozen and disclosed (42/43/7/11).",

    // ---- LAYER 1: the frozen result, exactly as specified ----
    frozenResult: Object.freeze({
        rows: Object.freeze([
            { horizon: "7-day",  predictions: 1336, family: "NB", rpsModel: 0.3244, rpsBaseline: 0.7044, rpss: +0.540, ci95: "[+0.249, +0.759]", nullWidth: 0.078 },
            { horizon: "10-day", predictions: 929,  family: "NB", rpsModel: 0.4359, rpsBaseline: 0.8932, rpss: +0.512, ci95: "[+0.247, +0.722]", nullWidth: 0.094 },
            { horizon: "15-day", predictions: 613,  family: "NB", rpsModel: 0.6075, rpsBaseline: 1.1140, rpss: +0.455, ci95: "[+0.217, +0.656]", nullWidth: 0.109 }
        ]),
        zeroDiagnostic: "NB selected at all horizons — observed initial-window zeros (18) inside the fitted-NB parametric-bootstrap interval [15, 20]. Full-era descriptive diagnostic also compatible (e.g. 7-day: 932 observed vs [902, 968]).",
        baselineUsage: "Matched path 94.3% / 91.8% / 87.6% of forecasts (7/10/15-day); 76 fallback forecasts each, concentrated at the start. Matched-block support medians 57 / 40 / 27.",
        bootstrap: "Paired circular block bootstrap, 10,000 replicates. Block-length ACF rule hit the 10% ceiling at ALL horizons (L = 135/94/63) because the collection trend keeps the ACF significant — EFFECTIVE UNITS ~10 per horizon. The CIs rest on far less independent information than the prediction counts suggest.",
        interpretationClause: "Per the frozen spec: there is no pass. These are estimates."
    }),

    // ---- LAYER 2: the artifact decomposition ----
    artifactDecomposition: Object.freeze({
        finding: "95-98% of the frozen RPSS is a baseline-smoothing artifact, not model skill.",
        mechanism: "The frozen add-one smoothing forces the empirical baseline to carry ~17 pseudo-counts of permanent tail mass across the 0-15/>=16 support; the NB's tail decays naturally. RPS penalises that irreducible tail mass on every prediction. With near-zero smoothing the baseline RPS falls from 0.704 to 0.327 (7-day) — almost exactly the model's 0.324.",
        nullConfirms: "The null-RPSS simulation intervals sit at roughly -0.2 to -0.4, nowhere near zero, because outcomes drawn from the smoothed baseline inherit the same tail distortion. The null machinery is artifact-contaminated in the same way as the headline.",
        provenance: "The smoothing rule was proposed by the analyst during specification; the sparsity risk was flagged pre-execution (see COUNT_01_SPEC.baselineSparsityNote) but its dominance of the headline result was not anticipated. This is a specification-design error, owned as such — not a data problem and not a model failure.",
        rule: "The frozen headline RPSS values must never be quoted without this decomposition."
    }),

    // ---- LAYER 3: post-hoc descriptive sensitivity — the genuine content ----
    sensitivity: Object.freeze({
        label: "POST-HOC DESCRIPTIVE — cannot be promoted to the primary result; the frozen spec's own rules forbid swapping the baseline after seeing scores.",
        baseline: "Identical construction with near-zero smoothing (add-1e-6).",
        rows: Object.freeze([
            { horizon: "7-day",  rpss: +0.0089, ci95: "[+0.0023, +0.0193]" },
            { horizon: "10-day", rpss: +0.0150, ci95: "[+0.0069, +0.0274]" },
            { horizon: "15-day", rpss: +0.0217, ci95: "[+0.0140, +0.0322]" }
        ]),
        reading: "Small, positive, monotone in horizon, descriptively excluding zero at all three horizons under the same paired block bootstrap. Unconditional NB distributional shape carries a real but modest edge over month-matched empirical frequencies, growing with window length. Consistent with the programme's standing pattern: there is signal, and it is small.",
        caveats: Object.freeze([
            "Same ~10-effective-unit limitation as the frozen result — 'excludes zero' is a descriptive statement about a bootstrap percentile interval, not a hypothesis-test verdict.",
            "Post-hoc: the unsmoothed baseline was chosen after observing that smoothing dominated. Its role is diagnostic, and it sets the honest prior for any successor experiment."
        ])
    }),

    successor: Object.freeze({
        id: "COUNT-01b (not yet specified, not scheduled)",
        change: "Identical design with the baseline smoothing rule properly specified BEFORE execution — e.g. add-1/17 or an equivalent minimal-mass rule — so the baseline is not handicapped by construction.",
        honestPrior: "The sensitivity supplies COUNT-01b's expected outcome in advance: RPSS on the order of +0.01 to +0.02. If run, it either confirms that small edge under a fair frozen baseline or fails to — and a null result is as informative as a positive one.",
        gate: "Requires its own frozen registry specification before any code is written. Nothing is authorized by this entry."
    }),

    deployment: "Nothing here changes the public forecast, the Risk Score, or any UI. Per the frozen interpretation clauses: no threshold was cleared because no threshold exists."
});
