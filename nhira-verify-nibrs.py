#!/usr/bin/env python3
"""
NHIRA — FBI NIBRS / Crime Data Explorer VERIFICATION LAYER
==========================================================

This is a CROSS-CHECK tool, not an ingestion tool. It reads NOTHING into
history.json and creates no candidates. It compares NHIRA's own incident
counts against the FBI's aggregate firearm-offense statistics (from the
Crime Data Explorer API) to flag state/year cells where NHIRA's coverage
looks unusually sparse or dense relative to the authoritative baseline —
so your manual review time goes where it's actually needed instead of
being spread blindly across every cell.

  *** IT NEVER WRITES history.json. IT NEVER CREATES INCIDENT RECORDS. ***

WHY THIS AND NOT A NIBRS INGESTER
  NIBRS has no "active shooter" category — it is coded crime statistics
  (offense types + a firearm indicator), not a list of NHIRA-shaped
  incidents. Pulling incidents OUT of NIBRS would require defining
  active-shooter events from offense codes and adjudicating millions of
  ambiguous candidates by hand: that multiplies manual work, not reduces
  it, and reintroduces exactly the scope-mismatch problem NHIRA's registry
  is careful about. Aggregate cross-checking is the safe, useful direction:
  it automates a sanity-check without touching scope or the human confirm.

WHAT IT DOES
  1. Loads NHIRA history.json (READ-ONLY) and tallies incidents per
     state-year.
  2. Fetches FBI aggregate firearm-related offense counts per state-year
     from the Crime Data Explorer API (aggregates only — no incident-level
     data, no privacy-restricted detail).
  3. Computes, per state-year, the ratio of NHIRA incidents to the FBI
     firearm-offense baseline, and the same ratio's national median.
  4. Flags cells that deviate sharply from the national pattern — NHIRA
     looks unusually SPARSE (possible missing incidents to look for) or
     unusually DENSE (possible over-count / duplication to check).
  5. Writes a review report (JSON + printed summary). That's it.

WHAT THE FLAGS DO AND DO NOT MEAN
  A flag is a "worth a manual look" signal, NOT a claim that a record is
  missing or wrong. NIBRS firearm-offenses and NHIRA active-shooter
  incidents are DIFFERENT populations (NIBRS includes domestic, gang,
  robbery-related firearm crime that NHIRA's scope excludes). So the ratio
  is expected to be tiny and variable; the tool looks for RELATIVE outliers
  against the national median ratio, not for agreement in absolute numbers.
  It cannot tell you a cell is wrong — only that it's worth your eyes.

USAGE
    pip install requests
    # Crime Data Explorer API key (free) from https://api.data.gov/signup/
    python nhira-verify-nibrs.py --history history.json \
        --api-key YOUR_DATA_GOV_KEY --out verify-report.json \
        --from-year 2015 --to-year 2023

    # dry run without network (structure check only):
    python nhira-verify-nibrs.py --history history.json --out verify-report.json --offline
"""
import argparse, json, sys, statistics, datetime

CDE_BASE = "https://api.usa.gov/crime/fbi/cde"  # Crime Data Explorer
TODAY = datetime.date.today().isoformat()

# USPS state abbreviations — CDE uses these
STATE_ABBR = {
    "Alabama":"AL","Alaska":"AK","Arizona":"AZ","Arkansas":"AR","California":"CA",
    "Colorado":"CO","Connecticut":"CT","Delaware":"DE","District of Columbia":"DC",
    "Florida":"FL","Georgia":"GA","Hawaii":"HI","Idaho":"ID","Illinois":"IL",
    "Indiana":"IN","Iowa":"IA","Kansas":"KS","Kentucky":"KY","Louisiana":"LA",
    "Maine":"ME","Maryland":"MD","Massachusetts":"MA","Michigan":"MI","Minnesota":"MN",
    "Mississippi":"MS","Missouri":"MO","Montana":"MT","Nebraska":"NE","Nevada":"NV",
    "New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY",
    "North Carolina":"NC","North Dakota":"ND","Ohio":"OH","Oklahoma":"OK","Oregon":"OR",
    "Pennsylvania":"PA","Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD",
    "Tennessee":"TN","Texas":"TX","Utah":"UT","Vermont":"VT","Virginia":"VA",
    "Washington":"WA","West Virginia":"WV","Wisconsin":"WI","Wyoming":"WY",
}


def die(m): print(f"ERROR: {m}", file=sys.stderr); sys.exit(1)


def nhira_counts(path, y0, y1):
    H = json.load(open(path))
    cells = {}
    for r in H:
        if r.get("country") != "United States": continue
        st = r.get("state"); yr = r.get("year")
        if not st or not isinstance(yr, int): continue
        if st == "United States" or " and " in str(st): continue  # skip bad values
        if not (y0 <= yr <= y1): continue
        cells[(st, yr)] = cells.get((st, yr), 0) + 1
    return cells


def fetch_fbi_firearm(session, state_abbr, y0, y1, api_key):
    """Aggregate firearm-involved offense counts per year for a state.
    Uses the CDE 'weapons' summarized endpoint. Aggregates only."""
    # endpoint returns yearly counts of offenses by weapon category
    url = f"{CDE_BASE}/summarized/state/{state_abbr}/weapons"
    params = {"from": f"01-{y0}", "to": f"12-{y1}", "API_KEY": api_key}
    r = session.get(url, params=params, timeout=30)
    if r.status_code != 200:
        return None
    data = r.json()
    # sum firearm-category weapons per year (handgun, rifle, shotgun, firearm)
    out = {}
    fire = {"Handgun","Rifle","Shotgun","Firearm (type not stated)","Other Firearm"}
    for row in data.get("offenses", data.get("data", [])):
        yr = row.get("data_year") or row.get("year")
        wpn = row.get("weapon_name") or row.get("weapon")
        cnt = row.get("count") or row.get("value") or 0
        if yr and wpn in fire:
            out[int(yr)] = out.get(int(yr), 0) + int(cnt)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--api-key", default="")
    ap.add_argument("--from-year", type=int, default=2015)
    ap.add_argument("--to-year", type=int, default=2023)
    ap.add_argument("--offline", action="store_true",
                    help="skip network; report NHIRA-side structure only")
    ap.add_argument("--flag-factor", type=float, default=4.0,
                    help="flag cells whose NHIRA/FBI ratio is this many times "
                         "above or below the national median ratio")
    args = ap.parse_args()

    nh = nhira_counts(args.history, args.from_year, args.to_year)
    print(f"NHIRA state-year cells {args.from_year}-{args.to_year}: {len(nh)}")

    if args.offline:
        report = {"mode": "offline", "generated": TODAY,
                  "nhira_cells": len(nh),
                  "note": "offline structure check — no FBI comparison performed",
                  "nhira_counts": {f"{s} {y}": c for (s, y), c in sorted(nh.items())}}
        json.dump(report, open(args.out, "w"), indent=1)
        print(f"offline report written to {args.out} (no FBI data fetched)")
        return

    if not args.api_key:
        die("an API key is required unless --offline. Get a free key at "
            "https://api.data.gov/signup/ and pass --api-key.")

    try:
        import requests
    except ImportError:
        die("requests not installed. Run: pip install requests")
    session = requests.Session()
    session.headers["User-Agent"] = "NHIRA-verify/1.0 (research; nhira.org)"

    # fetch FBI baselines per state that appears in NHIRA
    states = sorted({s for (s, _) in nh})
    fbi = {}
    for st in states:
        ab = STATE_ABBR.get(st)
        if not ab:
            continue
        res = fetch_fbi_firearm(session, ab, args.from_year, args.to_year, args.api_key)
        if res:
            for yr, cnt in res.items():
                fbi[(st, yr)] = cnt
        import time; time.sleep(0.3)  # be polite to the API
    print(f"FBI firearm-offense baselines fetched for {len(set(k[0] for k in fbi))} states")

    # ratios where both sides exist
    ratios = []
    for cell, nc in nh.items():
        fc = fbi.get(cell)
        if fc and fc > 0:
            ratios.append(nc / fc)
    if not ratios:
        die("no overlapping state-year cells between NHIRA and FBI data — "
            "check the year range and API response.")
    med = statistics.median(ratios)

    flags = []
    for cell, nc in sorted(nh.items()):
        fc = fbi.get(cell)
        if not fc or fc <= 0:
            continue
        ratio = nc / fc
        rel = ratio / med if med > 0 else 0
        if rel >= args.flag_factor:
            flags.append({"state": cell[0], "year": cell[1], "nhira": nc,
                          "fbi_firearm_offenses": fc, "ratio_vs_median": round(rel, 2),
                          "flag": "NHIRA unusually DENSE vs baseline — check for duplication/over-count"})
        elif rel <= 1.0 / args.flag_factor:
            flags.append({"state": cell[0], "year": cell[1], "nhira": nc,
                          "fbi_firearm_offenses": fc, "ratio_vs_median": round(rel, 2),
                          "flag": "NHIRA unusually SPARSE vs baseline — possible missing incidents to look for"})

    report = {
        "mode": "cross-check",
        "generated": TODAY,
        "window": f"{args.from_year}-{args.to_year}",
        "national_median_ratio": round(med, 6),
        "cells_compared": len(ratios),
        "flag_factor": args.flag_factor,
        "flagged_cells": flags,
        "disclaimer": "Flags indicate cells worth a MANUAL look, not confirmed "
                      "errors. NIBRS firearm-offenses and NHIRA active-shooter "
                      "incidents are different populations; this compares each "
                      "cell against the NATIONAL median ratio, not absolute counts. "
                      "This tool wrote nothing to history.json.",
    }
    json.dump(report, open(args.out, "w"), indent=1)

    print(f"\ncompared {len(ratios)} state-year cells")
    print(f"national median NHIRA/FBI ratio: {med:.2e}")
    print(f"{len(flags)} cell(s) flagged for manual review:")
    for f in flags[:20]:
        print(f"   {f['state']} {f['year']}: NHIRA={f['nhira']} FBI={f['fbi_firearm_offenses']} "
              f"({f['ratio_vs_median']}x median) — {f['flag'].split(' — ')[0]}")
    if len(flags) > 20:
        print(f"   ... and {len(flags)-20} more (see {args.out})")
    print(f"\nfull report: {args.out}")
    print("This tool wrote ZERO changes to history.json.")


if __name__ == "__main__":
    main()
