
// =====================================================================
// IA-01 — INTER-ARRIVAL STRUCTURE (DESCRIPTIVE)
// A descriptive finding about the eligible COUNT-01 series. NOT a model
// result, NOT a COUNT-02 authorization, and NOT evidence for any
// specific mechanism. Provenance: motivated by the pre-existing
// Forecast Clock / Model D duration design — not invented after seeing
// the forecast calibration failure.
// =====================================================================

const IA_01_FINDING = Object.freeze({
    id: "IA-01",
    title: "Inter-Arrival Structure vs Constant Hazard",
    kind: "descriptive",
    recordedDate: "2026-08-22",
    series: "COUNT-01 eligible set — US, 2000-01-01 to 2025-12-31, 577 records (547 distinct event-days, 30 same-day record pairs)",
    null: "Constant-hazard process; daily date resolution makes the discrete GEOMETRIC distribution the correct null, not a continuous exponential — a continuous KS test would reject on granularity alone.",

    result: Object.freeze({
        verdict: "Constant hazard strongly incompatible with the observed series",
        definitionA: "every record an event (0-day gaps allowed): chi2 = 186.3, mean gap 15.93 d, var/mean = 51.9",
        definitionB: "collapsed to distinct event-days (gaps >= 1): chi2 = 180.6, mean gap 16.81 d, var/mean = 51.1",
        robustToSameDayDefinition: "Both definitions reject nearly identically — the 30 same-day pairs are not driving the result.",
        shape: Object.freeze([
            "2-3 day gaps:  94 observed vs 30.1 expected — ~3x excess",
            "4-6 day gaps:  91 vs 51.8",
            "7-10 day gaps: 83 vs 62.8",
            "23-44 day gaps: under-represented (61 vs 97.4 combined)",
            "45+ day gaps:  40 vs 37.2 — near expectation; NO distinctive long-gap regime"
        ]),
        direction: "Departure is concentrated ENTIRELY in short gaps. This is decreasing hazard / short-lag clustering — the opposite direction from a quiet-period story."
    }),

    duplicateRobustnessCheck: Object.freeze({
        method: "Full-series sweep for pairs within 10 days AND (<=25 km or same city), scored on distance, city, title-token overlap, casualty match, gap length. Descriptive only — no records changed.",
        candidatePairs: 4,
        highSuspicion: Object.freeze([
            "id180/id455 — Interstate 75, London KY, 1 day apart, 0.10 km, identical casualties (0/8) — probable duplicate",
            "id31/id904 — Indianapolis FedEx / FedEx Ground Plainfield, 1 day apart, 1.88 km, identical casualties (8/7) — probable duplicate",
            "id1089/id1090 — Tallahassee — previously adjudicated DISTINCT; stands"
        ]),
        conclusion: "Two plausible residual duplicate pairs against a short-gap excess of ~64 events. Removing both moves the chi-square by a rounding error. The clustering is NOT a contamination artifact.",
        limitation: "The sweep only catches spatially-close duplicates; a same-incident pair geocoded to different cities would slip through. Both duplicates it found were caught by exactly that spatial signature, and 4 candidates in 577 records indicates the series is in good shape."
    }),

    notSpatial: "Only 4 of the ~64 excess short-gap pairs are geographically close. Whatever produces the clustering operates NATIONALLY, not locally — a genuine constraint on future models, and evidence AGAINST a spatiotemporal formulation as the explanation.",

    doesNotEstablish: Object.freeze([
        "which mechanism produces the clustering — self-excitation, renewal/duration dependence, a common national external driver, reporting/collection clustering, or another process",
        "that a renewal model would outperform the previously tested Hawkes formulation — both frameworks represent short-gap clustering",
        "any COUNT-02 authorization — the finding narrows the question, it does not open an experiment"
    ]),

    sharpenedQuestion: "Does elapsed time since the previous incident provide INCREMENTAL predictive information beyond the temporal structure already captured by the tested Hawkes formulation and the frozen COUNT-01 baseline? This question is recorded, not scheduled: COUNT-01 executes first, and any duration-vs-Hawkes study requires its own frozen specification.",

    provenance: "The duration concept predates this finding — the Forecast Clock / Model D design specified time-since-last-incident and censored non-events before the quiet-period observation existed. Chain: Forecast Clock concept -> descriptive geometric gate -> short-gap clustering -> contamination robustness check -> potential duration-vs-Hawkes study.",

    followUp: "id180/id455 and id31/id904 are referred to the DQ-01 adjudication queue as suspected duplicates. Neither the COUNT-01 dataset nor this finding is modified by that referral; if adjudication later merges them, this finding's robustness section already quantifies the (negligible) effect."
});
