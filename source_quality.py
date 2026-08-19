#!/usr/bin/env python3
"""
NHIRA source-quality scorer.

Raw source *count* is a poor proxy for reliability — a single citation to a
dedicated Wikipedia article about a well-documented event (e.g. Columbine)
is far more trustworthy than multiple citations to obscure, unverifiable
outlets. This scores each record by what its sources actually *are*, not
just how many there are.

Tiers:
  STRONG    - 2+ sources, OR a single source that is either an official/
              primary domain (.gov, police, FBI, UN, major established
              news outlet) or a dedicated (non-list-page) Wikipedia article.
  WEAK      - single source citing a generic Wikipedia list/index page
              rather than an article specific to this incident — doesn't
              actually demonstrate independent verification of this
              incident's details.
  UNCLEAR   - single source that doesn't clearly fall into either bucket
              above (unrecognized domain/format) — flagged for human review,
              not assumed bad.
"""
import json
import re
from collections import Counter, defaultdict

PRIMARY_DOMAIN_PATTERNS = [
    r"\.gov(/|$)", r"\.gov\.", r"fbi\.gov", r"un\.org", r"police\.",
    r"nps\.gov", r"justice\.gov", r"parliament\.", r"rcmp",
]
MAJOR_NEWS_DOMAINS = [
    "apnews.com", "reuters.com", "bbc.", "cbc.ca", "nytimes.com",
    "washingtonpost.com", "latimes.com", "lemonde.fr", "theguardian.com",
    "cnn.com", "npr.org", "globalnews.ca", "ctvnews.ca",
]
# Many NHIRA sources are stored as plain organization names rather than
# URLs (e.g. "Federal Bureau of Investigation — Active Shooter Incidents
# in the United States in 2021") — these are genuinely authoritative,
# primary-source citations and need to be recognized as such even without
# a matching domain string.
PRIMARY_ORG_NAME_PATTERNS = [
    r"federal bureau of investigation", r"\bfbi\b",
    r"department of (public )?safety", r"police (department|service)",
    r"sheriff'?s office", r"\brcmp\b", r"royal canadian mounted police",
    r"government of", r"\bbureau of\b", r"attorney general",
    r"coroner", r"\bmedical examiner\b", r"district attorney",
    r"\bcourt\b", r"parliamentary records", r"mass casualty commission",
    r"serious incident response team", r"provincial police",
    r"\bcity of\b.*council", r"national park service",
]
MAJOR_NEWS_ORG_NAME_PATTERNS = [
    r"associated press", r"\breuters\b", r"\bbbc\b", r"canadian press",
    r"\bcnn\b", r"\bnpr\b", r"\bap news\b",
]

def classify_source(url_or_text):
    s = url_or_text.lower()
    if "wikipedia.org" in s:
        if re.search(r"list_of|list%20of", s):
            return "wiki_list"
        return "wiki_article"
    if any(re.search(p, s) for p in PRIMARY_DOMAIN_PATTERNS):
        return "primary_official"
    if any(re.search(p, s) for p in PRIMARY_ORG_NAME_PATTERNS):
        return "primary_official"
    if any(d in s for d in MAJOR_NEWS_DOMAINS):
        return "major_news"
    if any(re.search(p, s) for p in MAJOR_NEWS_ORG_NAME_PATTERNS):
        return "major_news"
    return "other"

def score_record(record):
    sources = record.get("sources", [])
    n = len(sources)
    if n == 0:
        return "MISSING", []
    kinds = [classify_source(s) for s in sources]
    if n >= 2:
        return "STRONG", kinds
    kind = kinds[0]
    if kind == "wiki_list":
        return "WEAK", kinds
    if kind in ("wiki_article", "primary_official", "major_news"):
        return "STRONG", kinds
    return "UNCLEAR", kinds

def score_database(records):
    tiers = defaultdict(list)
    for r in records:
        tier, kinds = score_record(r)
        tiers[tier].append((r, kinds))
    return tiers

def coverage_by_country(records):
    by_country = defaultdict(lambda: {"total": 0, "single_source": 0, "weak": 0})
    for r in records:
        c = r.get("country", "Unknown")
        by_country[c]["total"] += 1
        if len(r.get("sources", [])) == 1:
            by_country[c]["single_source"] += 1
        tier, _ = score_record(r)
        if tier == "WEAK":
            by_country[c]["weak"] += 1
    return dict(by_country)

if __name__ == "__main__":
    data = json.load(open("/home/claude/history.json"))
    tiers = score_database(data)
    print(f"Total records: {len(data)}")
    for tier in ["STRONG", "WEAK", "UNCLEAR", "MISSING"]:
        print(f"  {tier}: {len(tiers[tier])}")
    print()
    print("WEAK records (generic Wikipedia list-page citation only):")
    for r, kinds in tiers["WEAK"]:
        print(f"  id={r['id']} {r['title']} ({r.get('country')}, {r.get('year')}) -> {r['sources'][0]}")
    print()
    print("UNCLEAR records (single source, not recognized as primary/major/wiki):")
    for r, kinds in tiers["UNCLEAR"][:20]:
        print(f"  id={r['id']} {r['title']} -> {r['sources'][0]}")
