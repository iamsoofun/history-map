#!/usr/bin/env python3
"""NHIRA DQ-01-L v1.1 §5 — geocoder fingerprint query runner.

Populates fingerprint-test-fixture.json with real provider results.
Does NOT score. Does NOT alter the denominator, candidate set, or thresholds.

USAGE
    # 1. Check each provider's terms FIRST and record the decision:
    python3 run-fingerprint-queries.py --check-terms

    # 2. Run a candidate (Nominatim needs no key):
    python3 run-fingerprint-queries.py --candidate "OpenStreetMap / Nominatim" \
        --eligibility-identification PERMITTED \
        --eligibility-reference-artifact PERMITTED \
        --terms-checked 2026-08-22

    # Google / Bing need a key:
    python3 run-fingerprint-queries.py --candidate "Google Geocoding" --api-key KEY ...

Run each candidate separately. Results accumulate in the fixture.
"""
import argparse, json, sys, time, datetime
from urllib.request import urlopen, Request
from urllib.parse import quote, urlencode

FIXTURE = "fingerprint-test-fixture.json"
UA = "NHIRA-DQ-01-L/1.1 (research; contact: set-your-email-here)"

TERMS_URLS = {
    "Google Geocoding":          "https://developers.google.com/maps/documentation/geocoding/policies",
    "Bing Maps / Microsoft":     "https://www.microsoft.com/en-us/maps/product/terms",
    "OpenStreetMap / Nominatim": "https://operations.osmfoundation.org/policies/nominatim/",
    "GeoNames P":                "https://www.geonames.org/export/",
    "GeoNames A":                "https://www.geonames.org/export/",
    "Wikidata / Wikipedia":      "https://www.wikidata.org/wiki/Wikidata:Licensing",
}


def q_nominatim(qs, key=None):
    url = "https://nominatim.openstreetmap.org/search?" + urlencode(
        {"q": qs, "format": "json", "limit": 1})
    with urlopen(Request(url, headers={"User-Agent": UA}), timeout=30) as r:
        d = json.load(r)
    return (float(d[0]["lat"]), float(d[0]["lon"])) if d else None


def q_google(qs, key):
    url = "https://maps.googleapis.com/maps/api/geocode/json?" + urlencode(
        {"address": qs, "key": key})
    with urlopen(Request(url, headers={"User-Agent": UA}), timeout=30) as r:
        d = json.load(r)
    if d.get("status") != "OK" or not d.get("results"):
        return None
    loc = d["results"][0]["geometry"]["location"]
    return (loc["lat"], loc["lng"])


def q_bing(qs, key):
    url = ("https://dev.virtualearth.net/REST/v1/Locations?" +
           urlencode({"query": qs, "key": key, "maxResults": 1}))
    with urlopen(Request(url, headers={"User-Agent": UA}), timeout=30) as r:
        d = json.load(r)
    try:
        pt = d["resourceSets"][0]["resources"][0]["point"]["coordinates"]
        return (pt[0], pt[1])
    except (KeyError, IndexError):
        return None


def q_geonames(qs, key, feature_class):
    # key = your GeoNames username
    url = "http://api.geonames.org/searchJSON?" + urlencode(
        {"q": qs, "maxRows": 1, "username": key, "featureClass": feature_class})
    with urlopen(Request(url, headers={"User-Agent": UA}), timeout=30) as r:
        d = json.load(r)
    g = d.get("geonames") or []
    return (float(g[0]["lat"]), float(g[0]["lng"])) if g else None


PROVIDERS = {
    "Google Geocoding":          (q_google, 0.1),
    "Bing Maps / Microsoft":     (q_bing, 0.1),
    "OpenStreetMap / Nominatim": (q_nominatim, 1.1),   # policy: max 1 req/sec
    "GeoNames P":                (lambda qs, k: q_geonames(qs, k, "P"), 1.1),
    "GeoNames A":                (lambda qs, k: q_geonames(qs, k, "A"), 1.1),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate")
    ap.add_argument("--api-key", default=None)
    ap.add_argument("--eligibility-identification")
    ap.add_argument("--eligibility-reference-artifact")
    ap.add_argument("--terms-checked")
    ap.add_argument("--source-version", default=None)
    ap.add_argument("--check-terms", action="store_true")
    ap.add_argument("--fixture", default=FIXTURE)
    a = ap.parse_args()

    if a.check_terms:
        print("Read each before querying. Record the decision per USE:\n")
        for n, u in TERMS_URLS.items():
            print(f"  {n:28s} {u}")
        print("\nIdentification use:      70 transient queries, only residual STATISTICS retained.")
        print("Reference-artifact use:  537 coordinates retained permanently in a stored file.")
        print("\nA provider may permit the first and prohibit the second. Record both separately.")
        return

    fx = json.load(open(a.fixture, encoding="utf-8"))
    if len(fx["groups"]) != fx["frozen_denominator"]:
        sys.exit("ABORT: fixture group count does not match the frozen denominator.")

    reg = {c["name"]: c for c in fx["candidates"]}
    if a.candidate not in reg:
        sys.exit(f"ABORT: '{a.candidate}' is not in the frozen candidate registry.\n"
                 f"Registry: {list(reg)}\n"
                 "Adding a candidate post-hoc requires post_hoc_candidate=true and separate reporting.")

    for field, val in (("eligibility_identification", a.eligibility_identification),
                       ("eligibility_reference_artifact", a.eligibility_reference_artifact),
                       ("candidate_terms_checked_date", a.terms_checked)):
        if not val:
            sys.exit(f"ABORT: --{field.replace('_','-')} is required. "
                     "Terms must be checked BEFORE querying, not reconstructed after.")

    if a.eligibility_identification.startswith("DECLINED"):
        reg[a.candidate].update(eligibility_identification=a.eligibility_identification,
                                eligibility_reference_artifact=a.eligibility_reference_artifact,
                                candidate_terms_checked_date=a.terms_checked)
        json.dump(fx, open(a.fixture, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
        print(f"{a.candidate}: DECLINED for identification use. Recorded, not queried.")
        return

    if a.candidate not in PROVIDERS:
        sys.exit(f"No query function for '{a.candidate}' — populate its results manually.")

    fn, delay = PROVIDERS[a.candidate]
    today = datetime.date.today().isoformat()
    found = notfound = 0

    for i, g in enumerate(fx["groups"], 1):
        try:
            res = fn(g["query_string"], a.api_key)
        except Exception as e:
            print(f"  [{i:2d}/70] ERROR {g['query_string']}: {e}")
            res = None
        g["candidate_results"][a.candidate] = (
            {"lat": res[0], "lng": res[1]} if res else None)
        if res:
            found += 1
        else:
            notfound += 1
            print(f"  [{i:2d}/70] NOT FOUND: {g['query_string']}")
        time.sleep(delay)

    reg[a.candidate].update(
        eligibility_identification=a.eligibility_identification,
        eligibility_reference_artifact=a.eligibility_reference_artifact,
        candidate_terms_checked_date=a.terms_checked,
        candidate_query_date=today,
        candidate_source_version=a.source_version)

    json.dump(fx, open(a.fixture, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print(f"\n{a.candidate}: {found} found, {notfound} not found, out of "
          f"{fx['frozen_denominator']} groups. Fixture updated.")
    print("not_found groups count AGAINST the candidate at scoring time.")


if __name__ == "__main__":
    main()
