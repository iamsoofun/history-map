// NHIRA-DQ-01-L — Frozen scoring result
// Stage 1 complete; frozen scorer executed against the locked 70-group denominator.
// Verdict: UNRESOLVED.

const NHIRA_DQ_01_L_RESULT = Object.freeze({
  item: "NHIRA-DQ-01-L — Frozen scoring result",
  spec: "NHIRA-DQ-01-L v1.1 §5",
  status: "SCORED",
  denominator: 70,
  outcome: "UNRESOLVED",
  candidate: {
    name: "OpenStreetMap / Nominatim",
    tested: 69,
    not_found: 1,
    matched_within_10m: 5,
    match_pct: 7.1,
    pct_within_50m: 15.7,
    meets_IDENTIFIED: false
  },
  downstream: {
    city_lookups_537: "BLOCKED_PENDING_USABLE_SOURCE",
    hierarchical_modeling_prerequisite: "NOT_SATISFIED_BY_THIS_SOURCE"
  },
  interpretation: "DQ-01-L Stage 1 and frozen scoring are complete. The fingerprint does not identify a usable source. No coordinates are retained on the basis of this result."
});

if (typeof module !== "undefined") module.exports = NHIRA_DQ_01_L_RESULT;
