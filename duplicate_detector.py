#!/usr/bin/env python3
"""
NHIRA duplicate detector.

Systematically compares every record in history.json against every other
record that could plausibly be the same incident, using multiple weighted
signals rather than any single field. Outputs candidate pairs for human
review — this tool never merges or deletes anything automatically.

Design:
  - Records are bucketed by (year, country) first, purely for efficiency
    (971 records = ~470k possible pairs if compared blindly; bucketing
    cuts this down enormously since real duplicates are always close in
    date and location).
  - Within each bucket, adjacent-year buckets are also compared, to catch
    incidents near a year boundary that different sources dated on either
    side of Dec 31 / Jan 1.
  - Each pair gets a similarity score built from: date proximity, city/state
    match, title similarity (difflib), and fatality-count closeness.
  - Only pairs crossing a deliberately conservative threshold are reported,
    to keep the output reviewable rather than overwhelming.
"""
import json
import re
import difflib
from collections import defaultdict
from datetime import datetime, timedelta

def load_records(path):
    return json.load(open(path))

def parse_date(d):
    try:
        return datetime.strptime(d, "%Y-%m-%d")
    except (ValueError, TypeError):
        return None

# GVA-style auto-generated titles follow a small number of generic templates
# ("Multiple Location X Shooting", "Various Locations Y Shooting", etc.).
# These shared boilerplate words inflate raw string similarity even when X
# and Y are completely different cities — e.g. "Residential Location Houston
# Shooting" vs "Various Locations Detroit Shooting" scores deceptively high
# on the full string despite describing unrelated events. Stripping the
# boilerplate before comparing leaves just the distinctive part (city/venue
# names), which is what should actually drive the similarity signal.
_BOILERPLATE_PATTERNS = [
    r"\bmultiple[\s-]location(s)?\b",
    r"\bvarious[\s-]location(s)?\b",
    r"\bresidential[\s-]location\b",
    r"\bmultiple\b", r"\bvarious\b",
    r"\band\b", r"\bin\b", r"\bat\b", r"\bof\b",
    r"\bshooting(s)?\b",
]

def strip_boilerplate(title):
    t = title.lower()
    for pat in _BOILERPLATE_PATTERNS:
        t = re.sub(pat, " ", t)
    return re.sub(r"\s+", " ", t).strip()

def is_templated(title):
    """True if the title is built from the generic GVA-style template
    (as opposed to a distinctive, specific title like a proper-noun event
    name) — used to decide whether to trust raw title similarity or the
    boilerplate-stripped version."""
    t = title.lower()
    return bool(re.search(r"\b(multiple|various|residential)[\s-]location", t))

def title_similarity(a, b):
    raw = difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()
    if is_templated(a) or is_templated(b):
        stripped_a, stripped_b = strip_boilerplate(a), strip_boilerplate(b)
        if not stripped_a or not stripped_b:
            return 0.0
        return difflib.SequenceMatcher(None, stripped_a, stripped_b).ratio()
    return raw

def score_pair(r1, r2):
    """Returns (score, signals_dict). Score is 0-1; signals shown for review."""
    signals = {}

    d1, d2 = parse_date(r1.get("date", "")), parse_date(r2.get("date", ""))
    if d1 and d2:
        day_diff = abs((d1 - d2).days)
        signals["date_diff_days"] = day_diff
        if day_diff == 0:
            date_score = 1.0
        elif day_diff <= 2:
            date_score = 0.7
        elif day_diff <= 7:
            date_score = 0.3
        else:
            date_score = 0.0
    else:
        date_score = 0.0
        signals["date_diff_days"] = None

    same_country = r1.get("country") == r2.get("country")
    same_city = (r1.get("city") or "").strip().lower() == (r2.get("city") or "").strip().lower() and r1.get("city")
    same_state = (r1.get("state") or "").strip().lower() == (r2.get("state") or "").strip().lower() and r1.get("state")
    signals["same_country"] = same_country
    signals["same_city"] = bool(same_city)
    signals["same_state"] = bool(same_state)
    loc_score = (0.5 if same_country else 0.0) + (0.35 if same_city else 0.0) + (0.15 if same_state else 0.0)
    loc_score = min(loc_score, 1.0)

    t_sim = title_similarity(r1.get("title", ""), r2.get("title", ""))
    signals["title_similarity"] = round(t_sim, 3)

    f1, f2 = r1.get("fatalities"), r2.get("fatalities")
    if f1 is not None and f2 is not None:
        signals["fatalities"] = (f1, f2)
        if f1 == f2:
            fat_score = 1.0
        elif abs(f1 - f2) <= max(1, 0.15 * max(f1, f2)):
            fat_score = 0.5
        else:
            fat_score = 0.0
    else:
        fat_score = 0.0
        signals["fatalities"] = (f1, f2)

    # Weighted combination — date and location carry the most weight since
    # those are the most reliable "this is physically the same event" signals;
    # title/fatality corroborate but shouldn't dominate given wording and
    # reporting-count differences are common even for genuine duplicates.
    score = date_score * 0.40 + loc_score * 0.30 + t_sim * 0.20 + fat_score * 0.10
    return score, signals

def build_buckets(records):
    buckets = defaultdict(list)
    for r in records:
        year = r.get("year")
        country = r.get("country")
        if year is not None:
            buckets[(year, country)].append(r)
    return buckets

def find_candidates(records, threshold=0.55):
    buckets = build_buckets(records)
    bucket_keys = list(buckets.keys())
    candidates = []
    seen_pairs = set()

    for (year, country) in bucket_keys:
        # Compare within the same bucket, and against the adjacent-year
        # bucket for the same country (catches year-boundary date splits).
        compare_buckets = [(year, country)]
        if (year + 1, country) in buckets:
            compare_buckets.append((year + 1, country))

        base = buckets[(year, country)]
        for cb in compare_buckets:
            other = buckets[cb]
            for i, r1 in enumerate(base):
                start_j = i + 1 if cb == (year, country) else 0
                for j in range(start_j, len(other)):
                    r2 = other[j]
                    if r1["id"] == r2["id"]:
                        continue
                    pair_key = tuple(sorted([r1["id"], r2["id"]]))
                    if pair_key in seen_pairs:
                        continue
                    seen_pairs.add(pair_key)

                    score, signals = score_pair(r1, r2)
                    if score >= threshold:
                        candidates.append({
                            "score": round(score, 3),
                            "id1": r1["id"], "title1": r1["title"], "date1": r1.get("date"),
                            "country1": r1.get("country"), "city1": r1.get("city"),
                            "id2": r2["id"], "title2": r2["title"], "date2": r2.get("date"),
                            "country2": r2.get("country"), "city2": r2.get("city"),
                            "signals": signals
                        })
    candidates.sort(key=lambda c: -c["score"])
    return candidates

if __name__ == "__main__":
    records = load_records("/home/claude/history.json")
    candidates = find_candidates(records, threshold=0.55)
    print(f"Total records: {len(records)}")
    print(f"Candidate pairs found (threshold >= 0.55): {len(candidates)}")
    print()
    for c in candidates:
        print(f"Score {c['score']}  |  id={c['id1']} \"{c['title1']}\" ({c['date1']}, {c['city1']}, {c['country1']})")
        print(f"           |  id={c['id2']} \"{c['title2']}\" ({c['date2']}, {c['city2']}, {c['country2']})")
        print(f"           |  signals: {c['signals']}")
        print()
