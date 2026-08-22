
// =====================================================================
// NHIRA-DQ-01-L — LOCATION PROVENANCE METHODOLOGY
// Frozen sub-specification of NHIRA_DQ_01, scoped to the two SHF-1A
// primary populations. Long form: NHIRA-DQ-01-location-methodology.md
// (v1.0 retained separately as version evidence).
// =====================================================================

const NHIRA_DQ_01_L = Object.freeze({
    item: "NHIRA-DQ-01-L — Location Provenance Methodology",
    version: "1.1",
    status: "FROZEN",
    frozen: "2026-08-22",
    supersedes: "v1.0 — version bump; no v1.0 frozen figure altered",
    parent: "NHIRA-DQ-01",
    blocks: "SHF-1A-P",

    scope: Object.freeze({
        countries: Object.freeze(["United States", "Canada"]),
        recordsPreCleanup: Object.freeze({ "United States": 636, Canada: 215, total: 851 }),
        outOfScope: "The remaining 62 countries (149 records) receive location_precision: unknown and location_review_status: not_reviewed. They are neither clean nor contaminated — they are unassessed, and no analysis may use them until this methodology is extended under a new dated version."
    }),

    principles: Object.freeze([
        "Detect provenance; do not force agreement with an external gazetteer's preferred city point.",
        "No distance test at any tolerance may assign location_precision on its own.",
        "Source adjudication is final where automated reference matching cannot establish provenance.",
        "No tolerance expansion after seeing match rates.",
        "Ambiguity resolves downward: approximate over exact, unknown over approximate.",
        "Mixed provenance is a legitimate outcome, not a failure to be engineered away."
    ]),

    decimalPrecisionRule: "Decimal-place count must NEVER be used to infer location provenance. It MAY be used to determine whether a stored coordinate has sufficient measurement resolution for a particular distance calculation. These are different questions; state both together wherever either appears.",

    // ---- Step 1: coordinate-source fingerprint -----------------------
    fingerprint: Object.freeze({
        status: "OPEN — PENDING EMPIRICAL VERIFICATION",
        orderingRule: "Incident-grouping adjudication runs BEFORE the fingerprint set is constructed — not merely before the city lookups. A shared-coordinate group is evidence of a geocoder city point only if its members are distinct incidents.",

        groupsPreAdjudication: 72,
        recordsCovered: 205,
        groupsExpectedEligible: 69,
        denominatorRule: "Defined PROCEDURALLY, not numerically: the eligible set is those distinct-coordinate groups surviving incident-grouping adjudication with every surviving member a distinct incident. The final eligible count is recorded in the dataset-quality report BEFORE any candidate source is tested, and may not be revised after any candidate result is seen.",

        contaminatedGroups: Object.freeze([
            { city: "Caldwell",    size: 2, issue: "'Portstewart Senior Apartments Shooting' duplicated verbatim", effect: "dissolves on merge" },
            { city: "Tampa",       size: 2, issue: "'Tampa Multiple Location Shooting' duplicated verbatim; venue field reads 'Multiple locations'", effect: "dissolves on merge" },
            { city: "Springfield", size: 2, issue: "Kum & Go Gas Station / Springfield Multiple Location — same rampage", effect: "dissolves on merge" },
            { city: "Detroit",     size: 3, issue: "Frisbee Street / Residential Location / Various Locations — unresolved multi-site", effect: "survives at reduced size; re-examine members" },
            { city: "Tallahassee", size: 3, issue: "Hot Yoga / FSU Strozier Library / Tallahassee Residential — unresolved multi-site", effect: "survives at reduced size; re-examine members" }
        ]),

        scoringRule: "Candidates are scored on DISTINCT-COORDINATE GROUPS, never on record counts. Weighting by records would let Houston (9) and Montreal (9) dominate a large share of the score, so a candidate matching a few large cities could appear identified while failing most of the set.",

        identificationThresholds: Object.freeze({
            label: "identification thresholds (not 'adequacy' thresholds — no interpretation required after results are seen)",
            IDENTIFIED: ">=90% of eligible distinct-coordinate groups with residual <=10 m, AND no eligible group's residual exceeding 50 m",
            AMBIGUOUS:  "two or more candidates meet IDENTIFIED — document all, proceed with none as primary",
            MIXED:      "no candidate reaches 90%, but disjoint subsets independently match different candidates at the specified precision",
            UNRESOLVED: "no candidate reproduces >=50% of eligible groups at any residual <=50 m",
            frozenBeforeTesting: true,
            note: "Source identification is an empirical provenance exercise, not a model-selection exercise. The candidate is never chosen for producing more convenient downstream classifications."
        }),

        requiredPerCandidateRecord: Object.freeze([
            "N groups tested", "N matched", "match percentage",
            "minimum residual", "median residual", "90th-percentile residual", "maximum residual",
            "full residual distribution / histogram",
            "itemised list of groups failing the criterion",
            "outcome classification"
        ]),
        recordRejectedCandidates: true,

        documentedFailureCase: "All nine Houston records carry 29.7604, -95.3698. GeoNames' populated-place coordinate for Houston is 29.76328, -95.36327 — 707 m away, outside any candidate or review zone. Wikipedia's Houston point is 602 m away. Matching contamination generated by source A against gazetteer B measures the disagreement between two references, not the distance from an incident to a city.",

        producesSourceIdentityNotVocabulary: "Step 1 produces a SOURCE IDENTITY, not a reusable coordinate vocabulary. Matching all records against the discovered coordinate VALUES was tested and catches only 4 additional records, because a single-incident city carries its own city point, not another city's. 537 distinct city keys exist in the US/Canada subset and most appear once. Generalization comes from the per-record lookup step, never from value matching."
    }),

    // ---- Step 2: derived reference artifact --------------------------
    referenceArtifact: Object.freeze({
        file: "location_reference_set.json",
        executesOnlyOn: Object.freeze(["IDENTIFIED", "MIXED"]),
        onAmbiguousOrUnresolved: "No primary source is frozen; affected records route to Stage 3 source adjudication.",
        derivedNotLive: "The identified source may be a live commercial service that drifts, becomes unavailable, or does not permit later bulk re-querying. The frozen artifact is therefore the DERIVED reference set, not a dependency on the live source.",
        perLookupFields: Object.freeze(["query string as issued", "source identity", "query date", "returned coordinate", "source status (found / not found / ambiguous / error)", "gazetteer_id where provided"]),
        neverUpdateInPlace: "A new source query requires a new dated artifact version. Classifications always cite the artifact version they were made against."
    }),

    // ---- Step 3: per-record expected reference -----------------------
    perRecordLookup: Object.freeze({
        distinctLookups: 537,
        rule: "Generate the expected city-reference coordinate for THAT RECORD'S OWN city, then compare the stored coordinate against it. This is the generalizing step — it reaches single-incident cities, which neither the repeated-coordinate scan nor value matching can see.",
        missingAdminField: "1 US/Canada record lacks state. Where an administrative field is not part of the source query for a country, record not_applicable; where expected but absent, record missing. Never invent one.",
        compoundCityRecords: 19,
        compoundCityRule: "Compound city values (e.g. 'Phoenix and Mesa', 'Ladera Ranch, Tustin, Santa Ana') are unresolved multi-site incidents surfacing as location data. Routed to incident-grouping resolution BEFORE the location lookup, never after — a compound string cannot be looked up as written."
    }),

    // ---- Step 4: measurement-resolution gate -------------------------
    resolutionGate: Object.freeze({
        rows: Object.freeze([
            { precision: "0-2 dp", halfStep: "+/- 557 m or worse", treatment: "distance test INAPPLICABLE -> Stage 3" },
            { precision: "3 dp",   halfStep: "+/- 56 m",           treatment: "MARGINAL -> Stage 3 if candidate or ambiguous" },
            { precision: "4+ dp",  halfStep: "+/- 6 m or better",  treatment: "distance comparison permitted" },
            { precision: "unknown / non-numeric", halfStep: "-",   treatment: "Stage 3" }
        ]),
        usCanadaRouting: Object.freeze({ inapplicable: 87, inapplicableUS: 21, inapplicableCanada: 66, marginal: 228, stage3Total: 315, pctOfSubset: 37 }),
        canadaWarning: "66 of Canada's 215 records — nearly one third — are <=2 dp. Canada is already the marginal country for the SHF-1A-P power gate, and low-resolution records adjudicating to city_centroid leave the eligible set. Recorded as a FORESEEABLE contributor to a Canadian POWER PRECONDITION FAILED, which remains a legitimate terminal state."
    }),

    // ---- Step 5: distance screening ---------------------------------
    distanceScreening: Object.freeze({
        zones: Object.freeze([
            { range: "<= 100 m",        flag: "centroid_candidate" },
            { range: "> 100 m to <= 500 m", flag: "centroid_review_candidate" },
            { range: "> 500 m",         flag: "not automatically cleared" }
        ]),
        interpretationRule: "Distance is always interpreted against the specific reference named in gazetteer_match_basis, never generically 'the city'. No flag at any zone assigns location_precision.",
        frozenBeforeInspection: true
    }),

    crossCheck: "Frozen dated GeoNames snapshot, P-class (populated places) and A-class (administrative divisions). A-class matters because some records may be geocoded to county or state reference points. GeoNames is independent verification and a gazetteer_id source — NOT the primary matcher.",

    sourceAdjudication: Object.freeze({
        venueDocumented: "exact or approximate",
        cityOnlyDocumented: "city_centroid",
        provenanceUnestablished: "unknown"
    }),

    recordedFields: Object.freeze({
        location_precision: Object.freeze(["exact", "approximate", "city_centroid", "unknown"]),
        location_method: Object.freeze(["official_source_coordinates", "address_geocode", "venue_geocode", "gazetteer_match", "map_verified", "city_centroid", "approximate_location", "other", "unknown"]),
        location_review_status: Object.freeze(["not_reviewed", "reviewed", "adjudicated"]),
        gazetteer_match_basis: Object.freeze(["empirical_shared_coordinate", "GeoNames_P", "GeoNames_A", "official_source", "other_reference", "none"]),
        auditFields: Object.freeze(["gazetteer_distance_m", "gazetteer_source", "gazetteer_snapshot", "gazetteer_id", "location_reference_set_version"]),
        axisNote: "location_method records HOW the coordinate was obtained; location_review_status records WHETHER NHIRA has examined it. Separate axes; neither implies the other."
    }),

    workflow: Object.freeze([
        "Deduplication / incident grouping (compound-city records resolved FIRST)",
        "Construct eligible fingerprint set (72 pre-adjudication -> <=69 eligible)",
        "Candidate source testing -> outcome classification",
        "Freeze location_reference_set.json",
        "Measurement-resolution gate",
        "Compare each stored coordinate to its OWN expected reference",
        "GeoNames P/A cross-check",
        "Source adjudication where required",
        "Assign location_precision + location_method + location_review_status",
        "Run definitive deduplication",
        "Calculate post-cleanup eligible N per country",
        "SHF-1A-P null-only power pre-check"
    ]),
    workflowNote: "Each step is a gate, not a schedule.",

    independenceRequirements: Object.freeze([
        "Classification rules are frozen before any SHF-1A-P run.",
        "The backfill must not be evaluated against, or adjusted in response to, any power-gate outcome.",
        "No record may be reclassified after a failed power pre-check.",
        "Any post-hoc classification change is documented with its reason and invalidates all prior pre-check results."
    ]),

    completionNote: "Completion is a data-state determination. It carries no implication about whether SHF-1A-P will pass."
});
