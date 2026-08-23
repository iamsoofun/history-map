
// =====================================================================
// COUNT-01 — COUNT-ESTIMAND FORECAST ESTIMATION STUDY
// FROZEN SPECIFICATION. An ESTIMATION study, not a hypothesis test:
// no alpha, no pass/fail verdict, no multiplicity correction, and a
// successful-looking RPSS authorizes nothing. Every numerical value
// below was fixed before any model was fitted.
// =====================================================================

const COUNT_01_SPEC = Object.freeze({
    id: "COUNT-01",
    title: "Count-Estimand Forecast Estimation Study",
    status: "FROZEN — AWAITING EXECUTION",
    frozen: "2026-08-22",
    studyType: "estimation",

    researchQuestion: "What is the expected incident count over 7/10/15-day windows for the US national series, and how does a count model's predictive distribution score against a calendar-month-matched empirical count baseline?",

    // ---- era, derived from source documentation, never from distribution ----
    era: Object.freeze({
        population: "United States",
        start: "2000-01-01",
        end: "2025-12-31",
        basis: "FBI Active Shooter Report collection mandate begins in 2000; the series' documented coverage currently extends through 2025 (2025 report released 2026-07-30). This is a SOURCE-REGIME boundary, not a claim that the underlying phenomenon changed in 2000.",
        linkToIdentifiability: "US-OBS-01 independently established that 87.7% of NHIRA's post-2000 US records cite the FBI. NHIRA's US collection regime effectively IS the FBI collection regime over this interval, so the era is implied by what the record is rather than chosen.",
        exclusion2026: "2026 is excluded ENTIRELY BY DATE, not by per-record source test. A per-record filter would empty blocks inside a retained period and understate counts; a date boundary excludes cleanly.",
        eligibleRecords: 577,
        excludedPre2000: 33,
        excludedPost2025: 24,
        descriptiveRate: "22.19 incidents/year — DESCRIPTIVE CONTEXT ONLY. Not a rate estimate independent of the frozen observation/collection regime.",
        noLaterReselection: "No later era selection may be made on the basis of count distribution, model performance, or scoring results."
    }),

    // ---- block construction ----
    blocks: Object.freeze({
        construction: "non-overlapping, per the existing frozen production construction",
        anchor: "2000-01-01 — explicitly the era start, NOT the country's earliest incident date. The production buildNonOverlappingBlocks() default anchor would begin in 1900 and must be overridden.",
        termination: "2025-12-31",
        partialTrailing: "EXCLUDED. Only complete 7/10/15-day blocks enter evaluation — a partial window is not comparable. Trailing days not formed into a block: 5 (7-day), 7 (10-day), 2 (15-day)."
    }),

    // ---- descriptive gate: COUNT-01 distinctness, PASSED ----
    gate: Object.freeze({
        verdict: "PASS",
        question: "Is E[count] empirically distinct from P(>=1), or would a count model be re-running the closed binary experiment under a new name?",
        rows: Object.freeze([
            { horizon: "7-day",  blocks: 1356, pctZero: 68.7, pctOne: 23.0, pctTwoPlus: 8.3,  max: 5, informative: 112 },
            { horizon: "10-day", blocks: 949,  pctZero: 60.3, pctOne: 25.6, pctTwoPlus: 14.1, max: 6, informative: 134 },
            { horizon: "15-day", blocks: 633,  pctZero: 49.3, pctOne: 27.8, pctTwoPlus: 22.9, max: 8, informative: 145 }
        ]),
        conclusion: "The count estimand is empirically distinct from the binary >=1 estimand at all three horizons. The strength of that distinction varies MATERIALLY by horizon — 8.3% / 14.1% / 22.9% — and the horizons must not be described as equally informative.",
        supersededFigures: "An earlier exploratory run under the full 1900-onward construction reported 6,569 / 4,599 / 3,066 blocks with 1.7% / 2.8% / 4.8% at >=2. Those figures are NOT COUNT-01 statistics and must not be cited as such."
    }),

    // ---- baseline: empirical, deliberately unmodelled ----
    baseline: Object.freeze({
        form: "Empirical relative frequencies of counts among calendar-month-matched training blocks — NOT a fitted parametric distribution.",
        rationale: "The exact count analogue of the existing binary baseline, which returns matched blocks' observed elevated RATE. Keeping the baseline unmodelled means any skill the count model shows comes from its structure, not from having handed the baseline a parametric advantage.",
        inheritedConstants: Object.freeze({ FC_MIN_INITIAL_TRAINING_BLOCKS: 20, FC_MIN_MONTH_MATCHED_BLOCKS: 8 }),
        constantsNote: "Inherited UNCHANGED. Not reconsidered or optimized for COUNT-01.",
        fallback: "Training-wide empirical count distribution when matched blocks < 8.",
        smoothing: "Add-one over the frozen support, applied IDENTICALLY to matched and fallback paths so the two are not scored differently."
    }),

    // ---- scoring ----
    scoring: Object.freeze({
        primary: "Ranked Probability Score (RPS), lower is better. Proper for ordered discrete counts: predicting 2 when the outcome is 3 is penalised less than predicting 0 when the outcome is 3.",
        skill: "RPSS = 1 - RPS_model / RPS_baseline, higher is better. Both RPS and RPSS are reported; RPSS is never reported alone.",
        support: "0, 1, 2, ... 15, >=16 (upper-tail bin, not truncation — truncating and renormalising would alter the scoring rule).",
        supportNote: "The support was frozen from the earlier full-span empirical observation BEFORE the era restriction. The in-era maximum is 8. The support remains 0-15 plus >=16 so that the predictive scoring definition does not become era-dependent.",
        fullDistributionRequired: "The model must emit a COMPLETE predictive probability distribution over the frozen support. Point predictions of E[count] alone are not eligible for the primary analysis — a point-forecast method cannot be RPS-scored, and inventing a distribution around a point prediction is prohibited."
    }),

    // ---- model family, selected by pre-fit diagnostic ----
    modelFamily: Object.freeze({
        candidates: Object.freeze(["Negative Binomial", "Zero-Inflated Negative Binomial"]),
        poissonExcluded: "Plain Poisson excluded on existing evidence — overdispersion measured at ~32x Poisson.",
        hurdleExcluded: "Hurdle model deliberately NOT offered as a third option: it adds a branch of researcher discretion without a compelling reason.",
        diagnostic: "Fit NB to training blocks; simulate the zero-count distribution from that fitted NB by parametric bootstrap; determine whether the OBSERVED zero count falls outside the simulated interval. No invented ratio threshold — the fitted model supplies what counts as excess.",
        decisionRule: "Compatible with ordinary overdispersion -> NB. Genuine separate zero-generating mechanism -> ZINB. AMBIGUOUS -> NB by default, as the simpler model that does not introduce a second zero-generating process without evidence for one.",
        timing: "The diagnostic runs BEFORE any outcome-based model fitting. Selecting a family after seeing RPS would be model selection dressed as estimation.",
        caveat: "At this sample size, regime-switching and zero-inflation are not cleanly separable. The diagnostic selects a family; it does not establish which mechanism is real."
    }),

    // ---- uncertainty ----
    uncertainty: Object.freeze({
        method: "Paired temporal block bootstrap. Blocks are sequential in time, so an IID bootstrap would understate uncertainty; RPSS is a ratio, so numerator and denominator must be resampled TOGETHER to preserve their covariance.",
        replicates: 10000,
        blockLengthRule: "ACF (not partial ACF) of the non-overlapping block count series, computed on TRAINING DATA ONLY; significance at the conventional +/-1.96/sqrt(n) band; bootstrap block length = first non-significant lag.",
        blockLengthFloor: 2,
        blockLengthCeiling: "10% of series length, rounded down",
        reportEffectiveUnits: "The resulting effective number of bootstrap units must be reported — 633 fifteen-day blocks at block length 10 are not 633 independent observations."
    }),

    // ---- precision: descriptive, never a gate ----
    precision: Object.freeze({
        approach: "DESCRIPTIVE, not a NON-EVALUABLE cutoff.",
        procedure: "Simulate outcomes from the frozen baseline's own predictive distributions, run the complete paired RPS/RPSS calculation and block bootstrap on each, and estimate the RPSS interval width under the null of NO SKILL.",
        whyBaselineNull: "Simulating under an assumed alternative would require positing the very model that has not been fitted — the invented effect size returning through the side door. The baseline null asks only how much information this design has, not how much it would need to detect something attractive.",
        reporting: "The null-RPSS interval width is reported per horizon ALONGSIDE the actual RPSS estimate and interval, so a reader can see directly how much information the estimate carries. No threshold gates any horizon."
    }),

    // ---- required reporting ----
    reporting: Object.freeze([
        "RPS and RPSS point estimates with block-bootstrap intervals, per horizon",
        "null-RPSS interval width per horizon",
        "matched-path usage: number and percentage of forecasts using >=8 calendar-month-matched training blocks",
        "fallback usage: number and percentage using the training-wide empirical distribution",
        "matched-block-count distribution, so a reader can see whether matched forecasts sit barely above the 8-block floor or have substantially more support",
        "effective number of bootstrap units",
        "zero-diagnostic result and the family it selected",
        "terminal coverage caveat (see below)"
    ]),

    baselineSparsityNote: "The empirical baseline makes the inherited 8-block minimum load-bearing in a way it was not for the binary version: 8 blocks estimating a distribution across 17 support bins is very thin, and add-one smoothing may dominate it, making the matched path behave much like the flat fallback. This is REPORTED, not fixed by changing the constant.",

    terminalCoverageCaveat: "The final recorded US incident in the eligible dataset occurs on 2025-04-17, leaving approximately eight months of the formally eligible 2000-2025 era without a recorded incident. These terminal zero-count blocks are RETAINED because the era boundary is date-defined and frozen, but they must NOT be interpreted as evidence of a genuine late-period decline. They represent the current historical data boundary and source-coverage state, and they will exert a downward pull on the final walk-forward training periods.",

    // ---- interpretation ----
    interpretation: Object.freeze({
        noThreshold: "COUNT-01 produces ESTIMATES, not verdicts. There is no pass. RPSS = 0.14 [0.03, 0.25] means the estimated skill improvement is 0.14 with that uncertainty — it does not mean SUPPORTED, validated, or authorized.",
        negativeIsNotFailure: "RPSS = -0.04 [-0.18, 0.10] is not a model failure. It is an estimate indicating the available data did not establish useful positive skill with the specified precision.",
        noNearPass: "A positive point estimate with an interval spanning zero is not a near pass. There is no pass.",
        multiplicity: "NONE — an estimation study makes no pass/fail claim, so there is no alpha to correct. The seven prior binary-estimand families remain historical exploratory work in the same programme and are NOT retroactively folded into a family with COUNT-01.",
        deployment: "A successful-looking result authorizes NOTHING on the public site. Any subsequent decision to act on it requires its own separately pre-registered specification.",
        scopeOfPriorFinding: "The closed seven-family NOT SUPPORTED result is scoped to the national-scale binary >=1-incident-in-N-days estimand. It is not a verdict on EWMA, those model classes, or alternative estimands generally."
    }),

    independentOf: Object.freeze(["DQ-01-L", "SHF-1A", "US-OBS-01 (uses only identifiable observed-count quantities)"]),
    doesNotModify: Object.freeze(["history.json", "production Risk Score", "public forecast UI", "SHF-1 frozen pipeline"])
});
