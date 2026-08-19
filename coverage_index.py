#!/usr/bin/env python3
"""
NHIRA Coverage Index.

Per-country breakdown of what NHIRA actually has, to expose research gaps
directly rather than leaving them implicit in the raw record count. Reuses
the verification-tier logic from source_quality.py rather than duplicating
its classification rules.

Also produces a decade-by-decade breakdown per country, to answer not just
"what incidents are missing" but "which countries and decades are
statistically underrepresented" — e.g. a country with 30 records from
2000-2025 and almost nothing before 2000 is a targeted research gap, not
just a smaller total.
"""
import json
from collections import defaultdict
from source_quality import score_record

def build_coverage_index(records):
    by_country = defaultdict(list)
    for r in records:
        by_country[r.get("country", "Unknown")].append(r)

    index = []
    for country, recs in by_country.items():
        years = [r["year"] for r in recs if r.get("year") is not None]
        with_coords = sum(1 for r in recs if r.get("lat") and r.get("lng"))
        verified = 0
        for r in recs:
            tier, _ = score_record(r)
            if tier == "STRONG":
                verified += 1
        multi_source = sum(1 for r in recs if len(r.get("sources", [])) >= 2)

        index.append({
            "country": country,
            "incidents": len(recs),
            "earliest": min(years) if years else None,
            "latest": max(years) if years else None,
            "pct_with_coords": round(100 * with_coords / len(recs), 1),
            "pct_multi_source": round(100 * multi_source / len(recs), 1),
            "pct_verified": round(100 * verified / len(recs), 1),
        })

    index.sort(key=lambda x: -x["incidents"])
    return index

def decade_coverage(records, country=None):
    """Per-decade incident counts for one country (or all, if country=None) —
    surfaces gaps like 'many 2000s+ records, almost nothing pre-1980'."""
    filtered = [r for r in records if country is None or r.get("country") == country]
    by_decade = defaultdict(int)
    for r in filtered:
        y = r.get("year")
        if y is not None:
            decade = (y // 10) * 10
            by_decade[decade] += 1
    return dict(sorted(by_decade.items()))

if __name__ == "__main__":
    data = json.load(open("/home/claude/history.json"))
    index = build_coverage_index(data)

    print(f"{'Country':<25} {'Incidents':>9} {'Earliest':>8} {'Latest':>7} {'Coords%':>8} {'2+Src%':>8} {'Verif%':>8}")
    print("-" * 80)
    for row in index:
        print(f"{row['country']:<25} {row['incidents']:>9} {row['earliest']:>8} {row['latest']:>7} "
              f"{row['pct_with_coords']:>7}% {row['pct_multi_source']:>7}% {row['pct_verified']:>7}%")

    print()
    print(f"Total countries represented: {len(index)}")
    print(f"Total records: {len(data)}")

    print()
    print("=== Decade gaps: countries with 10+ records but a >40-year span with zero coverage ===")
    for row in index:
        if row["incidents"] < 10:
            continue
        decades = decade_coverage(data, row["country"])
        decade_keys = sorted(decades.keys())
        if len(decade_keys) < 2:
            continue
        gaps = []
        for i in range(len(decade_keys) - 1):
            gap = decade_keys[i+1] - decade_keys[i]
            if gap > 40:
                gaps.append((decade_keys[i], decade_keys[i+1]))
        if gaps:
            print(f"  {row['country']}: {decades}")
            for start, end in gaps:
                print(f"    -> gap from {start}s to {end}s ({end - start} years with no records)")

    print()
    print("=== Isolated empty decades: countries with 10+ records, a decade with zero coverage")
    print("    sandwiched between decades that DO have some coverage ===")
    for row in index:
        if row["incidents"] < 10:
            continue
        decades = decade_coverage(data, row["country"])
        if not decades:
            continue
        span_start, span_end = min(decades), max(decades)
        empty = [d for d in range(span_start, span_end + 1, 10) if d not in decades]
        if empty:
            print(f"  {row['country']}: decades {span_start}s-{span_end}s, zero records in: {[f'{d}s' for d in empty]}")

    print()
    print("=== Recency concentration: % of a country's records from 2000 onward ===")
    print("    (a very high share here may reflect research-coverage bias toward recent,")
    print("    easily-searchable events rather than a genuine historical trend)")
    for row in index:
        if row["incidents"] < 10:
            continue
        decades = decade_coverage(data, row["country"])
        total = sum(decades.values())
        recent = sum(v for d, v in decades.items() if d >= 2000)
        pct = round(100 * recent / total, 1)
        print(f"  {row['country']}: {pct}% of records are from 2000 or later")
