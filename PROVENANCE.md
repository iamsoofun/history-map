# NHIRA — Provenance & Authorship Record

**Author:** Shane Justin Hladinec
**Project:** NHIRA — National Historical Incident Research & Analysis
**Copyright:** © 2026 Shane Justin Hladinec. All rights reserved.
**License:** Proprietary — see `LICENSE`.

---

## Purpose of this record

This document establishes **who created NHIRA and when**, and ties that
authorship to tamper-evident content hashes. If the work is ever copied or
its authorship disputed, this record — together with the project's Git
commit history and the dated registry entries inside `script.js` — is the
contemporaneous evidence of original authorship.

Copyright exists automatically from the moment of creation; this file does
not create the right, it **documents** it and makes the provenance chain
explicit and checkable.

---

## What is claimed as original work

- The NHIRA website (`index.html`, `script.js`, `style.css`).
- The incident data compilation `history.json` (the selection,
  structuring, adjudication, and provenance annotation of records — the
  compilation, not the underlying public facts).
- The research registry embedded in `script.js`: SHF-1A, NHIRA-DQ-01,
  DQ-01-L, US-OBS-01, COUNT-01, IA-01, SEV-01, STATE-01 — including their
  frozen specifications, methodologies, and findings.
- The forecast risk-score model and its six-factor methodology.

---

## Integrity anchors (SHA-256)

These hashes let anyone verify that a given file is byte-for-byte the one
the Author published. Recompute with:

    # Windows PowerShell
    Get-FileHash <file> -Algorithm SHA256
    # macOS / Linux
    shasum -a 256 <file>

**Current published data — `history.json`**
- records: 1031
- bytes: 863710
- raw SHA-256:
  `7c202ec93e93965750d72aa5845021ebf37937ded447140f31d48ee1f34e34f2`

**Frozen research artifacts** each pin the hash of the exact dataset they
were computed against, inside their registry entries:

- **COUNT-01** — executed against the 998-record artifact
  (raw SHA-256 `dd5357a3e7dec18d785cda60104ef4339a43484ce7a82c50d10cffef3dfbffb7`).
- **STATE-01** — frozen 2026-08-24 against the 1031-record artifact
  (raw SHA-256 `e54be167bad4cbb2c5db14000e4e738463719c2c137e9bfad4bd1ad0ec38d64b`);
  freeze artifact `STATE-01-freeze.json`
  (SHA-256 `5f435036c5a4a2d9658b017b26d2ece866d0cf49e42007d579d350862e2cc9fa`).
- **IA-01** and **SEV-01** — computed against the 998-record artifact and
  independently re-verified against the 1031-record artifact; both carry
  `computedAgainstArtifact` and `replication` fields recording this.

Because each finding names the hash of the data beneath it, the entire
research record is a **dated, self-verifying chain**: any later alteration
of the data is detectable against these anchors.

---

## How to update this record

On each deployment that changes `history.json`, append the new hash and
date below, so the chain stays current. Do not overwrite prior entries —
the history is the evidence.

| Date       | records | bytes  | raw SHA-256 (history.json)                                          |
|------------|---------|--------|--------------------------------------------------------------------|
| 2026-08-24 | 1031    | 863710 | 7c202ec93e93965750d72aa5845021ebf37937ded447140f31d48ee1f34e34f2   |
