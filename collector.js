/**
 * NHIRA Collector — Cloudflare Worker
 * =====================================================================
 * Implements the "automatic detection" half of the pipeline:
 *
 *   Source -> automatic detection -> candidate record ->
 *   Pending Verification -> human review -> history.json -> ...
 *
 * This Worker NEVER writes to history.json and NEVER sets
 * verificationStatus to VERIFIED. It only ever produces UNVERIFIED
 * candidates. A human approves in the Review panel; that is the only
 * path anything takes to become a published record. If you are
 * reading this file wondering "where does it auto-publish" — it
 * doesn't, on purpose.
 *
 * -------------------------------------------------------------------
 * SETUP (required before this does anything useful)
 * -------------------------------------------------------------------
 * 1. Create a KV namespace and bind it as PENDING_KV in wrangler.toml:
 *
 *      [[kv_namespaces]]
 *      binding = "PENDING_KV"
 *      id = "<your-kv-namespace-id>"
 *
 * 2. Add a cron trigger in wrangler.toml, e.g. every 6 hours:
 *
 *      [triggers]
 *      crons = ["0 star/6 star star star"]   (replace "star" with *)
 *
 * 3. Fill in APPROVED_SOURCES below with real feeds. This file ships
 *    with ZERO real sources configured — it will not fetch anything
 *    from an unapproved or unspecified source, by design. You decide
 *    what counts as an approved source; that's an editorial decision
 *    this code deliberately does not make for you.
 *
 * 4. Point your front end's pending.json fetch at this Worker's
 *    GET /pending.json endpoint instead of (or in addition to) a
 *    static file, OR run this on a schedule that writes a static
 *    pending.json into your deploy pipeline. Both are wired below;
 *    pick one.
 * =====================================================================
 */

// ---------------------------------------------------------------------
// Approved sources — EMPTY on purpose. Add only sources your editorial
// process has actually approved. Each entry needs a `parse` function
// because every source's format is different; a generic scraper that
// "figures out" incident data from arbitrary text is exactly the kind
// of black-box behavior NHIRA has deliberately avoided everywhere else.
// ---------------------------------------------------------------------

const APPROVED_SOURCES = [
    // Example shape — uncomment and adapt once you have a real,
    // approved, machine-readable feed (RSS/JSON API). Do not point
    // this at arbitrary news sites; unstructured HTML scraping is
    // fragile and produces low-confidence, hard-to-audit extractions.
    //
    // {
    //     name: "Example Approved Wire Service",
    //     feedUrl: "https://example-approved-source.org/feed.json",
    //     parse: parseExampleFeed
    // }
];

const MIN_REQUIRED_FIELDS = ["title", "incidentDate", "country", "fatalities"];

// ---------------------------------------------------------------------
// Confidence scoring
//
// Deliberately simple and auditable: confidence is the fraction of
// expected fields the parser actually extracted, with required fields
// weighted more heavily than optional ones. This is NOT a machine
// learning score — it's a completeness ratio, and that's disclosed
// wherever confidence is displayed.
// ---------------------------------------------------------------------

const REQUIRED_FIELDS = ["title", "incidentDate", "country", "fatalities"];
const OPTIONAL_FIELDS = ["state", "city", "venue", "lat", "lng", "injuries", "description", "category"];

function computeConfidence(extracted) {
    const requiredPresent = REQUIRED_FIELDS.filter(f => extracted[f] !== undefined && extracted[f] !== null && extracted[f] !== "").length;
    const optionalPresent = OPTIONAL_FIELDS.filter(f => extracted[f] !== undefined && extracted[f] !== null && extracted[f] !== "").length;

    if (requiredPresent < REQUIRED_FIELDS.length) {
        // Missing a required field caps confidence low regardless of
        // how much optional detail was found — an incident record
        // without a title, date, country, or fatality count isn't
        // usable no matter how well-described it is otherwise.
        return Math.min(0.35, (requiredPresent / REQUIRED_FIELDS.length) * 0.5);
    }

    const optionalRatio = optionalPresent / OPTIONAL_FIELDS.length;
    return Math.round((0.6 + optionalRatio * 0.4) * 100) / 100;
}

// ---------------------------------------------------------------------
// Duplicate detection
//
// Same normalized title+date matching used in clean_history.py, so
// the two tools agree on what counts as "probably the same incident."
// This is intentionally conservative: it flags candidates for human
// review, it never auto-rejects as a duplicate.
// ---------------------------------------------------------------------

function normalizeTitleDateKey(title, date) {
    const normTitle = String(title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return `${normTitle}|${date || ""}`;
}

async function checkDuplicate(extracted, existingHistory, existingPending) {
    const key = normalizeTitleDateKey(extracted.title, extracted.incidentDate);

    const historyMatch = existingHistory.find(
        h => normalizeTitleDateKey(h.title, h.date) === key
    );
    if (historyMatch) {
        return {
            status: "possible-match",
            matchedId: historyMatch.id ?? null,
            note: `Title and date closely match existing NHIRA record${historyMatch.id ? ` #${historyMatch.id}` : ""}.`
        };
    }

    const pendingMatch = existingPending.find(
        p => normalizeTitleDateKey(p.title, p.incidentDate) === key
    );
    if (pendingMatch) {
        return {
            status: "possible-match",
            matchedId: null,
            note: `Matches an existing pending candidate (${pendingMatch.candidateId}) already awaiting review.`
        };
    }

    return { status: "no-match", matchedId: null, note: "No existing NHIRA record or pending candidate with matching title+date." };
}

// ---------------------------------------------------------------------
// Criteria flagging — NOT classification.
//
// This flags a candidate against simple, disclosed thresholds so a
// reviewer knows why it surfaced. It never decides "this is a mass
// shooting" — that determination, and the category assigned, is made
// by the human reviewer. flaggedCriteria is advisory text only.
// ---------------------------------------------------------------------

function flagCriteria(extracted) {
    const flags = [];
    const fatalities = Number(extracted.fatalities) || 0;
    const injuries = Number(extracted.injuries) || 0;

    if (fatalities >= 4) flags.push(`${fatalities}+ victims killed`);
    if (fatalities + injuries >= 4) flags.push(`${fatalities + injuries}+ total casualties`);
    if (!extracted.lat || !extracted.lng) flags.push("No coordinates extracted — will need manual geocoding before publish");
    if (!extracted.category) flags.push("No category extracted — reviewer must classify");

    return flags;
}

// ---------------------------------------------------------------------
// Candidate assembly — produces exactly the schema the Review panel
// (script.js) expects. Keep this in sync with pendingCandidates
// handling in script.js if either side's schema changes.
// ---------------------------------------------------------------------

function buildCandidate({ source, sourceUrl, extracted, duplicateMatch, idSeed }) {
    const now = new Date();
    const expiresInDays = 30;
    const expiration = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000);

    return {
        candidateId: `cand-${now.getUTCFullYear()}-${idSeed}`,

        source: source,
        sourceUrl: sourceUrl,
        detectedDate: now.toISOString(),
        incidentDate: extracted.incidentDate || null,
        country: extracted.country || null,
        state: extracted.state || null,
        city: extracted.city || null,
        title: extracted.title || null,
        category: extracted.category || null,
        fatalities: extracted.fatalities ?? null,
        injuries: extracted.injuries ?? null,
        confidence: computeConfidence(extracted),
        duplicateMatch,
        verificationStatus: "UNVERIFIED", // ALWAYS. This Worker never sets any other value.
        reviewedBy: null,
        reviewedDate: null,

        venue: extracted.venue || null,
        lat: extracted.lat ?? null,
        lng: extracted.lng ?? null,
        description: extracted.description || null,
        locationPrecision: extracted.lat && extracted.lng
            ? (extracted.locationPrecisionHint || "approximate")
            : "unknown",
        expirationTime: expiration.toISOString(),
        flaggedCriteria: flagCriteria(extracted)
    };
}

// ---------------------------------------------------------------------
// Example parser — TEMPLATE ONLY, not wired to a real source.
// Shows the shape a real parser needs to return. Replace entirely for
// each real approved source; formats vary too much to generalize.
// ---------------------------------------------------------------------

async function parseExampleFeed(feedUrl) {
    const response = await fetch(feedUrl, {
        headers: { "User-Agent": "NHIRA-Collector/1.0 (+https://nhira.org)" }
    });
    if (!response.ok) {
        throw new Error(`Fetch failed for ${feedUrl}: ${response.status}`);
    }
    const items = await response.json(); // shape depends entirely on the real source

    // Map each raw item to the extracted-field shape computeConfidence/
    // buildCandidate expect. This is illustrative — real extraction
    // logic belongs here once you have a real source to adapt to.
    return items.map(item => ({
        extracted: {
            title: item.headline || null,
            incidentDate: item.date || null,
            country: item.country || null,
            state: item.region || null,
            city: item.city || null,
            venue: item.venue || null,
            lat: item.lat ?? null,
            lng: item.lng ?? null,
            fatalities: item.killed ?? null,
            injuries: item.wounded ?? null,
            description: item.summary || null,
            category: item.category || null
        },
        sourceUrl: item.url || feedUrl
    }));
}

// ---------------------------------------------------------------------
// Main collection run
// ---------------------------------------------------------------------

async function runCollection(env) {
    if (APPROVED_SOURCES.length === 0) {
        console.log("NHIRA collector: no approved sources configured — nothing to do. Add sources to APPROVED_SOURCES to begin collecting.");
        return { newCandidates: 0, sourcesChecked: 0 };
    }

    // history.json is the dedup reference — fetch the LIVE deployed
    // copy, not a bundled snapshot, so duplicate-checking always runs
    // against the current published dataset.
    const historyResp = await fetch("https://nhira.org/history.json");
    const existingHistory = historyResp.ok ? await historyResp.json() : [];

    const existingPendingRaw = await env.PENDING_KV.get("pending", "json");
    const existingPending = Array.isArray(existingPendingRaw) ? existingPendingRaw : [];

    const newCandidates = [];
    let idCounter = existingPending.length + 1;

    for (const source of APPROVED_SOURCES) {
        try {
            const items = await source.parse(source.feedUrl);

            for (const { extracted, sourceUrl } of items) {
                const hasRequired = MIN_REQUIRED_FIELDS.every(
                    f => extracted[f] !== undefined && extracted[f] !== null && extracted[f] !== ""
                );
                if (!hasRequired) continue; // don't create unusable candidates

                const duplicateMatch = await checkDuplicate(extracted, existingHistory, [...existingPending, ...newCandidates]);

                const candidate = buildCandidate({
                    source: source.name,
                    sourceUrl,
                    extracted,
                    duplicateMatch,
                    idSeed: String(idCounter).padStart(4, "0")
                });
                idCounter++;
                newCandidates.push(candidate);
            }
        } catch (err) {
            // One source failing must not take down the whole run.
            console.error(`NHIRA collector: source "${source.name}" failed:`, err.message);
        }
    }

    if (newCandidates.length > 0) {
        const merged = [...existingPending, ...newCandidates];
        await env.PENDING_KV.put("pending", JSON.stringify(merged));
    }

    return { newCandidates: newCandidates.length, sourcesChecked: APPROVED_SOURCES.length };
}

// ---------------------------------------------------------------------
// Worker entry points
// ---------------------------------------------------------------------

export default {
    // Runs on the cron schedule set in wrangler.toml.
    async scheduled(event, env, ctx) {
        ctx.waitUntil(
            runCollection(env).then(result => {
                console.log("NHIRA collector run complete:", result);
            })
        );
    },

    // Serves the current queue as JSON so the front end's
    // fetch("pending.json") can point here directly instead of a
    // static file, if you'd rather not rebuild/redeploy the static
    // site every time the collector finds something new.
    //
    //   GET /pending.json  -> current queue from KV
    //   POST /run          -> trigger a collection run manually (for
    //                          testing outside the cron schedule)
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === "/pending.json") {
            const data = await env.PENDING_KV.get("pending", "json");
            return new Response(JSON.stringify(data || []), {
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"
                }
            });
        }

        if (url.pathname === "/run" && request.method === "POST") {
            const result = await runCollection(env);
            return new Response(JSON.stringify(result), {
                headers: { "Content-Type": "application/json" }
            });
        }

        return new Response("NHIRA collector Worker. See /pending.json or POST /run.", { status: 200 });
    }
};