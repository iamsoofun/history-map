#!/usr/bin/env python3
"""
NHIRA — Assisted Ingestion: FBI Active Shooter Reports
======================================================

Version A ("assisted") ingestion. You run this on demand. It fetches the
current FBI Active Shooter Incidents report, extracts incident candidates,
formats them to NHIRA schema, and writes them to a CANDIDATE queue file.

  *** IT NEVER TOUCHES history.json. ***

Candidates land in a separate file for human review. Nothing enters the
live dataset until you read each candidate, confirm it, and merge it
yourself. That human gate is the whole point — automated parsing (especially
of a PDF) makes mistakes, and NHIRA's credibility depends on every live
record having been confirmed by a person.

--------------------------------------------------------------------------
USAGE
    pip install requests pdfplumber
    python nhira-ingest-fbi.py --history history.json --out candidates.json

    # to point at a specific report PDF instead of auto-discovering:
    python nhira-ingest-fbi.py --history history.json --out candidates.json \
        --pdf-url https://www.fbi.gov/.../active-shooter-...-2025.pdf

WHAT IT DOES
  1. Finds the latest FBI active-shooter report PDF (or uses --pdf-url).
  2. Downloads and extracts text.
  3. Parses the "incident summaries" section into structured candidates.
  4. Assigns NHIRA schema fields, reusing existing history.json city
     coordinates where the city already appears (known provenance),
     leaving lat/lng null otherwise (flagged for geocoding).
  5. Skips any incident whose (year, city, fatalities, injuries) already
     appears in history.json — no duplicates into the queue.
  6. Writes remaining candidates to the --out file with review metadata.

WHAT IT DELIBERATELY DOES NOT DO
  - It does not write history.json.
  - It does not invent coordinates.
  - It does not decide an incident is in scope — it extracts what the FBI
    report lists (already NHIRA's inclusion criterion) and leaves the
    confirm/reject decision to you.
--------------------------------------------------------------------------
"""
import argparse, json, re, sys, datetime, hashlib

FBI_LANDING = "https://www.fbi.gov/how-we-can-help-you/active-shooter-safety-resources/active-shooter-incidents-in-the-united-states-by-year"
SRC_TAG = "fbi_active_shooter_report"
TODAY = datetime.date.today().isoformat()

# US state names -> for pulling the state out of "City, State" headers
STATES = {s.lower(): s for s in [
    "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut",
    "Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa",
    "Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan",
    "Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire",
    "New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio",
    "Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota",
    "Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia",
    "Wisconsin","Wyoming","District of Columbia"]}

FBI_CAT_MAP = {
    "commerce": "Commerce Shooting",
    "open space": "Open Space Shooting",
    "government": "Government Facility Shooting",
    "education": "School Shooting",
    "house of worship": "House of Worship Shooting",
    "health care": "Healthcare Facility Shooting",
    "residence": "Residential Shooting",
}


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def discover_pdf_url(session):
    """Find the newest active-shooter report PDF linked from the FBI landing page."""
    try:
        r = session.get(FBI_LANDING, timeout=30)
        r.raise_for_status()
    except Exception as e:
        die(f"could not load FBI landing page ({e}). Pass --pdf-url explicitly.")
    # links to a report PDF, e.g. .../active-shooter-incidents-in-the-us-2025.pdf
    links = re.findall(r'href="([^"]+\.pdf)"', r.text, flags=re.I)
    cand = [l for l in links if "active-shooter" in l.lower()]
    if not cand:
        die("no active-shooter PDF link found on the landing page. Pass --pdf-url.")
    # prefer the one with the newest 4-digit year in the filename
    def year_of(u):
        m = re.findall(r"(20\d\d)", u)
        return max(int(y) for y in m) if m else 0
    best = sorted(cand, key=year_of, reverse=True)[0]
    if best.startswith("/"):
        best = "https://www.fbi.gov" + best
    return best


def extract_text(session, pdf_url):
    try:
        import pdfplumber
    except ImportError:
        die("pdfplumber not installed. Run: pip install pdfplumber")
    try:
        r = session.get(pdf_url, timeout=60)
        r.raise_for_status()
    except Exception as e:
        die(f"could not download PDF ({e})")
    import io
    text_pages = []
    with pdfplumber.open(io.BytesIO(r.content)) as pdf:
        for page in pdf.pages:
            text_pages.append(page.extract_text() or "")
    return "\n".join(text_pages), hashlib.sha256(r.content).hexdigest()


# Incident summary headers look like:  "1 | ANTIOCH HIGH SCHOOL | Antioch, Tennessee"
HEADER_RE = re.compile(
    r'^\s*(\d{1,3})\s*\|\s*(.+?)\s*\|\s*([A-Za-z .\'\-]+),\s*([A-Za-z .\'\-]+?)\*?\s*$',
    re.M)
KILLED_RE = re.compile(r'killing (\w+)|(\w+) (?:were |was )?killed|(\w+) dead', re.I)
WOUND_RE = re.compile(r'wounding (\w+)|injuring (\w+)|(\w+) (?:were |was )?(?:wounded|injured)', re.I)
WORDNUM = {"no":0,"zero":0,"one":1,"two":2,"three":3,"four":4,"five":5,"six":6,
           "seven":7,"eight":8,"nine":9,"ten":10,"eleven":11,"twelve":12}


def wordnum(tok):
    if tok is None:
        return None
    tok = tok.lower()
    if tok.isdigit():
        return int(tok)
    return WORDNUM.get(tok)


def parse_incidents(text):
    """Parse incident summary blocks into rough candidate dicts.
    This is best-effort text extraction; the human review step is where
    errors get caught."""
    incidents = []
    matches = list(HEADER_RE.finditer(text))
    for i, m in enumerate(matches):
        num, venue, city, state = m.groups()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = " ".join(text[start:end].split())
        # date like "January 22, 2025"
        dm = re.search(r'(January|February|March|April|May|June|July|August|'
                       r'September|October|November|December)\s+(\d{1,2}),\s+(\d{4})', body)
        date_iso = None
        if dm:
            month = ["january","february","march","april","may","june","july","august",
                     "september","october","november","december"].index(dm.group(1).lower()) + 1
            date_iso = f"{int(dm.group(3)):04d}-{month:02d}-{int(dm.group(2)):02d}"
        # casualties (best-effort; review will correct)
        km = KILLED_RE.search(body)
        killed = next((wordnum(g) for g in (km.groups() if km else []) if wordnum(g) is not None), 0)
        wm = WOUND_RE.search(body)
        wounded = next((wordnum(g) for g in (wm.groups() if wm else []) if wordnum(g) is not None), 0)
        st = STATES.get(state.strip().lower(), state.strip())
        incidents.append({
            "fbi_number": int(num),
            "venue": venue.strip().title() if venue.isupper() else venue.strip(),
            "city": city.strip(),
            "state": st,
            "date": date_iso,
            "fatalities": killed or 0,
            "injuries": wounded or 0,
            "raw_summary": body[:600],
        })
    return incidents


def to_nhira(cand, existing_city_coords, next_id):
    """Map a parsed candidate to NHIRA schema. Coordinates reused only when
    the city already exists in history.json (known provenance); else null."""
    key = (cand["city"].lower(), cand["state"].lower())
    coord = existing_city_coords.get(key)
    nid = next_id
    return {
        "title": f"{cand['venue']} Shooting",
        "date": cand["date"],
        "city": cand["city"],
        "fatalities": cand["fatalities"],
        "injuries": cand["injuries"],
        "description": cand["raw_summary"],
        "sources": [SRC_TAG],
        "id": nid,
        "year": int(cand["date"][:4]) if cand["date"] else None,
        "country": "United States",
        "state": cand["state"],
        "lat": coord[0] if coord else None,
        "lng": coord[1] if coord else None,
        "venue": cand["venue"],
        "category": None,               # left for human classification on review
        "incident_scope": "single_site",
        "incident_id": f"NHIRA-INC-{nid:05d}",
        "location_precision": "city_centroid" if coord else "unknown",
        "location_method": (f"reused_from_nhira_record_{coord[2]}_same_city"
                            if coord else "unresolved_pending_geocode"),
        "location_review_status": "not_reviewed",
        # review metadata — not part of the final record, stripped on merge
        "_candidate": {
            "source": "FBI Active Shooter report",
            "fbi_number": cand["fbi_number"],
            "ingested": TODAY,
            "status": "UNVERIFIED",
            "needs": ([] if cand["date"] else ["date"])
                     + ([] if coord else ["coordinates"])
                     + ["category", "casualty-check"],
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", required=True, help="path to history.json (read-only)")
    ap.add_argument("--out", required=True, help="candidate queue output file")
    ap.add_argument("--pdf-url", help="specific report PDF URL (skips auto-discovery)")
    args = ap.parse_args()

    try:
        import requests
    except ImportError:
        die("requests not installed. Run: pip install requests")

    H = json.load(open(args.history))
    max_id = max(r["id"] for r in H)

    # existing city -> coordinate index (for known-provenance reuse)
    city_coords = {}
    for r in H:
        if r.get("country") == "United States" and r.get("lat") is not None:
            k = (str(r.get("city", "")).lower(), str(r.get("state", "")).lower())
            city_coords.setdefault(k, (r["lat"], r["lng"], r["id"]))

    # existing dedup key set
    seen = {(r.get("year"), str(r.get("city", "")).lower(),
             r.get("fatalities"), r.get("injuries"))
            for r in H if r.get("country") == "United States"}

    session = requests.Session()
    session.headers["User-Agent"] = "NHIRA-ingest/1.0 (research; nhira.org)"

    pdf_url = args.pdf_url or discover_pdf_url(session)
    print(f"report PDF: {pdf_url}")
    text, pdf_hash = extract_text(session, pdf_url)
    print(f"downloaded, sha256={pdf_hash[:16]}...  extracted {len(text):,} chars")

    parsed = parse_incidents(text)
    print(f"parsed {len(parsed)} incident summaries")

    candidates, skipped = [], 0
    nid = max_id
    for c in parsed:
        yr = int(c["date"][:4]) if c["date"] else None
        key = (yr, c["city"].lower(), c["fatalities"], c["injuries"])
        if key in seen:
            skipped += 1
            continue
        nid += 1
        candidates.append(to_nhira(c, city_coords, nid))

    out = {
        "source": "FBI Active Shooter report",
        "source_pdf": pdf_url,
        "source_pdf_sha256": pdf_hash,
        "ingested": TODAY,
        "history_reviewed_against": args.history,
        "candidate_count": len(candidates),
        "skipped_already_present": skipped,
        "candidates": candidates,
    }
    json.dump(out, open(args.out, "w"), indent=1)

    print(f"\n{len(candidates)} candidate(s) written to {args.out}")
    print(f"{skipped} skipped (already in history.json)")
    print("\nNEXT STEPS (human review — nothing is live yet):")
    print("  1. Open the candidate file and read each _candidate.needs list.")
    print("  2. Fix dates/casualties the parser got wrong (check raw_summary).")
    print("  3. Assign each 'category' and geocode any null coordinates.")
    print("  4. Move confirmed records into the Pending Verification panel,")
    print("     or merge into history.json only after you've confirmed them.")
    print("  5. Strip the _candidate block on merge.")
    print("\nThis tool wrote ZERO changes to history.json.")


if __name__ == "__main__":
    main()
