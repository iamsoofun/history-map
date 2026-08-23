#!/usr/bin/env python3
"""NHIRA DQ-01-L v1.1 §5.4 — candidate source scorer.

Fill candidate_results in fingerprint-test-fixture.json with, per group:
    {"CandidateName": {"lat": <float>, "lng": <float>}}   (or null if not found)
then run:  python3 score-fingerprint.py fingerprint-test-fixture.json

Thresholds are frozen. This script does not choose a candidate; it classifies.
"""
import json, math, sys, statistics
R = 6371000.0
def hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    h = math.sin((la2-la1)/2)**2 + math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2
    return 2*R*math.asin(min(1, math.sqrt(h)))

fx = json.load(open(sys.argv[1], encoding='utf-8'))
groups, N = fx["groups"], fx["frozen_denominator"]
if len(groups) != N:
    sys.exit(f"ABORT: fixture has {len(groups)} groups, frozen denominator is {N}")

registry = {c["name"]: c for c in fx.get("candidates", [])}
names = sorted({c for g in groups for c in g["candidate_results"]})
unregistered = [n for n in names if n not in registry]
if unregistered:
    print(f"WARNING: not in frozen registry, treated as post-hoc: {unregistered}\n")
declined = [n for n in names if (registry.get(n) or {}).get("eligibility_identification", "").startswith("DECLINED")]
if declined:
    print(f"NOTE: scored but terms-declined for identification: {declined}\n")
if not names:
    sys.exit("No candidate_results populated yet.")

report, identified = {}, []
for name in names:
    res, missing = [], 0
    for g in groups:
        v = g["candidate_results"].get(name)
        if not v or v.get("lat") is None:
            missing += 1; continue
        res.append(hav((g["observed_lat"], g["observed_lng"]), (v["lat"], v["lng"])))
    tested = len(res)
    within10 = sum(1 for d in res if d <= 10)
    # denominator is ALWAYS the frozen N -- not-found groups count against the candidate
    pct = 100.0 * within10 / N
    mx = max(res) if res else float('inf')
    meets = pct >= 90 and mx <= 50
    role = (registry.get(name) or {}).get("role", "candidate")
    posthoc = name in unregistered or (registry.get(name) or {}).get("post_hoc_candidate", False)
    if meets and role == "candidate" and not posthoc: identified.append(name)
    report[name] = dict(
        tested=tested, not_found=missing, matched_within_10m=within10,
        match_pct=round(pct, 1),
        min_m=round(min(res), 2) if res else None,
        median_m=round(statistics.median(res), 2) if res else None,
        p90_m=round(sorted(res)[int(0.9*len(res))-1], 2) if res else None,
        max_m=round(mx, 2) if res else None,
        pct_within_50m=round(100.0*sum(1 for d in res if d <= 50)/N, 1),
        meets_IDENTIFIED=meets, role=role, post_hoc=posthoc,
        failing_groups=[g["group_id"] for g in groups
                        if not (g["candidate_results"].get(name) or {}).get("lat")
                        or hav((g["observed_lat"], g["observed_lng"]),
                               (g["candidate_results"][name]["lat"],
                                g["candidate_results"][name]["lng"])) > 10])

if len(identified) == 1:   outcome = f"IDENTIFIED — {identified[0]}"
elif len(identified) > 1:  outcome = f"AMBIGUOUS — {', '.join(identified)} (proceed with none as primary)"
elif all(r["pct_within_50m"] < 50 for r in report.values()):
    outcome = outcome = "UNRESOLVED — no candidate satisfies the frozen IDENTIFIED rule (>=90% of groups within 10m AND max residual <=50m)"
else:
    outcome = "MIXED — no candidate reaches 90%; check whether disjoint subsets match different candidates"

print(f"Frozen denominator N = {N}\n")
for n, r in report.items():
    print(f"{n}: {r['match_pct']}% within 10m ({r['matched_within_10m']}/{N}), "
          f"max {r['max_m']}m, median {r['median_m']}m, p90 {r['p90_m']}m, "
          f"not-found {r['not_found']} -> IDENTIFIED={r['meets_IDENTIFIED']}")
print(f"\nOUTCOME: {outcome}")
json.dump({"outcome": outcome, "denominator": N, "candidates": report},
          open("fingerprint-test-results.json", "w", encoding='utf-8'), indent=1)
print("\nFull residual record written to fingerprint-test-results.json")
