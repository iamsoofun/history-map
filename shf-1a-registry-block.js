// =====================================================================
// SHF-1A — SPACE-TIME SELF-EXCITATION DIAGNOSTIC
// Pre-execution finding. Same documentation discipline as the lock and
// findings registries above, with one structural difference: this is NOT
// a closed experiment with a verdict. The frozen protocol was never
// validly executed, so no hypothesis verdict exists to record. That
// distinction is the entire point of the entry — see `amendment` below.
// Long form: SHF-1A-registry-entry.md / NHIRA-DQ-01.md
// =====================================================================

const SHF_PROTOCOL_STATUS = Object.freeze({
    NOT_EXECUTED:  "NOT EXECUTED — PRECONDITIONS UNMET",
    SUPPORTED:     "SUPPORTED",
    NOT_SUPPORTED: "NOT SUPPORTED",
    INCONCLUSIVE:  "INCONCLUSIVE"
});

const SHF_1A_FINDING = Object.freeze({
    protocol: "SHF-1A — Space-Time Self-Excitation Diagnostic v2",
    status: SHF_PROTOCOL_STATUS.NOT_EXECUTED,
    findingDate: "2026-08-22",
    hypothesisVerdict: null,          // no verdict assigned — never render as a result
    modelAuthorized: false,           // no spatiotemporal point-process work authorized

    scope: "Whether the NHIRA dataset contains short-range space-time self-excitation at all — a data-generating-process diagnostic run BEFORE any Hawkes or other point-process model is fitted. Not a forecast, not a model comparison, and not a verdict on self-excitation either way.",

    preconditionsUnmet: Object.freeze([
        "location_precision absent from schema",
        "location_method absent from schema",
        "incident-identity grouping absent (incident_id / site_id / incident_scope)",
        "definitive duplicate + multi-location review not run on expanded dataset",
        "frozen analysis era not established per country"
    ]),

    priorHawkesWork: Object.freeze({
        finding: "RESEARCH_FINDINGS_REGISTRY.forecastClockCalibration",
        recorded: "2026-08-20",
        whatWasTested: "Temporal (non-spatial) self-exciting Hawkes process, US, 7/10/15-day horizons.",
        outcome: "NOT SUPPORTED — lowest Brier of any model tested, but branching ratio at the stability bound in most windows (~200-250 events per training window), read as overfitting rather than a near-miss.",
        relationToSHF1A: "SHF-1A concerns the SPATIOTEMPORAL formulation and was never executed. The temporal result is corroborating evidence on event density, not a substitute for the spatial diagnostic, and not superseded by it."
    }),

    exploratoryArtifact: Object.freeze({
        label: "EXPLORATORY — NOT SHF-1A EXECUTION",
        permutations: 200,            // frozen protocol requires B = 10000
        rngSeed: 42,
        blocking: "within-year",
        grid: "25-cell (1/5/10/25/50 km x 1/3/7/14/30 d)",
        evaluableCells: Object.freeze({ "United States": 5, Canada: 6, required: 13 }),
        preCleanupN: Object.freeze({ "United States": 579, Canada: 140, era: "2000-2025" }),
        operationalCellNote: "US 10km x 7d showed 5 observed vs 1.5 null (E=3.3, above the E>=2.0 bar) while being NON-EVALUABLE under the mu>=5 floor — an illustration of why the power floor precedes the effect-size test, not evidence of self-excitation.",
        duplicateContamination: "All five US pairs inside the operational window are probable duplicate or split multi-site records (e.g. Indianapolis FedEx 2021-04-15 / FedEx Ground Plainfield 2021-04-16). The apparent signal is a data-quality artifact.",
        comparabilityWarning: "Eligible N changes every null mean, so this grid is not numerically comparable to any future execution on a repaired dataset.",
        interpretationBar: "Documents why execution was halted. Not an effect-size estimate, and never to be presented as an SHF-1A result."
    }),

    amendment: Object.freeze({
        section: "v2 §31",
        type: "ADDITIVE_ONLY",
        change: "Added a fourth status category: NOT EXECUTED — PRECONDITIONS UNMET",
        criteriaAltered: false,
        untouched: Object.freeze(["§9", "§10", "§14", "§15", "§17", "§18", "§19", "§20", "§21", "§22", "§23"]),
        note: "Made after inspecting exploratory output. Permissible because it alters no pass/fail criterion and applies only to datasets the diagnostic has not run on. Any future amendment touching a pass/fail criterion is a freeze violation and must be recorded as one."
    }),

    powerPreCheck: Object.freeze({
        id: "SHF-1A-P — Null-Only Power Pre-Check",
        purpose: "Determine whether the frozen permutation null can generate enough expected pair density for the 25-cell grid, without ever inspecting an observed pair count.",
        gate: "≥13 of 25 cells with permutation-null mean ≥5",
        informationBarrier: "Uses eligible locations, the observed event-time distribution, the frozen era, the frozen blocking scheme and the frozen grid. Never computes observed pair counts, excess ratios, observed p-values or effect sizes.",
        classificationIndependence: "Classification rules frozen before any pre-check run. Ambiguity resolves toward LOWER precision. No record may be reclassified after a failed gate.",
        eraIndependence: "Exactly one era per country, frozen on source-coverage grounds alone before the pre-check runs. No re-selection on failure.",
        eligibleNRule: "Eligible N is the POST-dedup, POST-grouping count. The preCleanupN figures above must never be used as eligible N."
    }),

    reopening: Object.freeze({
        governingRuleByStatus: Object.freeze({
            "NOT EXECUTED — PRECONDITIONS UNMET": "SHF-1A finding §17 (schema, provenance, grouping, dedup, power gate)",
            "NOT SUPPORTED": "SHF-1A v2 §29 (N>=300 eligible, +50% eligible growth, consistent collection regime)",
            "INCONCLUSIVE": "SHF-1A v2 §15/§22 evaluability conditions, plus §17 if the shortfall was schema-related"
        }),
        conditions: Object.freeze([
            "location_precision populated on every record",
            "location_method populated on every eligible coordinate",
            "canonical incident grouping distinguishes duplicate / single-site / multi-site / compound",
            "definitive dedup + incident-grouping review complete",
            "SHF-1A-P null-only power gate: >=13 of 25 cells with null mean >=5"
        ]),
        canadaNote: "A permanent POWER PRECONDITION FAILED for Canada is a legitimate terminal state, not a pending task. At ~5.4 events/year pre-cleanup, Canada may never support the diagnostic at national scale, and Condition 5 must not become an open-ended treadmill."
    }),

    blockedBy: "NHIRA-DQ-01",
    unaffected: Object.freeze(["SHF-1 frozen pipeline", "Model C production", "live site"]),
    recordedDate: "2026-08-22"
});

const NHIRA_DQ_01 = Object.freeze({
    item: "NHIRA-DQ-01 — Spatial Provenance and Incident-Identity Backfill",
    status: "OPEN",
    opened: "2026-08-22",
    origin: "SHF-1A pre-execution finding",
    blocks: Object.freeze(["SHF-1A-P", "SHF-1A v2"]),

    defectsAddressed: Object.freeze([
        "Coordinate provenance unrecorded — no field separates 'the incident occurred here' from 'this coordinate represents the city because only the city is known'.",
        "Incident identity unrecorded — no field separates one real-world incident from a duplicate record of it, or from a component site of a multi-site incident."
    ]),

    deliverables: Object.freeze([
        "location_precision populated on every record",
        "location_method populated on every eligible coordinate",
        "incident_id assigned across the full dataset",
        "site_id where applicable",
        "parent_incident_id where applicable",
        "incident_scope populated on every incident",
        "complete duplicate review with resolutions recorded",
        "complete multi-location review with resolutions recorded",
        "frozen analysis era per primary country with written rationale",
        "updated dataset-quality report"
    ]),

    controlledValues: Object.freeze({
        location_precision: Object.freeze(["exact", "approximate", "city_centroid", "unknown"]),
        location_method: Object.freeze(["venue_geocode", "address_geocode", "gazetteer_match", "official_source_coordinates", "map_verified", "city_centroid", "approximate_location", "other", "unknown"]),
        incident_scope: Object.freeze(["single_site", "multi_site", "compound_event", "unknown"])
    }),

    prohibited: "Decimal-place count must not be used as a precision classifier, in whole or in part. Houston's centroid is stored to 4dp and ~751 of 1,000 latitude values are 4dp regardless of provenance.",
    repeatedCoordinateRule: "At least 207 records share coordinates with another record. That is a contamination SIGNAL used to prioritise review order — not a centroid-identification method, since single-incident cities also carry centroids and appear unique.",
    multiSiteInvariant: "A multi-site incident is ONE incident for all event-count and pairwise-event analysis. Component sites may be retained for geographic detail but never enter an analysis as independent events.",
    priorityQueue: "All record pairs at d < 1 km and dt <= 7 days are adjudicated FIRST, before any analysis runs, so the adjudication cannot be influenced by whether it helps a gate.",
    independenceRule: "Classification rules written and frozen before any power pre-check. Ambiguity resolves toward lower precision. No reclassification after a failed gate; any post-hoc change invalidates all prior pre-check results.",

    doesNotDo: Object.freeze([
        "does not modify the production Risk Score, Model C, or any live site behaviour",
        "does not modify the frozen SHF-1 pipeline",
        "does not fit, tune or evaluate any model",
        "does not authorize any point-process research",
        "does not alter any SHF-1A v2 pass/fail criterion"
    ])
});

