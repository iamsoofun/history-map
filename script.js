// =====================================================================
// NHIRA — script.js
// Loads incidents from history.json, draws clustered typed markers,
// drives the timeline, and fills the detail, statistics, and forecast
// panels.
// =====================================================================

// ---------------------------------------------------------------------
// Dependency guard
//
// If a CDN library fails to load, every later line that touches L.*
// throws and the whole app dies silently — the symptom is a blank
// map area with no zoom control and no attribution. Rather than fail
// invisibly, say so on the page.
// ---------------------------------------------------------------------

(function checkDependencies() {
    const missing = [];
    if (typeof L === "undefined") missing.push("Leaflet (map library)");
    else if (typeof L.markerClusterGroup !== "function") missing.push("Leaflet.markercluster (clustering plugin)");
    if (typeof Chart === "undefined") missing.push("Chart.js (charts — panels will still work, charts will not)");

    if (!missing.length) return;

    console.error("NHIRA: required libraries failed to load:", missing);

    const mapEl = document.getElementById("map");
    if (mapEl) {
        mapEl.innerHTML = `
            <div style="padding:24px;font:500 .9rem/1.6 system-ui,sans-serif;color:#8C2A24;
                        background:#F8E4E3;border:1px solid #EFC0BC;border-radius:8px;margin:16px;">
                <strong>Map libraries failed to load.</strong><br>
                Missing: ${missing.join(", ")}.<br><br>
                This is a network/CDN problem, not a data problem — NHIRA's records are fine.
                Check your connection, or whether a firewall/extension is blocking the CDN, then reload.
            </div>
        `;
    }
})();

// ---------------------------------------------------------------------
// Type registry
// ---------------------------------------------------------------------

const INCIDENT_TYPES = {
    shooting: { label: "Shooting", color: "#B3322B" },
    explosion: { label: "Explosion / bombing", color: "#D97A17" },
    fire: { label: "Fire", color: "#E0521C" },
    structural: { label: "Structural collapse", color: "#8A6A3D" },
    transport: { label: "Transportation", color: "#256B9A" },
    weather: { label: "Severe weather", color: "#2E7D5B" },
    civil: { label: "Civil unrest", color: "#7A3E9D" },
    other: { label: "Other incident", color: "#4A5560" }
};

const HOTZONE_THRESHOLD = 25;
const HOTZONE_COLOR = "#7A3E9D";

// Shared vocabulary for location_precision, used by both published
// incident records (exact | approximate | city_centroid |
// multi_location) and pending candidates (which also allow the
// legacy "city" key). One label map so the two contexts stay
// consistent instead of drifting into different wording.
const PRECISION_LABELS = {
    exact: "Exact coordinates",
    approximate: "Approximate",
    city_centroid: "City centroid (representative point)",
    multi_location: "Multi-location incident (representative point)",
    city: "City-level", // legacy pending-candidate key
    unknown: "Unknown"
};

const REGION_MAP = {
    "United States": "North America", "Canada": "North America", "Mexico": "North America",
    "Brazil": "South America", "Argentina": "South America", "Chile": "South America",
    "Colombia": "South America", "Peru": "South America", "Venezuela": "South America",
    "Ecuador": "South America", "Bolivia": "South America", "Uruguay": "South America",
    "United Kingdom": "Europe", "France": "Europe", "Germany": "Europe", "Italy": "Europe",
    "Spain": "Europe", "Portugal": "Europe", "Netherlands": "Europe", "Belgium": "Europe",
    "Switzerland": "Europe", "Austria": "Europe", "Sweden": "Europe", "Norway": "Europe",
    "Denmark": "Europe", "Finland": "Europe", "Poland": "Europe", "Russia": "Europe",
    "Ukraine": "Europe", "Greece": "Europe", "Ireland": "Europe", "Hungary": "Europe",
    "Romania": "Europe", "Czech Republic": "Europe", "Serbia": "Europe", "Croatia": "Europe",
    "Bosnia and Herzegovina": "Europe", "Bulgaria": "Europe", "Slovakia": "Europe",
    "China": "Asia", "Japan": "Asia", "India": "Asia", "Pakistan": "Asia",
    "Bangladesh": "Asia", "Indonesia": "Asia", "Philippines": "Asia", "Vietnam": "Asia",
    "Thailand": "Asia", "South Korea": "Asia", "North Korea": "Asia", "Myanmar": "Asia",
    "Sri Lanka": "Asia", "Malaysia": "Asia", "Afghanistan": "Asia", "Nepal": "Asia",
    "Israel": "Middle East", "Egypt": "Middle East", "Syria": "Middle East",
    "Iraq": "Middle East", "Iran": "Middle East", "Saudi Arabia": "Middle East",
    "Turkey": "Middle East", "Yemen": "Middle East", "Lebanon": "Middle East",
    "Jordan": "Middle East", "United Arab Emirates": "Middle East", "Kuwait": "Middle East",
    "Nigeria": "Africa", "South Africa": "Africa", "Kenya": "Africa", "Somalia": "Africa",
    "Sudan": "Africa", "Ethiopia": "Africa", "Rwanda": "Africa", "Mali": "Africa",
    "Congo": "Africa", "Democratic Republic of the Congo": "Africa", "Libya": "Africa",
    "Algeria": "Africa", "Tunisia": "Africa", "Uganda": "Africa", "Ghana": "Africa",
    "Australia": "Oceania", "New Zealand": "Oceania", "Papua New Guinea": "Oceania"
};

function getRegion(country) {
    return REGION_MAP[country] || "Other";
}

// ---------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------

const map = L.map("map", { zoomControl: false }).setView([20, 0], 2);

L.control.zoom({ position: "bottomright" }).addTo(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

const hotZoneLayer = L.layerGroup().addTo(map);

const markerLayer = L.markerClusterGroup({
    maxClusterRadius: 50,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    iconCreateFunction: cluster => {
        const count = cluster.getChildCount();
        const tier = count >= 100 ? "lg" : count >= 25 ? "md" : "sm";
        return L.divIcon({
            html: `<div class="cluster-inner">${count.toLocaleString()}</div>`,
            className: `nhira-cluster nhira-cluster-${tier}`,
            iconSize: null
        });
    }
}).addTo(map);

// Forecast risk overlay — off by default, only shown in Forecast map
// mode. Not added to the map until the mode is switched.
const forecastLayer = L.layerGroup();

// Context highlight layer — only shown in Context map mode, and only
// once an incident is open. Draws rings around events that appeared
// in that incident's Research Context (nearby, same date, same year,
// surrounding period, subsequent).
const contextLayer = L.layerGroup();

// ---------------------------------------------------------------------
// Element references
// ---------------------------------------------------------------------

const slider = document.getElementById("timeline");
const yearDisplay = document.getElementById("yearDisplay");
const eraTag = document.getElementById("eraTag");
const search = document.getElementById("search");
const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const nowBtn = document.getElementById("nowBtn");
const sidePanel = document.getElementById("sidePanel");
const panelContent = document.getElementById("panelContent");
const closePanel = document.getElementById("closePanel");
const scrim = document.getElementById("scrim");
const legend = document.getElementById("legend");
const legendToggle = document.getElementById("legendToggle");
const legendList = document.getElementById("legendList");

const startYearInput = document.getElementById("startYear");
const endYearInput = document.getElementById("endYear");
const rangeSearchBtn = document.getElementById("rangeSearchBtn");
const clearRangeBtn = document.getElementById("clearRangeBtn");
const rangeResults = document.getElementById("rangeResults");

const statsToggle = document.getElementById("statsToggle");
const statsPanel = document.getElementById("statsPanel");
const closeStats = document.getElementById("closeStats");
const rsStartYear = document.getElementById("rsStartYear");
const rsEndYear = document.getElementById("rsEndYear");
const rsCountry = document.getElementById("rsCountry");
const rsCategory = document.getElementById("rsCategory");
const rsRegion = document.getElementById("rsRegion");
const rsMinFatalities = document.getElementById("rsMinFatalities");
const rsGenerateBtn = document.getElementById("rsGenerateBtn");
const rsClearBtn = document.getElementById("rsClearBtn");
const rsSummary = document.getElementById("rsSummary");
const methodologyToggle = document.getElementById("methodologyToggle");
const methodologyBody = document.getElementById("methodologyBody");
const rsBreakdown = document.getElementById("rsBreakdown");
const rsResultsList = document.getElementById("rsResultsList");
const rsTopFatalities = document.getElementById("rsTopFatalities");
const rsTopCountries = document.getElementById("rsTopCountries");
const rsConcentration = document.getElementById("rsConcentration");
const forecastOverview = document.getElementById("forecastOverview");

const datasetCoverage = document.getElementById("datasetCoverage");
const coverageLastUpdated = document.getElementById("coverageLastUpdated");
const coverageNeedsReview = document.getElementById("coverageNeedsReview");
const sourceCoverage = document.getElementById("sourceCoverage");
const dataSourcesToggle = document.getElementById("dataSourcesToggle");
const dataSourcesBody = document.getElementById("dataSourcesBody");

// Forecast panel
const forecastToggle = document.getElementById("forecastToggle");
const forecastPanel = document.getElementById("forecastPanel");
const closeForecast = document.getElementById("closeForecast");const fcCountry = document.getElementById("fcCountry");
const fcGenerateBtn = document.getElementById("fcGenerateBtn");
const fcOutput = document.getElementById("fcOutput");
const mapModeButtons = document.querySelectorAll(".map-mode-btn");

// Pending Verification review panel
const reviewToggle = document.getElementById("reviewToggle");
const reviewPanel = document.getElementById("reviewPanel");
const closeReview = document.getElementById("closeReview");
const rvStatusFilter = document.getElementById("rvStatusFilter");
const rvReviewerName = document.getElementById("rvReviewerName");
const rvSummary = document.getElementById("rvSummary");
const rvList = document.getElementById("rvList");
const rvExportWrap = document.getElementById("rvExportWrap");
const rvExport = document.getElementById("rvExport");

const REVIEW_ELEMENTS_PRESENT = reviewToggle && reviewPanel && closeReview &&
    rvStatusFilter && rvSummary && rvList && rvExport;

const FORECAST_ELEMENTS_PRESENT = forecastToggle && forecastPanel && closeForecast &&
    fcCountry && fcGenerateBtn && fcOutput;

const ANALYSIS_CANVAS_IDS = [
    "chartIncidentsByDecade", "chartIncidentsByCountry", "chartIncidentsByRegion",
    "chartFatalitiesByDecade", "chartInjuriesByDecade",
    "chartFrequencyTrend", "chartFatalityTrend", "chartCategoryTrend",
    "chartCumulative", "chartSeverityScatter"
];
const analysisCanvases = {};
ANALYSIS_CANVAS_IDS.forEach(id => { analysisCanvases[id] = document.getElementById(id); });
const analysisCharts = {};

const MIN_YEAR = Number(slider.min);
const MAX_YEAR = Number(slider.max);
const THIS_YEAR = new Date().getFullYear();
const PLAY_STEP_MS = 200;
const PLAY_STEP_YEARS = 1;
const DUAL_PANEL_MIN_WIDTH = 1100;

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

let events = [];
let datasetLastModified = null;
let playTimer = null;

// ---------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------

function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function toNumber(value) {
    const n = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
}

function formatLastModified(rawDate) {
    if (!rawDate) return "Unavailable (host did not report a modification date for history.json)";
    const parsed = new Date(rawDate);
    return Number.isNaN(parsed.getTime())
        ? escapeHtml(rawDate)
        : parsed.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// ---------------------------------------------------------------------
// Type resolution
// ---------------------------------------------------------------------

const TYPE_HINTS = [
    [/shoot|gunman|gunfire|sniper|firearm/i, "shooting"],
    [/bomb|explos|detonat|blast|\bied\b/i, "explosion"],
    [/fire|blaze|arson|inferno|burn/i, "fire"],
    [/collapse|structural|bridge fail|building fail/i, "structural"],
    [/crash|derail|train|airline|flight|ferry|aviation|\bbus\b/i, "transport"],
    [/hurricane|tornado|flood|storm|blizzard|wildfire|earthquake/i, "weather"],
    [/riot|unrest|protest|clash|uprising/i, "civil"]
];

function resolveType(event) {
    if (event.type && INCIDENT_TYPES[event.type]) return event.type;
    const haystack = [event.title, event.description, event.venue].filter(Boolean).join(" ");
    for (const [pattern, type] of TYPE_HINTS) {
        if (pattern.test(haystack)) return type;
    }
    return "other";
}

// ---------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------

function buildLegend() {
    const rows = Object.entries(INCIDENT_TYPES).map(([, t]) =>
        `<li><span class="swatch" style="background:${t.color}"></span>${t.label}</li>`
    );
    rows.push(
        `<li><span class="swatch is-zone" style="background:${HOTZONE_COLOR}"></span>Hot zone (${HOTZONE_THRESHOLD}+ fatalities)</li>`,
        `<li><span class="swatch is-projected"></span>Projected / future</li>`
    );
    legendList.innerHTML = rows.join("");
}

legendToggle.addEventListener("click", () => {
    const nowCollapsed = legend.classList.toggle("collapsed");
    const open = !nowCollapsed;
    legendToggle.setAttribute("aria-expanded", String(open));
    legendList.style.display = open ? "block" : "none";
});

// ---------------------------------------------------------------------
// Data load
// ---------------------------------------------------------------------

fetch("history.json")
    .then(response => {
        if (!response.ok) throw new Error(`Failed to load history.json: ${response.status}`);
        datasetLastModified = response.headers.get("Last-Modified");
        return response.json();
    })
    .then(data => {
        events = data.map(event => ({
            ...event,
            year: Number(event.year),
            lat: Number(event.lat),
            lng: Number(event.lng),
            resolvedType: resolveType(event),
            fatalityCount: toNumber(event.fatalities)
        }));

        const outOfRange = events.filter(e => e.year < MIN_YEAR || e.year > MAX_YEAR);
        if (outOfRange.length) {
            console.warn(`${outOfRange.length} incident(s) fall outside ${MIN_YEAR}-${MAX_YEAR} and will never appear:`,
                outOfRange.map(e => `${e.year} ${e.title}`));
        }

        const badCoords = events.filter(e => !Number.isFinite(e.lat) || !Number.isFinite(e.lng));
        if (badCoords.length) {
            console.warn("Incident(s) missing usable coordinates:", badCoords.map(e => e.title));
            events = events.filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lng));
        }

        applyFilters();
        populateResearchFilters();
        renderDatasetCoverage();
        renderSourceCoverage();
        populateForecastCountries();
    })
    .catch(error => {
        console.error(error);
        panelContent.innerHTML =
            `<h2>Data unavailable</h2><p>history.json did not load. Check that the file is deployed next to index.html, then reload.</p>`;
        openSheet();
    });

// ---------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------

function addMarker(event) {
    const type = INCIDENT_TYPES[event.resolvedType] || INCIDENT_TYPES.other;
    const projected = event.year > THIS_YEAR;

    if (event.fatalityCount >= HOTZONE_THRESHOLD) {
        const radius = Math.min(600000, 40000 + event.fatalityCount * 3000);
        L.circle([event.lat, event.lng], {
            radius, color: HOTZONE_COLOR, weight: 1,
            dashArray: projected ? "5,5" : null,
            fillColor: HOTZONE_COLOR, fillOpacity: projected ? 0.04 : 0.12,
            interactive: false
        }).addTo(hotZoneLayer);
    }

    const pxRadius = 6 + Math.min(8, Math.sqrt(event.fatalityCount));
    const diameter = pxRadius * 2;
    const borderColor = projected ? type.color : "#0E1116";
    const fillStyle = projected ? "transparent" : type.color;
    const borderStyle = projected ? "dashed" : "solid";

    const icon = L.divIcon({
        className: "",
        html: `<div class="nhira-marker" style="width:${diameter}px;height:${diameter}px;background:${fillStyle};border:2px ${borderStyle} ${borderColor};"></div>`,
        iconSize: [diameter, diameter],
        iconAnchor: [diameter / 2, diameter / 2]
    });

    L.marker([event.lat, event.lng], { icon })
        .bindTooltip(`${event.title} (${event.year})`, { direction: "top" })
        .on("click", e => {
            L.DomEvent.stop(e);
            openPanel(event);
        })
        .addTo(markerLayer);
}

function clearMarkers() {
    markerLayer.clearLayers();
    hotZoneLayer.clearLayers();
}

// ---------------------------------------------------------------------
// Unified filter state
// ---------------------------------------------------------------------

function matchesActiveResearchFilters(event) {
    if (!RESEARCH_ELEMENTS_PRESENT) return true;

    if (rsCountry.value && event.country !== rsCountry.value) return false;
    if (rsCategory.value && event.resolvedType !== rsCategory.value) return false;
    if (rsRegion.value && getRegion(event.country) !== rsRegion.value) return false;
    if (event.fatalityCount < (Number(rsMinFatalities.value) || 0)) return false;

    let rsStart = Number(rsStartYear.value);
    let rsEnd = Number(rsEndYear.value);
    if (!Number.isFinite(rsStart)) rsStart = MIN_YEAR;
    if (!Number.isFinite(rsEnd)) rsEnd = MAX_YEAR;
    if (rsStart > rsEnd) [rsStart, rsEnd] = [rsEnd, rsStart];
    if (event.year < rsStart || event.year > rsEnd) return false;

    return true;
}

function getMatchedEvents() {
    const sliderYear = Number(slider.value);
    const text = search.value.trim().toLowerCase();

    let startYear = Number(startYearInput?.value);
    let endYear = Number(endYearInput?.value);

    if (!Number.isFinite(startYear)) startYear = MIN_YEAR;
    if (!Number.isFinite(endYear)) endYear = sliderYear;
    if (startYear > endYear) [startYear, endYear] = [endYear, startYear];

    return events.filter(event => {
        const withinRange = event.year >= startYear && event.year <= endYear;
        const matchesText =
            !text ||
            [
                event.title, event.city, event.state, event.country, event.venue,
                event.description, event.year, event.resolvedType,
                INCIDENT_TYPES[event.resolvedType]?.label
            ]
                .filter(Boolean)
                .some(field => String(field).toLowerCase().includes(text));

        return withinRange && matchesText && matchesActiveResearchFilters(event);
    });
}

function updateYearReadout(year) {
    yearDisplay.textContent = year;
    const projected = Number(year) > THIS_YEAR;
    eraTag.textContent = projected ? "projected" : "recorded";
    eraTag.classList.toggle("is-projected", projected);
}

function scoreMatch(event, text) {
    const title = String(event.title || "").toLowerCase();
    if (title === text) return 3;
    if (title.startsWith(text)) return 2;
    if (title.includes(text)) return 1;
    return 0;
}

function applyFilters() {
    const year = Number(slider.value);
    updateYearReadout(year);
    clearMarkers();

    const matchedEvents = getMatchedEvents();
    matchedEvents.forEach(addMarker);

    const text = search.value.trim().toLowerCase();
    if (text && matchedEvents.length > 0) {
        const bestMatch = [...matchedEvents].sort((a, b) => scoreMatch(b, text) - scoreMatch(a, text))[0];
        map.setView([bestMatch.lat, bestMatch.lng], 8);
        openPanel(bestMatch);
    } else if (text && matchedEvents.length === 0) {
        panelContent.innerHTML = `<h2>No incidents found</h2><p>No recorded incidents match "${escapeHtml(search.value.trim())}".</p>`;
        openSheet();
    }
}

const debouncedApplyFilters = debounce(applyFilters, 150);

slider.addEventListener("input", () => {
    updateYearReadout(slider.value);
    debouncedApplyFilters();
});

search.addEventListener("input", debounce(applyFilters, 250));

// ---------------------------------------------------------------------
// Date-range research panel
// ---------------------------------------------------------------------

function runRangeResearch() {
    let startYear = Number(startYearInput.value);
    let endYear = Number(endYearInput.value);

    if (!Number.isFinite(startYear) || !Number.isFinite(endYear)) {
        rangeResults.textContent = "Enter a valid start and end year.";
        return;
    }

    if (startYear > endYear) {
        [startYear, endYear] = [endYear, startYear];
        startYearInput.value = startYear;
        endYearInput.value = endYear;
    }

    slider.value = Math.min(Math.max(endYear, MIN_YEAR), MAX_YEAR);

    const matchedEvents = getMatchedEvents();
    clearMarkers();
    matchedEvents.forEach(addMarker);
    updateYearReadout(slider.value);

    rangeResults.innerHTML = `
        <strong>${matchedEvents.length}</strong>
        incident${matchedEvents.length === 1 ? "" : "s"}
        found from
        <strong>${startYear}</strong>
        to
        <strong>${endYear}</strong>.
    `;

    if (matchedEvents.length > 0) {
        const firstEvent = matchedEvents[0];
        map.setView([firstEvent.lat, firstEvent.lng], 4);
    }
}

if (rangeSearchBtn && clearRangeBtn && startYearInput && endYearInput && rangeResults) {
    rangeSearchBtn.addEventListener("click", runRangeResearch);

    clearRangeBtn.addEventListener("click", () => {
        startYearInput.value = MIN_YEAR;
        endYearInput.value = MAX_YEAR;
        rangeResults.textContent = "";
        search.value = "";
        slider.value = MAX_YEAR;
        applyFilters();
    });

    [startYearInput, endYearInput].forEach(input => {
        input.addEventListener("keydown", event => {
            if (event.key === "Enter") runRangeResearch();
        });
    });
} else {
    console.warn("Date-range research controls not found in the DOM — skipping their setup so the rest of the app still loads.");
}

// ---------------------------------------------------------------------
// Research & Statistics panel
// ---------------------------------------------------------------------

const RESEARCH_ELEMENTS_PRESENT = statsToggle && statsPanel && closeStats &&
    rsStartYear && rsEndYear && rsCountry && rsCategory && rsRegion &&
    rsMinFatalities && rsGenerateBtn && rsClearBtn && rsSummary && rsBreakdown && rsResultsList;

function populateResearchFilters() {
    if (!RESEARCH_ELEMENTS_PRESENT) return;

    const countries = [...new Set(events.map(e => e.country).filter(Boolean))].sort();
    const regions = [...new Set(events.map(e => getRegion(e.country)))].sort();

    rsCountry.innerHTML = '<option value="">All countries</option>' +
        countries.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

    rsRegion.innerHTML = '<option value="">All regions</option>' +
        regions.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("");

    rsCategory.innerHTML = '<option value="">All categories</option>' +
        Object.entries(INCIDENT_TYPES).map(([key, t]) => `<option value="${key}">${escapeHtml(t.label)}</option>`).join("");
}

function getResearchMatches() {
    return events.filter(matchesActiveResearchFilters);
}

// ---------------------------------------------------------------------
// Dataset Coverage + Source Coverage
// ---------------------------------------------------------------------

function sourceCoverageCategory(event) {
    const hasSources = Array.isArray(event.sources) && event.sources.length > 0;
    if (!hasSources) return "needsReview";
    const confidence = String(event.sourceConfidence || "").toLowerCase();
    return confidence === "high" ? "cited" : "partial";
}

function renderDatasetCoverage() {
    if (!datasetCoverage) return;

    const countries = new Set(events.map(e => e.country).filter(Boolean));
    const years = events.map(e => e.year).filter(Number.isFinite);
    const earliest = years.length ? Math.min(...years) : null;
    const latest = years.length ? Math.max(...years) : null;

    const withSources = events.filter(e => Array.isArray(e.sources) && e.sources.length > 0).length;
    const pctSourced = events.length ? Math.round((withSources / events.length) * 100) : 0;
    const needsReview = events.filter(e => sourceCoverageCategory(e) === "needsReview").length;

    datasetCoverage.innerHTML = `
        <div class="stat-card"><b>${events.length.toLocaleString()}</b><span>Records</span></div>
        <div class="stat-card"><b>${countries.size.toLocaleString()}</b><span>Countries</span></div>
        <div class="stat-card"><b>${earliest ?? "—"}–${latest ?? "—"}</b><span>Date range</span></div>
        <div class="stat-card"><b>${pctSourced}%</b><span>Records with sources</span></div>
    `;

    if (coverageLastUpdated) coverageLastUpdated.textContent = `Dataset last updated: ${formatLastModified(datasetLastModified)}`;
    if (coverageNeedsReview) {
        coverageNeedsReview.textContent = events.length
            ? `${needsReview.toLocaleString()} of ${events.length.toLocaleString()} record${events.length === 1 ? "" : "s"} currently have no sources on file and need review.`
            : "No records loaded.";
    }
}

function renderSourceCoverage() {
    if (!sourceCoverage) return;

    const counts = { cited: 0, partial: 0, needsReview: 0 };
    events.forEach(e => { counts[sourceCoverageCategory(e)]++; });

    const total = events.length || 1;
    const pct = key => Math.round((counts[key] / total) * 100);

    sourceCoverage.innerHTML = `
        <div class="coverage-bar">
            <div class="coverage-seg coverage-cited" style="width:${pct("cited")}%"></div>
            <div class="coverage-seg coverage-partial" style="width:${pct("partial")}%"></div>
            <div class="coverage-seg coverage-needsreview" style="width:${pct("needsReview")}%"></div>
        </div>
        <ul class="coverage-legend">
            <li><span class="coverage-swatch coverage-cited"></span>${pct("cited")}% cited — sourced, high confidence</li>
            <li><span class="coverage-swatch coverage-partial"></span>${pct("partial")}% partially cited — sourced, not yet high confidence</li>
            <li><span class="coverage-swatch coverage-needsreview"></span>${pct("needsReview")}% needs review — no sources on file</li>
        </ul>
    `;
}

// ---------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------

function decadeOf(year) { return Math.floor(year / 10) * 10; }

function countBy(items, keyFn) {
    const counts = {};
    items.forEach(item => {
        const key = keyFn(item);
        if (key === undefined || key === null || key === "") return;
        counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
}

function sumBy(items, keyFn, valueFn) {
    const sums = {};
    items.forEach(item => {
        const key = keyFn(item);
        if (key === undefined || key === null || key === "") return;
        sums[key] = (sums[key] || 0) + valueFn(item);
    });
    return sums;
}

function topEntries(obj, n) { return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n); }
function sortedDecadeLabels(obj) { return Object.keys(obj).map(Number).sort((a, b) => a - b).map(String); }

function drawChart(canvasId, config) {
    const canvas = analysisCanvases[canvasId];
    if (!canvas || typeof Chart === "undefined") return;
    if (analysisCharts[canvasId]) analysisCharts[canvasId].destroy();
    analysisCharts[canvasId] = new Chart(canvas, config);
}

const CHART_BASE_OPTIONS = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
        x: { ticks: { font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { font: { size: 10 } }, beginAtZero: true }
    }
};

function renderCharts(matches) {
    if (typeof Chart === "undefined") return;

    const byDecade = countBy(matches, e => decadeOf(e.year));
    const decadeLabels = sortedDecadeLabels(byDecade);
    drawChart("chartIncidentsByDecade", {
        type: "bar",
        data: { labels: decadeLabels, datasets: [{ data: decadeLabels.map(d => byDecade[d]), backgroundColor: "#256B9A" }] },
        options: CHART_BASE_OPTIONS
    });

    const byCountry = topEntries(countBy(matches, e => e.country), 10);
    drawChart("chartIncidentsByCountry", {
        type: "bar",
        data: { labels: byCountry.map(([c]) => c), datasets: [{ data: byCountry.map(([, v]) => v), backgroundColor: "#B3322B" }] },
        options: { ...CHART_BASE_OPTIONS, indexAxis: "y" }
    });

    const byRegion = countBy(matches, e => getRegion(e.country));
    const regionLabels = Object.keys(byRegion).sort();
    drawChart("chartIncidentsByRegion", {
        type: "bar",
        data: { labels: regionLabels, datasets: [{ data: regionLabels.map(r => byRegion[r]), backgroundColor: "#7A3E9D" }] },
        options: CHART_BASE_OPTIONS
    });

    const fatByDecade = sumBy(matches, e => decadeOf(e.year), e => e.fatalityCount);
    const injByDecade = sumBy(matches, e => decadeOf(e.year), e => toNumber(e.injuries));
    const fatDecadeLabels = sortedDecadeLabels(fatByDecade);
    const injDecadeLabels = sortedDecadeLabels(injByDecade);

    drawChart("chartFatalitiesByDecade", {
        type: "bar",
        data: { labels: fatDecadeLabels, datasets: [{ data: fatDecadeLabels.map(d => fatByDecade[d]), backgroundColor: "#D97A17" }] },
        options: CHART_BASE_OPTIONS
    });

    drawChart("chartInjuriesByDecade", {
        type: "bar",
        data: { labels: injDecadeLabels, datasets: [{ data: injDecadeLabels.map(d => injByDecade[d]), backgroundColor: "#2E7D5B" }] },
        options: CHART_BASE_OPTIONS
    });

    drawChart("chartFrequencyTrend", {
        type: "line",
        data: { labels: decadeLabels, datasets: [{ data: decadeLabels.map(d => byDecade[d]), borderColor: "#256B9A", backgroundColor: "rgba(37,107,154,.15)", tension: .3, fill: true }] },
        options: CHART_BASE_OPTIONS
    });

    drawChart("chartFatalityTrend", {
        type: "line",
        data: { labels: fatDecadeLabels, datasets: [{ data: fatDecadeLabels.map(d => fatByDecade[d]), borderColor: "#B3322B", backgroundColor: "rgba(179,50,43,.15)", tension: .3, fill: true }] },
        options: CHART_BASE_OPTIONS
    });

    const categoryKeys = Object.keys(INCIDENT_TYPES);
    const categoryDatasets = categoryKeys.map(key => ({
        label: INCIDENT_TYPES[key].label,
        data: decadeLabels.map(d => matches.filter(e => decadeOf(e.year) === Number(d) && e.resolvedType === key).length),
        backgroundColor: INCIDENT_TYPES[key].color
    })).filter(ds => ds.data.some(v => v > 0));

    drawChart("chartCategoryTrend", {
        type: "bar",
        data: { labels: decadeLabels, datasets: categoryDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: true, position: "bottom", labels: { font: { size: 9 }, boxWidth: 10 } } },
            scales: {
                x: { stacked: true, ticks: { font: { size: 10 } }, grid: { display: false } },
                y: { stacked: true, ticks: { font: { size: 10 } }, beginAtZero: true }
            }
        }
    });

    const sortedByYear = [...matches].sort((a, b) => a.year - b.year);
    const cumulativeLabels = [];
    const cumulativeCounts = [];
    sortedByYear.forEach((e, i) => {
        cumulativeLabels.push(e.year);
        cumulativeCounts.push(i + 1);
    });
    drawChart("chartCumulative", {
        type: "line",
        data: { labels: cumulativeLabels, datasets: [{ data: cumulativeCounts, borderColor: "#4A5560", backgroundColor: "rgba(74,85,96,.1)", pointRadius: 0, tension: 0, fill: true }] },
        options: CHART_BASE_OPTIONS
    });

    drawChart("chartSeverityScatter", {
        type: "scatter",
        data: { datasets: [{ data: matches.map(e => ({ x: e.fatalityCount, y: toNumber(e.injuries) })), backgroundColor: "rgba(179,50,43,.55)" }] },
        options: {
            ...CHART_BASE_OPTIONS,
            scales: {
                x: { title: { display: true, text: "Fatalities" }, ticks: { font: { size: 10 } } },
                y: { title: { display: true, text: "Injuries" }, ticks: { font: { size: 10 } }, beginAtZero: true }
            }
        }
    });

    const topFatalities = [...matches].sort((a, b) => b.fatalityCount - a.fatalityCount).slice(0, 8);
    rsTopFatalities.innerHTML = topFatalities.length
        ? topFatalities.map(e => `
            <li>
                ${escapeHtml(e.title)}
                <div class="rank-meta">${escapeHtml(e.year)} · ${escapeHtml(e.country)} · ${e.fatalityCount.toLocaleString()} fatalities</div>
            </li>
        `).join("")
        : "<li>No incidents match these filters.</li>";

    const topCountries = topEntries(countBy(matches, e => e.country), 8);
    rsTopCountries.innerHTML = topCountries.length
        ? topCountries.map(([country, count]) => `
            <li>${escapeHtml(country)} <div class="rank-meta">${count.toLocaleString()} incident${count === 1 ? "" : "s"}</div></li>
        `).join("")
        : "<li>No incidents match these filters.</li>";

    const allCountryEntries = topEntries(countBy(matches, e => e.country), 5);
    const top5Total = allCountryEntries.reduce((sum, [, v]) => sum + v, 0);
    const share = matches.length ? Math.round((top5Total / matches.length) * 100) : 0;
    rsConcentration.textContent = matches.length
        ? `The top ${allCountryEntries.length} countr${allCountryEntries.length === 1 ? "y accounts" : "ies account"} for ${share}% of all matched incidents (${allCountryEntries.map(([c]) => c).join(", ")}).`
        : "No incidents match these filters.";
}

function renderMethodology(matches) {
    if (!methodologyBody) return;

    const startYear = rsStartYear.value || MIN_YEAR;
    const endYear = rsEndYear.value || MAX_YEAR;
    const categoryLabel = rsCategory.value ? (INCIDENT_TYPES[rsCategory.value]?.label || rsCategory.value) : "All categories";
    const countryLabel = rsCountry.value || "All countries";
    const regionLabel = rsRegion.value || "All regions";
    const minFatalities = Number(rsMinFatalities.value) || 0;

    methodologyBody.innerHTML = `
        <dl>
            <dt>Records included</dt>
            <dd>${matches.length.toLocaleString()} of ${events.length.toLocaleString()} total incidents currently in the dataset, matching the filters below. This is the same filtered set the map, timeline, and search are currently showing.</dd>

            <dt>Date range</dt>
            <dd>${escapeHtml(startYear)}–${escapeHtml(endYear)}</dd>

            <dt>Category</dt>
            <dd>${escapeHtml(categoryLabel)}</dd>

            <dt>Country / Region</dt>
            <dd>${escapeHtml(countryLabel)} · ${escapeHtml(regionLabel)}</dd>

            <dt>Source definition consistency</dt>
            <dd>${rsCountry.value
                ? definitionConsistencyHtml(matches.filter(e => e.country === rsCountry.value), rsCountry.value) || "No records to check."
                : "Filter to a single country above to check whether its records use a consistent incident-counting definition (e.g. FBI Active Shooter vs. Police-reported Shooting) — mixing definitions can look like a trend change that isn't real."}</dd>

            <dt>Minimum fatalities filter</dt>
            <dd>${minFatalities > 0 ? minFatalities.toLocaleString() + "+" : "None applied"}</dd>

            <dt>How fatalities/injuries are counted</dt>
            <dd>Totals sum each incident's primary recorded figure — the number shown as "Official historical figure" where a record documents one. Alternate estimates noted on individual records (shown as "Other estimates" in that incident's detail panel) are informational only and are not included in these totals.</dd>

            <dt>How disputed figures are handled</dt>
            <dd>Incidents flagged with a "Conflicting" source-confidence badge are still counted using their primary recorded figure. Check that incident's Sources for the full range of reported estimates.</dd>

            <dt>Dataset last updated</dt>
            <dd>${formatLastModified(datasetLastModified)}</dd>
        </dl>
    `;
}

function renderForecastOverview(country) {
    if (!forecastOverview) return;

    if (!country) {
        forecastOverview.innerHTML = `<p class="dq-empty">Select a single country in the filters above to see its current risk model here.</p>`;
        return;
    }

    const result = computeForecast(country);
    if (!result) {
        forecastOverview.innerHTML = `<p class="dq-empty">Not enough historical NHIRA records for ${escapeHtml(country)} to model.</p>`;
        return;
    }

    const riskLabel = RISK_LABELS[result.riskTier];
    const cachedBacktest = backtestCache[country];
    const modelAStatusResult = modelAStatus(cachedBacktest);
    const trendRows = [1, 3, 5, 10, 30].map(w => `
        <span class="overview-trend-chip">${w}y: ${result.multiWindowTrend[w].label}</span>
    `).join("");

    forecastOverview.innerHTML = `
        <div class="forecast-blocks">
            <div class="forecast-block forecast-block-category">
                <p class="forecast-block-label">Historical activity category</p>
                <p class="forecast-block-value risk-${result.riskTier}">${riskLabel}</p>
            </div>
            <div class="forecast-block">
                <p class="forecast-block-label">12-month probability</p>
                <p class="forecast-block-value">${result.incidentProbability12mo === null ? "—" : `${result.incidentProbability12mo}%`}</p>
            </div>
            <div class="forecast-block">
                <p class="forecast-block-label">Model A status</p>
                <p class="forecast-block-value overview-validation-value model-status-text-${modelAStatusResult.level}">${cachedBacktest ? modelAStatusResult.label : "Not run"}</p>
            </div>
        </div>
        <div class="overview-trend-row">${trendRows}</div>
        <button type="button" id="forecastOverviewOpenBtn" class="backtest-run-btn">Open full forecast for ${escapeHtml(country)}</button>
    `;

    const openBtn = document.getElementById("forecastOverviewOpenBtn");
    if (openBtn && FORECAST_ELEMENTS_PRESENT) {
        openBtn.addEventListener("click", () => {
            fcCountry.value = country;
            openForecastPanel();
            renderForecast(country);
        });
    }
}

function renderResearch(matches) {
    const totalFatalities = matches.reduce((sum, e) => sum + e.fatalityCount, 0);
    const totalInjuries = matches.reduce((sum, e) => sum + toNumber(e.injuries), 0);
    const countryCount = new Set(matches.map(e => e.country).filter(Boolean)).size;

    rsSummary.innerHTML = `
        <div class="stat-card"><b>${matches.length.toLocaleString()}</b><span>Incidents</span></div>
        <div class="stat-card"><b>${totalFatalities.toLocaleString()}</b><span>Fatalities</span></div>
        <div class="stat-card"><b>${totalInjuries.toLocaleString()}</b><span>Injuries</span></div>
        <div class="stat-card"><b>${countryCount.toLocaleString()}</b><span>Countries</span></div>
    `;

    renderMethodology(matches);
    renderForecastOverview(rsCountry.value);

    const counts = {};
    matches.forEach(e => { counts[e.resolvedType] = (counts[e.resolvedType] || 0) + 1; });

    const breakdownRows = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([typeKey, count]) => {
            const type = INCIDENT_TYPES[typeKey] || INCIDENT_TYPES.other;
            return `
                <li>
                    <span class="bar-label">
                        <span class="swatch" style="background:${type.color}"></span>
                        ${escapeHtml(type.label)}
                    </span>
                    <b>${count.toLocaleString()}</b>
                </li>
            `;
        });

    rsBreakdown.innerHTML = breakdownRows.length ? breakdownRows.join("") : "<li>No incidents match these filters.</li>";

    const sortedMatches = [...matches].sort((a, b) => a.year - b.year);
    const MAX_LISTED = 200;

    rsResultsList.innerHTML = sortedMatches.slice(0, MAX_LISTED).map(e => `
        <div class="result-row">
            <div class="result-title">${escapeHtml(e.title)}</div>
            <div class="result-meta">${escapeHtml(e.year)} · ${escapeHtml([e.city, e.country].filter(Boolean).join(", "))} · ${escapeHtml(e.fatalityCount)} fatalities</div>
        </div>
    `).join("");

    if (sortedMatches.length > MAX_LISTED) {
        rsResultsList.innerHTML += `<div class="result-row">…and ${(sortedMatches.length - MAX_LISTED).toLocaleString()} more.</div>`;
    }

    renderCharts(matches);
}

function runResearch() {
    renderResearch(getResearchMatches());
}

function openStats() {
    statsPanel.classList.add("open");
    statsPanel.setAttribute("aria-hidden", "false");
    statsToggle.setAttribute("aria-expanded", "true");
    if (FORECAST_ELEMENTS_PRESENT) closeForecastPanel();
    if (REVIEW_ELEMENTS_PRESENT) closeReviewPanel();
    if (window.innerWidth < DUAL_PANEL_MIN_WIDTH) sidePanel.classList.remove("open");
    if (window.innerWidth < 760) scrim.hidden = false;
    runResearch();
}

function closeStatsPanel() {
    statsPanel.classList.remove("open");
    statsPanel.setAttribute("aria-hidden", "true");
    statsToggle.setAttribute("aria-expanded", "false");
    scrim.hidden = true;
}

function refreshEverything() {
    runResearch();
    applyFilters();
}

if (RESEARCH_ELEMENTS_PRESENT) {
    statsToggle.addEventListener("click", () => {
        if (statsPanel.classList.contains("open")) {
            closeStatsPanel();
        } else {
            openStats();
        }
    });

    closeStats.addEventListener("click", closeStatsPanel);

    if (methodologyToggle && methodologyBody) {
        methodologyToggle.addEventListener("click", () => {
            const open = methodologyBody.hidden;
            methodologyBody.hidden = !open;
            methodologyToggle.setAttribute("aria-expanded", String(open));
        });
    }

    if (dataSourcesToggle && dataSourcesBody) {
        dataSourcesToggle.addEventListener("click", () => {
            const open = dataSourcesBody.hidden;
            if (open && !dataSourcesBody.dataset.rendered) {
                dataSourcesBody.innerHTML = renderDataSourcesDefinitions();
                dataSourcesBody.dataset.rendered = "true";
            }
            dataSourcesBody.hidden = !open;
            dataSourcesToggle.setAttribute("aria-expanded", String(open));
        });
    }

    rsGenerateBtn.addEventListener("click", refreshEverything);

    const debouncedRefresh = debounce(refreshEverything, 200);
    [rsStartYear, rsEndYear, rsMinFatalities].forEach(input => {
        input.addEventListener("input", debouncedRefresh);
    });
    [rsCountry, rsCategory, rsRegion].forEach(select => {
        select.addEventListener("change", refreshEverything);
    });

    rsClearBtn.addEventListener("click", () => {
        rsStartYear.value = MIN_YEAR;
        rsEndYear.value = MAX_YEAR;
        rsCountry.value = "";
        rsCategory.value = "";
        rsRegion.value = "";
        rsMinFatalities.value = 0;
        refreshEverything();
    });
} else {
    console.warn("Research & Statistics controls not found in the DOM — skipping their setup so the rest of the app still loads.");
}

// =====================================================================
// FORECAST — NHIRA v1
//
// This is a transparent descriptive-statistics model, NOT a fitted
// Poisson/negative-binomial regression, random forest, or gradient
// boosting model. It computes:
//   - a long-run per-year baseline
//   - a linear trend over the recent window
//   - a recent-year rate compared to that baseline
//   - month-of-year seasonality (only when enough dated — not just
//     year-only — records exist for the country)
//   - an uncertainty band derived from the dataset's own year-to-year
//     variance (a lightweight proxy for the fact that incident counts
//     are frequently overdispersed relative to a plain Poisson model,
//     which is exactly why negative-binomial is the right next step
//     once real regression is built server-side)
//
// Wording spec (locked): every result and map tooltip reads as
// "NHIRA statistical forecast: <level> expected incident activity" —
// never a prediction that an incident will occur. Population-adjusted
// rate is permanently reported NOT AVAILABLE until a real population
// denominator dataset exists.
// =====================================================================

const FORECAST_WINDOW_YEARS = 10;

// Dampens the recent-rate term specifically — this is the fix for the
// model being too reactive to a single recent swing (e.g. a +9.7
// adjustment against an 11.8 baseline). 0.5 means only half of the
// gap between the last-2-years rate and the long-run baseline gets
// carried into the estimate. Disclosed, fixed, not itself tuned by
// the backtest — the backtest instead tunes a SEPARATE blend weight
// (see tuneShrinkageWeight) against the naive baseline.
const RECENT_RATE_SHRINKAGE = 0.5;
const RISK_COLORS = { lower: "#2E7D5B", elevated: "#F0A202", high: "#D97A17", veryhigh: "#B3322B" };
const RISK_LABELS = { lower: "Lower", elevated: "Elevated", high: "High", veryhigh: "Very High" };

function linearTrendSlope(points) {
    const n = points.length;
    if (n < 2) return 0;
    const sumX = points.reduce((s, p) => s + p[0], 0);
    const sumY = points.reduce((s, p) => s + p[1], 0);
    const sumXY = points.reduce((s, p) => s + p[0] * p[1], 0);
    const sumXX = points.reduce((s, p) => s + p[0] * p[0], 0);
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return 0;
    return (n * sumXY - sumX * sumY) / denom;
}

function computeForecast(country) {
    const countryEvents = events.filter(e => e.country === country && e.year <= THIS_YEAR);
    if (countryEvents.length === 0) return null;

    const yearlyCounts = countBy(countryEvents, e => e.year);
    const allYears = Object.keys(yearlyCounts).map(Number).sort((a, b) => a - b);
    if (allYears.length === 0) return null;

    const windowYears = allYears.filter(y => y > THIS_YEAR - FORECAST_WINDOW_YEARS);
    const usableYears = windowYears.length >= 2 ? windowYears : allYears;

    const counts = usableYears.map(y => yearlyCounts[y] || 0);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    const dispersionRatio = mean > 0 ? Math.round((variance / mean) * 100) / 100 : 0;

    const trendPoints = usableYears.map((y, i) => [i, yearlyCounts[y] || 0]);
    const slope = linearTrendSlope(trendPoints);

    const last2 = usableYears.slice(-2).map(y => yearlyCounts[y] || 0);
    const recentRate = last2.length ? last2.reduce((a, b) => a + b, 0) / last2.length : mean;

    const lastYear = usableYears[usableYears.length - 1];
    const prevYear = usableYears[usableYears.length - 2];
    let yoyChangePct = null;
    if (prevYear !== undefined && yearlyCounts[prevYear] > 0) {
        yoyChangePct = Math.round((((yearlyCounts[lastYear] || 0) - yearlyCounts[prevYear]) / yearlyCounts[prevYear]) * 1000) / 10;
    }

    const allCounts = allYears.map(y => yearlyCounts[y] || 0);
    const longRunRate = allCounts.reduce((a, b) => a + b, 0) / allCounts.length;

    // Seasonality needs real dates, not just years — skip gracefully
    // if there isn't enough dated data to say anything meaningful.
    // IMPORTANT: this is reported as CONTEXT only — it is deliberately
    // NOT folded into modelEstimate below. Baking a seasonal nudge
    // into the number was exactly how NHIRA ended up showing two
    // different annual rates in the same panel (the seasonally-adjusted
    // "central estimate" vs. the unadjusted "annual rate" used for the
    // 12-month probability). Now there is exactly one model-adjusted
    // number, computed once, and seasonality is a labeled note next to
    // it rather than a silent second formula.
    const datedEvents = countryEvents.filter(e => /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || "")));
    let seasonalityLabel = "Insufficient dated records";
    let seasonalityRatio = null;
    if (datedEvents.length >= 20) {
        const byMonth = new Array(12).fill(0);
        datedEvents.forEach(e => { byMonth[new Date(e.date).getMonth()]++; });
        const overallAvg = datedEvents.length / 12;
        const now = new Date();
        const targetMonths = [1, 2, 3].map(offset => (now.getMonth() + offset) % 12);
        const targetAvg = targetMonths.reduce((sum, m) => sum + byMonth[m], 0) / targetMonths.length;
        seasonalityRatio = overallAvg > 0 ? targetAvg / overallAvg : 1;
        seasonalityLabel = seasonalityRatio > 1.15 ? "Elevated" : seasonalityRatio < 0.85 ? "Reduced" : "Typical";
    }

    const now = new Date();
    const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];
    const periodMonths = [1, 2, 3].map(offset => {
        const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        return { name: MONTH_NAMES[d.getMonth()], year: d.getFullYear() };
    });
    const periodLabel = `${periodMonths[0].name}–${periodMonths[2].name} ${periodMonths[2].year}`;

    // ---- The ONE model-adjusted estimate ----
    // Everywhere NHIRA shows an annual rate — the live central
    // estimate, the forecast components table, the 12-month
    // probability, and the backtest — now traces back to this single
    // call. There is no second formula anymore.
    const annual = computeAnnualForecastAsOf(country, THIS_YEAR);
    if (!annual) return null;

    const historicalAnnualRate = annual.baseline;      // unadjusted long-run average
    const modelAdjustedRate = annual.modelEstimate;     // baseline + trend + shrunk recent-rate
    const modelEstimate = modelAdjustedRate;            // forecast central estimate — SAME number, not a third formula
    const estimateLow = annual.estimateLow;
    const estimateHigh = annual.estimateHigh;
    const trendAdjustment = annual.trendAdjustment;
    const recentRateAdjustment = annual.recentRateAdjustment;

    const ratio = longRunRate > 0 ? recentRate / longRunRate : (recentRate > 0 ? 2 : 0);
    let riskTier;
    if (ratio < 0.85) riskTier = "lower";
    else if (ratio < 1.15) riskTier = "elevated";
    else if (ratio < 1.5) riskTier = "high";
    else riskTier = "veryhigh";

    const totalInWindow = counts.reduce((a, b) => a + b, 0);

    // "Data confidence" — how much evidence exists to compute this at
    // all. Separate from "forecast validation" (below), which is about
    // whether the resulting classification has ever been checked
    // against reality.
    let dataConfidence;
    if (usableYears.length >= 8 && totalInWindow >= 15 && dispersionRatio < 3) dataConfidence = "High";
    else if (usableYears.length >= 4 && totalInWindow >= 6) dataConfidence = "Moderate";
    else dataConfidence = "Low";

    // Forecast validation is permanently "Not yet established" in V1 —
    // no backtesting harness exists yet. This is not computed from the
    // data; it's a fixed statement of what has and hasn't been done.
    const forecastValidation = "Not yet established";

    let dataCoverage;
    if (usableYears.length >= 8 && totalInWindow >= 20) dataCoverage = "Good";
    else if (usableYears.length >= 4 && totalInWindow >= 8) dataCoverage = "Adequate";
    else dataCoverage = "Limited";

    const trendLabel = slope > 0.15 ? "Increasing" : slope < -0.15 ? "Decreasing" : "Stable";

    // Flag when the single-year YoY swing points the opposite direction
    // from the overall classification, so the UI can explain the
    // apparent contradiction instead of leaving it unexplained.
    const yoyContradictsTier = yoyChangePct !== null && (
        (yoyChangePct < 0 && (riskTier === "high" || riskTier === "veryhigh")) ||
        (yoyChangePct > 0 && riskTier === "lower")
    );

    // ---- Additional risk factors (display-only — none of these feed
    // back into modelEstimate/riskTier above; they're reported
    // alongside it so a researcher can see the fuller picture without
    // the core, already-backtested estimate formula changing shape) ----

    const multiWindowTrend = {};
    [1, 3, 5, 10, 30].forEach(windowYears => {
        const windowEvents = countryEvents.filter(e => e.year > THIS_YEAR - windowYears);
        const windowCounts = countBy(windowEvents, e => e.year);
        const windowYearsPresent = Object.keys(windowCounts).map(Number).sort((a, b) => a - b);
        if (windowYearsPresent.length < 2) {
            multiWindowTrend[windowYears] = { label: "Insufficient data", yearsOfData: windowYearsPresent.length };
            return;
        }
        const windowSlope = linearTrendSlope(windowYearsPresent.map((y, i) => [i, windowCounts[y] || 0]));
        multiWindowTrend[windowYears] = {
            label: windowSlope > 0.15 ? "Increasing" : windowSlope < -0.15 ? "Decreasing" : "Stable",
            yearsOfData: windowYearsPresent.length
        };
    });

    let acceleration = { label: "Insufficient data" };
    if (usableYears.length >= 4) {
        const mid = Math.floor(usableYears.length / 2);
        const earlySlope = linearTrendSlope(usableYears.slice(0, mid).map((y, i) => [i, yearlyCounts[y] || 0]));
        const lateSlope = linearTrendSlope(usableYears.slice(mid).map((y, i) => [i, yearlyCounts[y] || 0]));
        const delta = Math.round((lateSlope - earlySlope) * 100) / 100;
        acceleration = {
            label: delta > 0.2 ? "Accelerating" : delta < -0.2 ? "Decelerating" : "Steady",
            delta
        };
    }

    let timeSinceLastIncidentDays = null;
    if (countryEvents.length) {
        const mostRecentMs = Math.max(...countryEvents.map(e => {
            const d = e.date ? new Date(e.date) : new Date(e.year, 0, 1);
            return Number.isNaN(d.getTime()) ? -Infinity : d.getTime();
        }));
        if (Number.isFinite(mostRecentMs)) {
            timeSinceLastIncidentDays = Math.max(0, Math.round((Date.now() - mostRecentMs) / (1000 * 60 * 60 * 24)));
        }
    }

    const byState = countBy(countryEvents, e => e.state);
    const topStateEntry = topEntries(byState, 1)[0];
    const geographicConcentration = (topStateEntry && countryEvents.length)
        ? { label: topStateEntry[0], sharePct: Math.round((topStateEntry[1] / countryEvents.length) * 1000) / 10 }
        : null;

    // 12-month incident probability — a Poisson approximation from
    // EXACTLY the same modelAdjustedRate used as the central estimate
    // above (previously this called computeAnnualForecastAsOf a SECOND
    // time and could, in principle, drift from the displayed central
    // estimate if the two call sites ever diverged — now there is only
    // one call, reused here). P(at least one incident) = 1 - e^(-lambda).
    // This is NOT a calibrated machine-learned probability — it's read
    // directly off the modeled annual rate, and its own calibration has
    // not itself been backtested (that would mean checking, across many
    // past years, whether "X% probability" years actually saw an
    // incident about X% of the time — a different exercise from the
    // count-based and interval-based backtests below).
    const incidentProbability12mo = Math.round((1 - Math.exp(-modelAdjustedRate)) * 1000) / 10;

    return {
        country, periodLabel, riskTier, estimateLow, estimateHigh,
        modelEstimate, historicalAnnualRate, modelAdjustedRate,
        baseline: historicalAnnualRate,
        trendAdjustment, recentRateAdjustment,
        trendLabel, seasonalityLabel, seasonalityRatio, dataConfidence, forecastValidation, dataCoverage,
        dispersionRatio, yoyChangePct, yoyContradictsTier,
        yearsOfData: usableYears.length, totalInWindow,
        multiWindowTrend, acceleration, timeSinceLastIncidentDays, geographicConcentration,
        incidentProbability12mo
    };
}

// =====================================================================
// FORECAST BACKTESTING
//
// Rolling-origin validation: train on years up to Y, forecast Y+1,
// compare to what actually happened, repeat forward through the
// dataset. This is the objective test of whether the model has real
// predictive value — not just plausible-looking numbers — per the
// locked spec: "Forecast validation" stays "Not yet established"
// until this has actually been run for a given country.
//
// Deliberately uses a SEPARATE, simpler annual-forecast function
// (computeAnnualForecastAsOf) rather than reusing computeForecast()
// directly: the live forecast targets a 3-month window with monthly
// seasonality, which isn't the right shape to compare against a full
// year's actual count. Backtesting a full-year prediction needs a
// full-year prediction model, not a repurposed short-window one.
// =====================================================================

const MIN_BACKTEST_TRAIN_YEARS = 5;

// Cache keyed by country so re-opening a forecast in the same session
// doesn't lose a backtest you already ran, and so the "Forecast
// validation" field can reflect it immediately.
let backtestCache = {};

// =====================================================================
// NHIRA RISK SCORE
//
// A single explainable 0-100 composite, NOT a claim that any specific
// incident is predictable:
//
//   25% Recent incident activity   (last-2-years rate vs. long-run rate)
//   20% Historical baseline        (this country's long-run rate,
//                                   ranked against other countries)
//   20% Acceleration / trend       (direction + change in trend slope)
//   15% Geographic clustering      (share of incidents in the top state)
//   10% Casualty severity          (avg fatalities+injuries per incident)
//   10% Temporal / seasonal        (whether the upcoming months are
//                                   historically elevated for this country)
//
// Every factor that can't be reliably computed is reported as "Not
// available" and EXCLUDED from the composite (the remaining weights
// are rescaled to sum to 100%, not silently padded with a guess). If
// fewer than 3 of 6 factors are available, the whole score is "Not
// available" rather than built on a thin, unreliable base.
//
// The research question this answers: "does this country currently
// show a statistically elevated incident pattern relative to its own
// baseline" — never "will an incident happen here." See
// computeRiskScoreBacktest for whether the score has any track record
// of flagging genuinely elevated years in advance.
// =====================================================================

const RISK_SCORE_WEIGHTS = {
    recentActivity: 25,
    historicalBaseline: 20,
    acceleration: 20,
    geographicClustering: 15,
    casualtySeverity: 10,
    temporalSeasonal: 10
};

const RISK_SCORE_MIN_FACTORS = 3;

// Smooth ratio-to-baseline mapping shared by any factor expressed as
// "this value relative to a baseline value" — 50 at parity, roughly
// linear either side, clamped to [0, 100].
function ratioToScore(ratio) {
    if (!Number.isFinite(ratio)) return null;
    return Math.max(0, Math.min(100, Math.round(50 + (ratio - 1) * 50)));
}

// Cross-country ranking data, computed once per session and cached —
// needed for the two factors that are only meaningful RELATIVE to
// other countries (historical baseline, casualty severity), so a
// country isn't scored against itself for those.
let crossCountryStatsCache = null;

function computeCrossCountryStats() {
    if (crossCountryStatsCache) return crossCountryStatsCache;

    const countries = [...new Set(events.map(e => e.country).filter(Boolean))];
    const stats = countries.map(country => {
        const countryEvents = events.filter(e => e.country === country && e.year <= THIS_YEAR);
        if (countryEvents.length < 3) return null;
        const yearlyCounts = countBy(countryEvents, e => e.year);
        const years = Object.keys(yearlyCounts).map(Number);
        if (years.length < 2) return null;
        const longRunRate = countryEvents.length / years.length;
        const avgSeverity = countryEvents.reduce((s, e) => s + e.fatalityCount + toNumber(e.injuries), 0) / countryEvents.length;
        return { country, longRunRate, avgSeverity };
    }).filter(Boolean);

    crossCountryStatsCache = stats;
    return stats;
}

function percentileRank(value, allValues) {
    if (allValues.length < 3) return null; // too few countries to rank meaningfully
    const below = allValues.filter(v => v < value).length;
    return Math.round((below / allValues.length) * 100);
}

// Hard floor on OVERALL data volume — independent of how many
// individual factor categories happen to return a value. Three thin
// factors computed from 2 total incidents can technically clear
// RISK_SCORE_MIN_FACTORS below without this; a country needs a
// genuine evidentiary base before ANY composite is shown, matching
// the same floor used for "Moderate" data confidence elsewhere.
const RISK_SCORE_MIN_TOTAL_INCIDENTS = 6;
const RISK_SCORE_MIN_TOTAL_YEARS = 4;

function computeRiskScoreFactors(country, asOfYear) {
    const cutoff = asOfYear ?? THIS_YEAR;
    const countryEvents = events.filter(e => e.country === country && e.year <= cutoff);
    if (countryEvents.length === 0) return null;

    const yearlyCounts = countBy(countryEvents, e => e.year);
    const allYears = Object.keys(yearlyCounts).map(Number).sort((a, b) => a - b);
    if (allYears.length === 0) return null;

    const insufficientOverall = countryEvents.length < RISK_SCORE_MIN_TOTAL_INCIDENTS
        || allYears.length < RISK_SCORE_MIN_TOTAL_YEARS;

    const windowYears = allYears.filter(y => y > cutoff - FORECAST_WINDOW_YEARS);
    const usableYears = windowYears.length >= 2 ? windowYears : allYears;
    const longRunRate = countryEvents.length / allYears.length;

    const factors = {};

    // 1. Recent incident activity (25%)
    const last2 = usableYears.slice(-2).map(y => yearlyCounts[y] || 0);
    const recentRate = last2.length ? last2.reduce((a, b) => a + b, 0) / last2.length : null;
    factors.recentActivity = (recentRate !== null && longRunRate > 0)
        ? { score: ratioToScore(recentRate / longRunRate), detail: `${Math.round(recentRate * 10) / 10}/yr vs. ${Math.round(longRunRate * 10) / 10}/yr baseline` }
        : null;

    // 2. Historical baseline (20%) — ranked against other countries
    const crossStats = computeCrossCountryStats();
    const baselineRank = percentileRank(longRunRate, crossStats.map(s => s.longRunRate));
    factors.historicalBaseline = baselineRank !== null
        ? { score: baselineRank, detail: `Higher long-run rate than ${baselineRank}% of ranked countries` }
        : null;

    // 3. Acceleration / trend (20%)
    let accelScore = null, accelDetail = null;
    if (usableYears.length >= 2) {
        const trendPoints = usableYears.map((y, i) => [i, yearlyCounts[y] || 0]);
        const slope = linearTrendSlope(trendPoints);
        const trendBase = slope > 0.15 ? 75 : slope < -0.15 ? 25 : 50;
        let delta = 0;
        if (usableYears.length >= 4) {
            const mid = Math.floor(usableYears.length / 2);
            const earlySlope = linearTrendSlope(usableYears.slice(0, mid).map((y, i) => [i, yearlyCounts[y] || 0]));
            const lateSlope = linearTrendSlope(usableYears.slice(mid).map((y, i) => [i, yearlyCounts[y] || 0]));
            delta = lateSlope - earlySlope;
        }
        accelScore = Math.max(0, Math.min(100, Math.round(trendBase + delta * 25)));
        accelDetail = `Trend ${slope > 0.15 ? "increasing" : slope < -0.15 ? "decreasing" : "stable"}${Math.abs(delta) > 0.2 ? (delta > 0 ? ", accelerating" : ", decelerating") : ""}`;
    }
    factors.acceleration = accelScore !== null ? { score: accelScore, detail: accelDetail } : null;

    // 4. Geographic clustering (15%)
    const byState = countBy(countryEvents, e => e.state);
    const topStateEntry = topEntries(byState, 1)[0];
    factors.geographicClustering = topStateEntry
        ? { score: Math.round((topStateEntry[1] / countryEvents.length) * 100), detail: `${Math.round((topStateEntry[1] / countryEvents.length) * 100)}% concentrated in ${topStateEntry[0]}` }
        : null;

    // 5. Casualty severity (10%) — ranked against other countries
    const avgSeverity = countryEvents.reduce((s, e) => s + e.fatalityCount + toNumber(e.injuries), 0) / countryEvents.length;
    const severityRank = percentileRank(avgSeverity, crossStats.map(s => s.avgSeverity));
    factors.casualtySeverity = severityRank !== null
        ? { score: severityRank, detail: `${Math.round(avgSeverity * 10) / 10} avg. casualties/incident — higher than ${severityRank}% of ranked countries` }
        : null;

    // 6. Temporal / seasonal pattern (10%)
    const datedEvents = countryEvents.filter(e => /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || "")));
    let seasonalScore = null, seasonalDetail = null;
    if (datedEvents.length >= 20) {
        const byMonth = new Array(12).fill(0);
        datedEvents.forEach(e => { byMonth[new Date(e.date).getMonth()]++; });
        const overallAvg = datedEvents.length / 12;
        const now = new Date();
        const targetMonths = [1, 2, 3].map(offset => (now.getMonth() + offset) % 12);
        const targetAvg = targetMonths.reduce((sum, m) => sum + byMonth[m], 0) / targetMonths.length;
        const ratio = overallAvg > 0 ? targetAvg / overallAvg : 1;
        seasonalScore = ratioToScore(ratio);
        seasonalDetail = `Upcoming months are historically ${ratio > 1.15 ? "elevated" : ratio < 0.85 ? "reduced" : "typical"} for this country`;
    }
    factors.temporalSeasonal = seasonalScore !== null ? { score: seasonalScore, detail: seasonalDetail } : null;

    // Composite: weighted average of AVAILABLE factors only, reweighted
    // so the used weights sum to 100% — never padded with a guess.
    const availableKeys = Object.keys(factors).filter(k => factors[k] !== null);
    if (insufficientOverall || availableKeys.length < RISK_SCORE_MIN_FACTORS) {
        return {
            factors, compositeScore: null, tier: null,
            availableCount: availableKeys.length,
            insufficientOverall,
            totalIncidents: countryEvents.length,
            totalYears: allYears.length
        };
    }

    const usedWeightSum = availableKeys.reduce((s, k) => s + RISK_SCORE_WEIGHTS[k], 0);
    const compositeScore = Math.round(
        availableKeys.reduce((s, k) => s + factors[k].score * (RISK_SCORE_WEIGHTS[k] / usedWeightSum), 0)
    );

    const tier = compositeScore >= 80 ? "veryhigh" : compositeScore >= 60 ? "high" : compositeScore >= 40 ? "elevated" : "lower";

    return { factors, compositeScore, tier, availableCount: availableKeys.length, usedWeightSum };
}

const RISK_TIER_ICONS = { lower: "🟢", elevated: "🟡", high: "🟠", veryhigh: "🔴" };
const RISK_TIER_NAMES = { lower: "Baseline", elevated: "Elevated", high: "High", veryhigh: "Very High" };

const RISK_FACTOR_LABELS = {
    recentActivity: "Recent incident activity",
    historicalBaseline: "Historical baseline",
    acceleration: "Acceleration / trend",
    geographicClustering: "Geographic clustering",
    casualtySeverity: "Casualty severity",
    temporalSeasonal: "Temporal / seasonal pattern"
};

function renderRiskScore(country) {
    const result = computeRiskScoreFactors(country, THIS_YEAR);
    if (!result) return `<p class="dq-empty">Not enough historical NHIRA records for ${escapeHtml(country)} to compute a risk score.</p>`;

    if (result.compositeScore === null) {
        return `
            <div class="model-status-badge model-status-gray">
                <span class="model-status-label">NOT AVAILABLE</span>
                <p>${result.insufficientOverall
                    ? `${escapeHtml(country)} has only ${result.totalIncidents} incident(s) across ${result.totalYears} year(s) on file — below the minimum (${RISK_SCORE_MIN_TOTAL_INCIDENTS} incidents, ${RISK_SCORE_MIN_TOTAL_YEARS} years) for a composite score, regardless of how many individual factors happened to return a value.`
                    : `Only ${result.availableCount} of 6 risk factors could be reliably computed for ${escapeHtml(country)} (minimum ${RISK_SCORE_MIN_FACTORS} required).`
                } Showing "Not available" rather than a score built on too thin a base.</p>
            </div>
        `;
    }

    const factorRows = Object.entries(RISK_FACTOR_LABELS).map(([key, label]) => {
        const f = result.factors[key];
        return `
            <tr>
                <td>${label} <span class="backtest-range">(${RISK_SCORE_WEIGHTS[key]}% weight)</span></td>
                <td>${f ? `${f.score}/100` : "Not available"}</td>
                <td>${f ? escapeHtml(f.detail) : "Insufficient data — excluded, remaining weights rescaled"}</td>
            </tr>
        `;
    }).join("");

    return `
        <div class="risk-score-header">
            <span class="risk-score-icon">${RISK_TIER_ICONS[result.tier]}</span>
            <div>
                <p class="risk-score-value">${result.compositeScore}<span class="forecast-block-unit">/100</span></p>
                <p class="risk-score-tier">${RISK_TIER_NAMES[result.tier]}</p>
            </div>
        </div>
        <p class="meta">
            Current geographic risk relative to ${escapeHtml(country)}'s own historical baseline — computed from
            ${result.availableCount} of 6 weighted factors (${result.usedWeightSum}% of full weight available; remaining
            weight redistributed proportionally, not padded with a guess).
        </p>

        <p class="chart-title">What's contributing to this score</p>
        <table class="backtest-table">
            <thead><tr><th>Factor</th><th>Score</th><th>Why</th></tr></thead>
            <tbody>${factorRows}</tbody>
        </table>

        <p class="forecast-disclaimer">
            This is a research measure of whether ${escapeHtml(country)} currently shows a statistically elevated incident
            pattern relative to its own baseline — it is not a claim that any specific incident is predictable, and it does
            not identify people, targets, or locations at the individual level.
        </p>
    `;
}

function computeAnnualForecastAsOf(country, asOfYear) {
    const countryEvents = events.filter(e => e.country === country && e.year <= asOfYear);
    if (countryEvents.length === 0) return null;

    const yearlyCounts = countBy(countryEvents, e => e.year);
    const allYears = Object.keys(yearlyCounts).map(Number).sort((a, b) => a - b);
    if (allYears.length === 0) return null;

    const windowYears = allYears.filter(y => y > asOfYear - FORECAST_WINDOW_YEARS);
    const usableYears = windowYears.length >= 2 ? windowYears : allYears;

    const counts = usableYears.map(y => yearlyCounts[y] || 0);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;

    const trendPoints = usableYears.map((y, i) => [i, yearlyCounts[y] || 0]);
    const slope = linearTrendSlope(trendPoints);

    const last2 = usableYears.slice(-2).map(y => yearlyCounts[y] || 0);
    const recentRate = last2.length ? last2.reduce((a, b) => a + b, 0) / last2.length : mean;

    const allCounts = allYears.map(y => yearlyCounts[y] || 0);
    const longRunRate = allCounts.reduce((a, b) => a + b, 0) / allCounts.length;

    // No seasonality term: this predicts a full calendar year, where
    // month-of-year seasonality nets out, not a 3-month window.
    // Recent-rate term is shrunk (see RECENT_RATE_SHRINKAGE) for the
    // same reason as the tactical estimate above — this is the exact
    // function the backtest exercises, so a reactive recent-rate term
    // here directly caused the model to lose to the naive baseline.
    const trendAdjustment = Math.round(slope * 10) / 10;
    const recentRateAdjustment = Math.round((recentRate - longRunRate) * RECENT_RATE_SHRINKAGE * 10) / 10;
    const rawEstimate = longRunRate + trendAdjustment + recentRateAdjustment;
    const modelEstimate = Math.max(0, Math.round(rawEstimate * 10) / 10);
    const margin = Math.max(1, Math.round(Math.sqrt(Math.max(variance, modelEstimate))));
    const naiveBaseline = usableYears.length ? (yearlyCounts[usableYears[usableYears.length - 1]] || 0) : 0;

    return {
        modelEstimate,
        estimateLow: Math.max(0, Math.round(modelEstimate - margin)),
        estimateHigh: Math.round(modelEstimate + margin),
        yearsOfData: usableYears.length,
        baseline: Math.round(longRunRate * 10) / 10,
        trendAdjustment, recentRateAdjustment,
        naiveBaseline
    };
}

function computeBacktest(country) {
    const countryEvents = events.filter(e => e.country === country && e.year <= THIS_YEAR);
    const yearlyCounts = countBy(countryEvents, e => e.year);
    const allYears = Object.keys(yearlyCounts).map(Number).sort((a, b) => a - b);

    if (allYears.length < MIN_BACKTEST_TRAIN_YEARS + 2) {
        return { insufficientData: true, yearsAvailable: allYears.length };
    }

    const minYear = allYears[0];
    const maxYear = allYears[allYears.length - 1];
    const results = [];

    for (let y = minYear + MIN_BACKTEST_TRAIN_YEARS; y < maxYear; y++) {
        const forecast = computeAnnualForecastAsOf(country, y);
        if (!forecast) continue;

        const actual = yearlyCounts[y + 1] || 0; // 0 is a valid, real actual — no incidents that year
        const naiveBaseline = yearlyCounts[y] || 0; // naive: predict = last known year's count
        const hit = actual >= forecast.estimateLow && actual <= forecast.estimateHigh;

        // "Elevated" classification for precision/recall, using the
        // SAME threshold ratio (1.15x baseline) as the live risk tier
        // boundary between "elevated" and "lower" — computed only from
        // information available at prediction time (forecast.baseline
        // is the long-run rate as of year y, never year y+1's actual).
        const elevatedThreshold = forecast.baseline * 1.15;
        const predictedElevated = forecast.modelEstimate > elevatedThreshold;
        const actualElevated = actual > elevatedThreshold;
        // Naive elevated-classifier baseline: "next year will be
        // elevated because last year was" — a genuine, comparably
        // simple baseline for the BINARY question, distinct from the
        // naiveBaseline COUNT used for Model A's MAE/RMSE above.
        const naivePredictedElevated = naiveBaseline > elevatedThreshold;

        // Risk Score, computed "as of" year y using ONLY data through
        // that year — same walk-forward guarantee as everything else
        // backtested here. riskScorePredictedElevated is null (not
        // false) when the score itself was unavailable that year, so
        // it can be excluded from its own precision/recall rather than
        // silently counted as a miss.
        const riskScoreAtY = computeRiskScoreFactors(country, y);
        const riskScorePredictedElevated = (riskScoreAtY && riskScoreAtY.compositeScore !== null)
            ? (riskScoreAtY.tier === "high" || riskScoreAtY.tier === "veryhigh")
            : null;

        results.push({
            trainThrough: y,
            forecastYear: y + 1,
            predictedLow: forecast.estimateLow,
            predictedCentral: forecast.modelEstimate,
            predictedHigh: forecast.estimateHigh,
            actual, hit, naiveBaseline,
            modelError: Math.abs(forecast.modelEstimate - actual),
            naiveError: Math.abs(naiveBaseline - actual),
            predictedElevated, actualElevated, naivePredictedElevated,
            riskScoreValue: riskScoreAtY ? riskScoreAtY.compositeScore : null,
            riskScoreTier: riskScoreAtY ? riskScoreAtY.tier : null,
            riskScorePredictedElevated
        });
    }

    if (!results.length) return { insufficientData: true, yearsAvailable: allYears.length };

    const hitRate = results.filter(r => r.hit).length / results.length;
    const modelMAE = results.reduce((s, r) => s + r.modelError, 0) / results.length;
    const naiveMAE = results.reduce((s, r) => s + r.naiveError, 0) / results.length;
    const modelRMSE = Math.sqrt(results.reduce((s, r) => s + r.modelError ** 2, 0) / results.length);
    const naiveRMSE = Math.sqrt(results.reduce((s, r) => s + r.naiveError ** 2, 0) / results.length);

    // Precision/recall for "did the model correctly flag an elevated
    // year." Reported as null (not 0) when there's no positive class
    // in the data to evaluate against — e.g. a country that was never
    // actually elevated in the tested years has no recall to compute,
    // and reporting 0% would misleadingly imply the model failed.
    const tp = results.filter(r => r.predictedElevated && r.actualElevated).length;
    const fp = results.filter(r => r.predictedElevated && !r.actualElevated).length;
    const fn = results.filter(r => !r.predictedElevated && r.actualElevated).length;
    const precision = (tp + fp) > 0 ? Math.round((tp / (tp + fp)) * 1000) / 10 : null;
    const recall = (tp + fn) > 0 ? Math.round((tp / (tp + fn)) * 1000) / 10 : null;
    // Same precision/recall exercise for the naive elevated-classifier
    // baseline, so Model B's 92.9%-style recall claims have something
    // real to be compared against.
    const nTp = results.filter(r => r.naivePredictedElevated && r.actualElevated).length;
    const nFp = results.filter(r => r.naivePredictedElevated && !r.actualElevated).length;
    const nFn = results.filter(r => !r.naivePredictedElevated && r.actualElevated).length;
    const naivePrecision = (nTp + nFp) > 0 ? Math.round((nTp / (nTp + nFp)) * 1000) / 10 : null;
    const naiveRecall = (nTp + nFn) > 0 ? Math.round((nTp / (nTp + nFn)) * 1000) / 10 : null;

    // Risk Score's own precision/recall/false-positive/false-negative
    // rates, computed ONLY over years where the score was actually
    // available — years it couldn't be computed for are excluded, not
    // counted as failures.
    const rsRows = results.filter(r => r.riskScorePredictedElevated !== null);
    let riskScoreMetrics = null;
    if (rsRows.length > 0) {
        const rsTp = rsRows.filter(r => r.riskScorePredictedElevated && r.actualElevated).length;
        const rsFp = rsRows.filter(r => r.riskScorePredictedElevated && !r.actualElevated).length;
        const rsFn = rsRows.filter(r => !r.riskScorePredictedElevated && r.actualElevated).length;
        const rsTn = rsRows.filter(r => !r.riskScorePredictedElevated && !r.actualElevated).length;
        riskScoreMetrics = {
            precision: (rsTp + rsFp) > 0 ? Math.round((rsTp / (rsTp + rsFp)) * 1000) / 10 : null,
            recall: (rsTp + rsFn) > 0 ? Math.round((rsTp / (rsTp + rsFn)) * 1000) / 10 : null,
            falsePositiveRate: (rsFp + rsTn) > 0 ? Math.round((rsFp / (rsFp + rsTn)) * 1000) / 10 : null,
            falseNegativeRate: (rsFn + rsTp) > 0 ? Math.round((rsFn / (rsFn + rsTp)) * 1000) / 10 : null,
            yearsTested: rsRows.length
        };
    }

    return {
        results,
        hitRate: Math.round(hitRate * 1000) / 10, // percent, 1 decimal — this IS the interval calibration rate
        modelMAE: Math.round(modelMAE * 100) / 100,
        naiveMAE: Math.round(naiveMAE * 100) / 100,
        modelRMSE: Math.round(modelRMSE * 100) / 100,
        naiveRMSE: Math.round(naiveRMSE * 100) / 100,
        beatsNaive: modelMAE < naiveMAE,
        precision, recall, naivePrecision, naiveRecall,
        truePositives: tp, falsePositives: fp, falseNegatives: fn,
        riskScoreMetrics,
        yearsTested: results.length
    };
}

// =====================================================================
// MODEL A REDESIGN — shrinkage/blending layer
//
// NHIRA forecast = weight * statistical model + (1 - weight) * naive
// baseline. The weight is NOT chosen because a value "looks right" —
// it's selected using a walk-forward split of the backtest years:
//
//   - Training window (earlier ~70% of backtested years): try every
//     candidate weight from 0% to 100% model, in 10% steps, and pick
//     whichever minimizes MAE on THIS window only.
//   - Held-out window (remaining ~30%, always the MOST RECENT years):
//     apply the weight chosen from training and report how it
//     actually did — this is the honest out-of-sample check. The
//     weight is never chosen using the held-out window itself, which
//     is exactly what "don't fit the model to the future" means here.
//
// Needs a reasonable number of backtested years to split meaningfully;
// returns null rather than a low-confidence result if there isn't
// enough.
// =====================================================================

const BLEND_WEIGHT_CANDIDATES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const MIN_YEARS_FOR_BLEND_TUNING = 6;

function maeForWeight(window, weight) {
    const errors = window.map(r => {
        const blended = weight * r.predictedCentral + (1 - weight) * r.naiveBaseline;
        return Math.abs(blended - r.actual);
    });
    return errors.reduce((a, b) => a + b, 0) / errors.length;
}

function tuneShrinkageWeight(backtestResults) {
    if (!backtestResults || backtestResults.length < MIN_YEARS_FOR_BLEND_TUNING) return null;

    // Chronological split — training window is the EARLIER years,
    // held-out is the LATER years, so "held-out" genuinely means
    // "years the weight-selection step never saw."
    const splitIndex = Math.max(3, Math.floor(backtestResults.length * 0.7));
    const trainWindow = backtestResults.slice(0, splitIndex);
    const testWindow = backtestResults.slice(splitIndex);
    if (trainWindow.length < 3 || testWindow.length < 2) return null;

    const weightResults = BLEND_WEIGHT_CANDIDATES.map(w => ({
        weight: w,
        trainMAE: Math.round(maeForWeight(trainWindow, w) * 100) / 100
    }));

    const chosen = weightResults.reduce((best, r) => (r.trainMAE < best.trainMAE ? r : best), weightResults[0]);

    const testMAE = Math.round(maeForWeight(testWindow, chosen.weight) * 100) / 100;
    const testNaiveMAE = Math.round(maeForWeight(testWindow, 0) * 100) / 100;
    const testModelMAE = Math.round(maeForWeight(testWindow, 1) * 100) / 100;

    return {
        chosenWeight: chosen.weight,
        trainMAE: chosen.trainMAE,
        testMAE, testNaiveMAE, testModelMAE,
        trainYears: trainWindow.length,
        testYears: testWindow.length,
        beatsNaiveOnTest: testMAE < testNaiveMAE,
        weightResults
    };
}

// Empirical prediction interval — once enough backtested years exist,
// use the ACTUAL historical residuals (actual - predicted) instead of
// the heuristic sqrt(variance) margin. This is what lets NHIRA state a
// real percentage ("90% prediction interval") rather than an
// unlabeled range: the interval is built FROM observed forecast
// errors, so its stated coverage means something. Below the minimum
// sample size, this returns null and the caller falls back to the
// heuristic margin — honestly labeled as not tied to a stated
// percentage, because with too few points a claimed percentage
// wouldn't be trustworthy.
const MIN_RESIDUALS_FOR_EMPIRICAL_INTERVAL = 6;

function quantile(sortedArr, p) {
    const idx = p * (sortedArr.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sortedArr[lo];
    return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

function computeEmpiricalPredictionInterval(backtestResults, centralEstimate, coverage) {
    if (!backtestResults || backtestResults.length < MIN_RESIDUALS_FOR_EMPIRICAL_INTERVAL) return null;

    const residuals = backtestResults.map(r => r.actual - r.predictedCentral).sort((a, b) => a - b);
    const tail = (1 - coverage) / 2;
    const lowerResidual = quantile(residuals, tail);
    const upperResidual = quantile(residuals, 1 - tail);

    return {
        low: Math.max(0, Math.round(centralEstimate + lowerResidual)),
        high: Math.round(centralEstimate + upperResidual),
        coveragePct: Math.round(coverage * 100),
        nResiduals: residuals.length,
        provisional: residuals.length < 15 // technically valid, but a small sample — say so
    };
}

// =====================================================================
// PREDICTION INTERVAL CALIBRATION — genuinely out-of-sample
//
// "Historical 80% prediction intervals contained the actual outcome
// 78% of the time" is only a meaningful claim if the interval was
// built WITHOUT looking at the years it's being checked against.
// Building an interval from residuals and then checking its coverage
// on those SAME residuals is circular — it will always look well
// calibrated. This uses the same walk-forward split as
// tuneShrinkageWeight: build the interval from the training years
// only, then check coverage on the held-out years the interval-
// building step never saw.
// =====================================================================

function computeIntervalCalibration(backtestResults, coverage) {
    if (!backtestResults || backtestResults.length < MIN_YEARS_FOR_BLEND_TUNING) return null;

    const splitIndex = Math.max(3, Math.floor(backtestResults.length * 0.7));
    const trainWindow = backtestResults.slice(0, splitIndex);
    const testWindow = backtestResults.slice(splitIndex);
    if (trainWindow.length < 3 || testWindow.length < 2) return null;

    const trainResiduals = trainWindow.map(r => r.actual - r.predictedCentral).sort((a, b) => a - b);
    const tail = (1 - coverage) / 2;
    const lowerResidual = quantile(trainResiduals, tail);
    const upperResidual = quantile(trainResiduals, 1 - tail);

    // Apply the TRAINING-derived residual band to each held-out year's
    // OWN central prediction, then check whether that year's actual
    // fell inside it. The interval shape comes only from training years;
    // it is never refit or peeked at using the held-out years.
    const covered = testWindow.filter(r => {
        const low = r.predictedCentral + lowerResidual;
        const high = r.predictedCentral + upperResidual;
        return r.actual >= low && r.actual <= high;
    }).length;

    return {
        coveragePct: Math.round(coverage * 100),
        actualCoveragePct: Math.round((covered / testWindow.length) * 1000) / 10,
        trainYears: trainWindow.length,
        testYears: testWindow.length,
        verdict: (covered / testWindow.length) < coverage - 0.15 ? "overconfident"
            : (covered / testWindow.length) > coverage + 0.15 ? "unnecessarily wide"
            : "reasonably calibrated"
    };
}

// Dynamic, honest status wording keyed to REAL computed numbers for
// this country, never a hardcoded universal claim. Model A (count
// forecast) and Model B (elevated-year detector) get separate
// verdicts because they can — and currently do — perform differently.
function modelAStatus(backtest) {
    if (!backtest || backtest.insufficientData) {
        return { level: "gray", label: "NOT YET TESTED", text: "Run a backtest to see how this country's count forecast has performed historically." };
    }
    if (backtest.beatsNaive) {
        return {
            level: "green",
            label: "BEATS NAIVE BASELINE",
            text: `Model A's incident-count forecast outperformed a simple prior-year baseline in backtesting (model MAE ${backtest.modelMAE} vs. naive MAE ${backtest.naiveMAE}).`
        };
    }
    return {
        level: "yellow",
        label: "EXPERIMENTAL — OUTPERFORMED BY NAIVE COUNT BASELINE",
        text: `Model A's numerical incident-count forecast has not yet outperformed a simple prior-year baseline (model MAE ${backtest.modelMAE} vs. naive MAE ${backtest.naiveMAE}). Treat the count estimate as experimental until this changes.`
    };
}

function modelBStatus(backtest) {
    if (!backtest || backtest.insufficientData) {
        return { level: "gray", label: "NOT YET TESTED", text: "Run a backtest to see how this country's elevated-year detection has performed historically." };
    }
    if (backtest.recall === null) {
        return { level: "gray", label: "NOT ENOUGH ELEVATED YEARS TO TEST", text: "No actually-elevated years occurred in the backtested window for this country, so recall can't be computed yet." };
    }
    const level = backtest.recall >= 70 ? "green" : backtest.recall >= 40 ? "yellow" : "red";
    return {
        level,
        label: `RECALL: ${backtest.recall}%`,
        text: `NHIRA identifies elevated years with ${backtest.recall}% recall${backtest.precision !== null ? ` and ${backtest.precision}% precision` : ""} in backtesting for this country — this is Model B's job, and is evaluated separately from Model A's numeric count accuracy above.`
    };
}

function forecastValidationSummary(backtest) {
    if (!backtest) return "Not yet established — run a backtest below";
    if (backtest.insufficientData) return `Not yet possible — only ${backtest.yearsAvailable} year(s) of data (need at least ${MIN_BACKTEST_TRAIN_YEARS + 2})`;
    return `${backtest.hitRate}% hit rate over ${backtest.yearsTested} year${backtest.yearsTested === 1 ? "" : "s"} — model MAE ${backtest.modelMAE} vs. naive MAE ${backtest.naiveMAE} (${backtest.beatsNaive ? "beats" : "does not beat"} the naive baseline)`;
}

function renderBacktestTable(backtest) {
    if (backtest.insufficientData) {
        return `<p class="dq-empty">Not enough historical years to backtest yet — ${backtest.yearsAvailable} year(s) available, need at least ${MIN_BACKTEST_TRAIN_YEARS + 2}.</p>`;
    }

    const rows = backtest.results.map(r => `
        <tr class="${r.hit ? "backtest-hit" : "backtest-miss"}">
            <td>${r.forecastYear}</td>
            <td>${r.predictedCentral} <span class="backtest-range">(${r.predictedLow}–${r.predictedHigh})</span></td>
            <td>${r.actual}</td>
            <td>${r.modelError.toFixed(1)}</td>
            <td>${r.hit ? "In range" : "Out of range"}</td>
        </tr>
    `).join("");

    return `
        <p class="chart-title">Summary — Model A</p>
        <table class="backtest-table">
            <thead><tr><th>Metric</th><th>Result</th></tr></thead>
            <tbody>
                <tr><td>Backtests completed</td><td>${backtest.yearsTested} year${backtest.yearsTested === 1 ? "" : "s"}</td></tr>
                <tr><td>Forecast accuracy (beats naive baseline?)</td><td>${backtest.beatsNaive ? "Yes" : "No"}</td></tr>
                <tr><td>Mean absolute error</td><td>${backtest.modelMAE} <span class="backtest-range">(naive: ${backtest.naiveMAE})</span></td></tr>
                <tr><td>Root mean squared error</td><td>${backtest.modelRMSE} <span class="backtest-range">(naive: ${backtest.naiveRMSE})</span></td></tr>
                <tr><td>Within prediction interval (calibration)</td><td>${backtest.hitRate}%</td></tr>
                <tr><td>Elevated-year detection — precision</td><td>${backtest.precision === null ? "Not computable" : `${backtest.precision}%`} <span class="backtest-range">(naive: ${backtest.naivePrecision === null ? "n/a" : backtest.naivePrecision + "%"})</span></td></tr>
                <tr><td>Elevated-year detection — recall</td><td>${backtest.recall === null ? "Not computable" : `${backtest.recall}%`} <span class="backtest-range">(naive: ${backtest.naiveRecall === null ? "n/a" : backtest.naiveRecall + "%"})</span></td></tr>
                <tr><td>False positives</td><td>${backtest.falsePositives} <span class="backtest-range">of ${backtest.yearsTested} tested years</span></td></tr>
                <tr><td>False negatives</td><td>${backtest.falseNegatives} <span class="backtest-range">of ${backtest.yearsTested} tested years</span></td></tr>
            </tbody>
        </table>

        <p class="chart-title">Year-by-year detail</p>
        <table class="backtest-table">
            <thead>
                <tr><th>Forecast year</th><th>Predicted incidents</th><th>Actual</th><th>Error</th><th>Calibration</th></tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>

        <p class="chart-title">Prediction interval calibration (out-of-sample)</p>
        <p class="meta">
            Built from the earliest ~70% of backtested years only, then checked against the most recent ~30% — years
            the interval itself was never fit to. Checking calibration against the same years an interval was built
            from is circular and will always look well-calibrated; this doesn't do that.
        </p>
        <dl class="forecast-fields">
            ${[0.8, 0.9].map(cov => {
                const cal = computeIntervalCalibration(backtest.results, cov);
                const label = `${Math.round(cov * 100)}% prediction interval`;
                if (!cal) return `<dt>${label}</dt><dd>Not enough backtested years to check out-of-sample (need a training and a held-out period).</dd>`;
                return `
                    <dt>${label}</dt>
                    <dd>Contained the actual outcome in <b>${cal.actualCoveragePct}%</b> of ${cal.testYears} held-out year${cal.testYears === 1 ? "" : "s"}
                    (built from ${cal.trainYears} training years) — <b>${cal.verdict}</b>${
                        cal.verdict === "overconfident" ? " (narrower than it should be — actual outcomes fell outside it more often than the stated coverage implies)"
                        : cal.verdict === "unnecessarily wide" ? " (wider than it needs to be — actual outcomes almost always fell well inside it)"
                        : ""
                    }.</dd>
                `;
            }).join("")}
        </dl>

        <p class="chart-title">Model performance detail</p>
        <dl class="forecast-fields">
            <dt>Calibration (hit rate)</dt>
            <dd>${backtest.hitRate}% of actuals fell inside the model's prediction interval for that year. This is the heuristic interval's calibration — with ${backtest.yearsTested} backtested years now available, the live forecast above can use an empirical prediction interval built from these actual errors instead, which does carry a stated percentage.</dd>

            <dt>MAE (mean absolute error)</dt>
            <dd>Model: ${backtest.modelMAE} · Naive baseline (predict same as prior year): ${backtest.naiveMAE}</dd>

            <dt>RMSE (root mean squared error)</dt>
            <dd>Model: ${backtest.modelRMSE} · Naive baseline: ${backtest.naiveRMSE} — RMSE penalizes large misses more than MAE does</dd>

            <dt>Beats naive baseline?</dt>
            <dd>${backtest.beatsNaive ? "Yes" : "No"} — a model that can't outperform "predict the same as last year" isn't adding information</dd>

            <dt>Precision (elevated-year flagging)</dt>
            <dd>${backtest.precision === null ? "Not computable — the model never flagged an elevated year in this test window" : `${backtest.precision}% of years the model flagged as elevated actually were`}${backtest.naivePrecision !== null ? ` (naive persistence baseline: ${backtest.naivePrecision}%)` : ""}</dd>

            <dt>Recall (elevated-year flagging)</dt>
            <dd>${backtest.recall === null ? "Not computable — no actual elevated years occurred in this test window" : `${backtest.recall}% of actually-elevated years were correctly flagged in advance`}${backtest.naiveRecall !== null ? ` (naive persistence baseline: ${backtest.naiveRecall}%)` : ""}</dd>

            <dt>False positives / False negatives</dt>
            <dd>${backtest.falsePositives} false positive${backtest.falsePositives === 1 ? "" : "s"}, ${backtest.falseNegatives} false negative${backtest.falseNegatives === 1 ? "" : "s"}, out of ${backtest.yearsTested} tested years</dd>
        </dl>

        <p class="chart-title">NHIRA Risk Score performance (same backtest years)</p>
        <dl class="forecast-fields">
            ${!backtest.riskScoreMetrics ? `
                <dt>Risk Score</dt><dd>Not available for any backtested year — insufficient factor data throughout the tested window.</dd>
            ` : `
                <dt>Precision</dt>
                <dd>${backtest.riskScoreMetrics.precision === null ? "Not computable" : `${backtest.riskScoreMetrics.precision}% of years flagged High/Very High actually were elevated`}</dd>

                <dt>Recall</dt>
                <dd>${backtest.riskScoreMetrics.recall === null ? "Not computable" : `${backtest.riskScoreMetrics.recall}% of actually-elevated years were flagged High/Very High in advance`}</dd>

                <dt>False positive rate</dt>
                <dd>${backtest.riskScoreMetrics.falsePositiveRate === null ? "Not computable" : `${backtest.riskScoreMetrics.falsePositiveRate}% of non-elevated years were incorrectly flagged High/Very High`}</dd>

                <dt>False negative rate</dt>
                <dd>${backtest.riskScoreMetrics.falseNegativeRate === null ? "Not computable" : `${backtest.riskScoreMetrics.falseNegativeRate}% of actually-elevated years were missed`}</dd>

                <dt>Years tested</dt>
                <dd>${backtest.riskScoreMetrics.yearsTested} of ${backtest.yearsTested} backtested years had enough data to compute a Risk Score</dd>
            `}
        </dl>

        <p class="review-criteria-note">
            Every row above was trained ONLY on data available before that forecast year — the model was never shown
            the year it was predicting. "Here is how NHIRA performed when it was not allowed to see the future."
        </p>
    `;
}

function renderBlendTuning(tuning) {
    if (!tuning) {
        return `<p class="dq-empty">Not enough backtested years yet to tune a model/naive blend weight (need at least ${MIN_YEARS_FOR_BLEND_TUNING}, split into a training and a held-out period).</p>`;
    }

    const rows = tuning.weightResults.map(r => `
        <tr class="${r.weight === tuning.chosenWeight ? "blend-chosen" : ""}">
            <td>${Math.round(r.weight * 100)}% model / ${Math.round((1 - r.weight) * 100)}% naive</td>
            <td>${r.trainMAE}</td>
            <td>${r.weight === tuning.chosenWeight ? "Chosen (lowest training MAE)" : ""}</td>
        </tr>
    `).join("");

    return `
        <h3 class="analysis-heading">Model A blend tuning</h3>
        <p class="meta">
            NHIRA forecast = weight × statistical model + (1 − weight) × naive baseline. Every candidate weight was
            tested on the ${tuning.trainYears} earliest backtested years only; none of them ever saw the most recent
            ${tuning.testYears} year${tuning.testYears === 1 ? "" : "s"} before a weight was chosen.
        </p>
        <table class="backtest-table">
            <thead><tr><th>Blend</th><th>Training MAE</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <p class="backtest-summary">
            Chosen weight: <b>${Math.round(tuning.chosenWeight * 100)}% model / ${Math.round((1 - tuning.chosenWeight) * 100)}% naive</b>.
            Applied to the ${tuning.testYears} held-out year${tuning.testYears === 1 ? "" : "s"} it never saw during selection:
            blended MAE <b>${tuning.testMAE}</b>, vs. pure naive <b>${tuning.testNaiveMAE}</b> and pure model <b>${tuning.testModelMAE}</b> on those same years.
            The tuned blend <b>${tuning.beatsNaiveOnTest ? "beats" : "does not beat"}</b> naive on data it was never fit to.
        </p>
        <p class="review-criteria-note">
            This is the honest number: a weight can always be found that fits the training years well, so the only
            evidence that matters is how it does on years it never saw. If it doesn't beat naive here, the blend
            isn't helping yet, regardless of how good it looked during selection.
        </p>
    `;
}

function renderForecast(country) {
    if (!fcOutput) return;

    if (!country) {
        fcOutput.innerHTML = `<p class="dq-empty">Select a country to generate a forecast.</p>`;
        return;
    }

    const result = computeForecast(country);
    if (!result) {
        fcOutput.innerHTML = `<p class="dq-empty">Not enough historical NHIRA records for ${escapeHtml(country)} to generate a forecast.</p>`;
        return;
    }

    const riskLabel = RISK_LABELS[result.riskTier];
    const cachedBacktest = backtestCache[country];
    const modelA = modelAStatus(cachedBacktest);
    const modelB = modelBStatus(cachedBacktest);

    const explainHtml = result.yoyContradictsTier ? `
        <div class="forecast-explain">
            <p class="forecast-explain-title">Why the forecast remains ${riskLabel.toLowerCase()}</p>
            <p>The recent-year change (${result.yoyChangePct > 0 ? "+" : ""}${result.yoyChangePct}% year-over-year) is only one component of the model. The classification also incorporates the longer historical trend (${result.trendLabel.toLowerCase()}) and the long-run country average (${result.baseline} incidents/year). A single year's change does not necessarily overcome a historically ${riskLabel.toLowerCase()} baseline.</p>
        </div>
    ` : "";

    const sign = n => (n >= 0 ? "+" : "") + n;

    // Prefer the empirical interval (built from real backtest residuals,
    // so it can honestly carry a stated percentage) once enough
    // backtested years exist; otherwise fall back to the heuristic
    // margin, labeled as exactly that — not tied to any percentage.
    const empiricalInterval = cachedBacktest && !cachedBacktest.insufficientData
        ? computeEmpiricalPredictionInterval(cachedBacktest.results, result.modelEstimate, 0.9)
        : null;
    const intervalLow = empiricalInterval ? empiricalInterval.low : result.estimateLow;
    const intervalHigh = empiricalInterval ? empiricalInterval.high : result.estimateHigh;
    const intervalLabel = empiricalInterval
        ? `${empiricalInterval.coveragePct}% prediction interval${empiricalInterval.provisional ? " (provisional — based on only " + empiricalInterval.nResiduals + " backtested years)" : ""}`
        : "Prediction interval (heuristic — not yet tied to a stated percentage; run a backtest below to establish one)";

    fcOutput.innerHTML = `
        <div class="forecast-header">
            <span class="risk-badge risk-${result.riskTier}">${riskLabel}</span>
            <h3>NHIRA statistical forecast: ${riskLabel.toLowerCase()} historical-activity category</h3>
            <p class="forecast-subhead">${escapeHtml(result.country)} · ${result.periodLabel}</p>
        </div>

        <h3 class="analysis-heading">NHIRA Research Risk Score</h3>
        <p class="meta">
            Current geographic risk relative to ${escapeHtml(country)}'s own historical baseline — a single explainable
            0–100 composite of the six weighted factors below, back-tested the same way as Models A and B.
        </p>
        ${renderRiskScore(country)}

        <h3 class="analysis-heading">Model A — Incident Count Forecast</h3>
        <p class="meta">Answers "how many incidents should we expect?"</p>
        <div class="model-status-badge model-status-${modelA.level}">
            <span class="model-status-label">${modelA.label}</span>
            <p>${modelA.text}</p>
        </div>

        <div class="forecast-blocks">
            <div class="forecast-block forecast-block-category">
                <p class="forecast-block-label">Historical activity category</p>
                <p class="forecast-block-value risk-${result.riskTier}">${riskLabel}</p>
            </div>
            <div class="forecast-block">
                <p class="forecast-block-label">Central estimate</p>
                <p class="forecast-block-value">${result.modelEstimate}<span class="forecast-block-unit"> incidents</span></p>
            </div>
            <div class="forecast-block">
                <p class="forecast-block-label">Prediction interval</p>
                <p class="forecast-block-value">${intervalLow}–${intervalHigh}</p>
            </div>
        </div>
        <p class="prediction-interval-note">
            <b>${intervalLabel}.</b> This range represents the model's estimated uncertainty for the 12-month forecast.
            It is not a guarantee, and the low/high ends are not promised minimum or maximum outcomes.
        </p>

        <div id="fcBlendOutput"></div>

        <h3 class="analysis-heading">Model B — Elevated-Year Detector</h3>
        <p class="meta">Answers "is the upcoming year likely to be unusually elevated?" — a separate, binary question from Model A's count.</p>
        <div class="model-status-badge model-status-${modelB.level}">
            <span class="model-status-label">${modelB.label}</span>
            <p>${modelB.text}</p>
        </div>

        <dl class="forecast-fields">
            <dt>Data confidence</dt><dd>${result.dataConfidence}</dd>
            <dt>Forecast validation</dt><dd id="fcValidationValue">${forecastValidationSummary(cachedBacktest)}</dd>
            <dt>Data coverage</dt><dd>${result.dataCoverage}</dd>
        </dl>

        <div class="forecast-explain">
            <p class="forecast-explain-title">12-month incident probability</p>
            <p>
                <b>${result.incidentProbability12mo}%</b> probability of at least one incident in the next 12 months,
                based on a Poisson approximation from NHIRA's model-adjusted expected rate (${result.modelAdjustedRate}
                incidents/year — the exact same number shown as the central estimate below, not a separate calculation).
                This is a statistical estimate derived from historical patterns — not a prediction about a specific
                person, target, or event, and its own calibration (whether "70% probability" years actually see an
                incident about 70% of the time) has not itself been backtested. The count-based backtest below tests
                a related but different claim.
            </p>
        </div>

        <p class="chart-title">Trend across time windows</p>
        <table class="backtest-table">
            <thead><tr><th>Window</th><th>Trend</th><th>Years of data</th></tr></thead>
            <tbody>
                ${[1, 3, 5, 10, 30].map(w => `
                    <tr>
                        <td>${w}-year</td>
                        <td>${result.multiWindowTrend[w].label}</td>
                        <td>${result.multiWindowTrend[w].yearsOfData}</td>
                    </tr>
                `).join("")}
            </tbody>
        </table>

        <dl class="forecast-fields">
            <dt>Acceleration</dt>
            <dd>${result.acceleration.label}${result.acceleration.delta !== undefined ? ` (change in trend slope: ${sign(result.acceleration.delta)} incidents/year²)` : ""} — detects a change in the STEEPNESS of the trend between the earlier and later half of the data window. A sudden one-time step up or down in level (rather than a gradually steepening trend) shows up in "Recent-rate adjustment" above instead, not here — the two metrics catch different shapes of change.</dd>

            <dt>Time since last recorded incident</dt>
            <dd>${result.timeSinceLastIncidentDays === null ? "No dated incidents on file" : `${result.timeSinceLastIncidentDays.toLocaleString()} days`}</dd>

            <dt>Geographic concentration</dt>
            <dd>${result.geographicConcentration
                ? `${result.geographicConcentration.sharePct}% of this country's incidents are concentrated in ${escapeHtml(result.geographicConcentration.label)}`
                : "Insufficient state/province data to compute"}</dd>
        </dl>

        <p class="chart-title">Forecast components — three explicitly distinct numbers</p>
        <table class="forecast-components">
            <tbody>
                <tr><td>Historical annual rate <span class="backtest-range">(unadjusted long-run average)</span></td><td>${result.historicalAnnualRate}</td></tr>
                <tr><td>+ Trend adjustment</td><td>${sign(result.trendAdjustment)}</td></tr>
                <tr><td>+ Recent-rate adjustment <span class="backtest-range">(shrunk ${Math.round(RECENT_RATE_SHRINKAGE * 100)}%)</span></td><td>${sign(result.recentRateAdjustment)}</td></tr>
                <tr class="forecast-components-total"><td>= Model-adjusted expected rate</td><td>${result.modelAdjustedRate}</td></tr>
                <tr class="forecast-components-total"><td>Forecast central estimate <span class="backtest-range">(same number — no further adjustment)</span></td><td>${result.modelEstimate}</td></tr>
                <tr><td>Prediction interval</td><td>${result.estimateLow}–${result.estimateHigh} <span class="backtest-range">(heuristic — see Model A above for the possibly-refined empirical interval)</span></td></tr>
            </tbody>
        </table>
        <p class="review-criteria-note">
            Seasonal context (informational — NOT included in the estimate above): upcoming months are historically
            <b>${result.seasonalityLabel.toLowerCase()}</b> for ${escapeHtml(country)}. Earlier versions of this panel folded a
            seasonal nudge into the central estimate as a fourth silent adjustment, which is exactly how the same number
            ended up displayed two different ways in different sections. There is now only one model-adjusted rate; this
            note is descriptive context sitting next to it, not a hidden contributor to it.
        </p>

        <p class="chart-title">Primary contributing factors</p>
        <ul class="forecast-factors">
            <li>Long-term incident trend (${result.trendLabel.toLowerCase()} over ${result.yearsOfData} year${result.yearsOfData === 1 ? "" : "s"} of data)</li>
            <li>Recent incident frequency${result.yoyChangePct === null ? "" : ` (${result.yoyChangePct > 0 ? "+" : ""}${result.yoyChangePct}% year-over-year)`}</li>
            <li>Seasonal pattern (${result.seasonalityLabel.toLowerCase()})</li>
            <li>Regional historical rate (${result.baseline} incidents/year long-run average)</li>
            <li>Population-adjusted rate — not available (no population dataset integrated yet)</li>
        </ul>

        ${explainHtml}

        <p class="forecast-disclaimer">
            This is a statistical risk category based on historical patterns in NHIRA's current dataset —
            not a prediction that an incident will occur. It has not yet been backtested against real outcomes.
        </p>

        <button id="fcMethodologyToggle" class="methodology-toggle" type="button" aria-expanded="false">
            How is this forecast calculated?
        </button>
        <div id="fcMethodologyBody" class="methodology-body" hidden>
            <dl>
                <dt>Long-run baseline</dt>
                <dd>${result.baseline} incidents/year</dd>

                <dt>Long-term trend</dt>
                <dd>${result.trendLabel} (adjustment: ${sign(result.trendAdjustment)})</dd>

                <dt>Recent activity</dt>
                <dd>${result.yoyChangePct === null ? "Not enough consecutive years to compute" : `${result.yoyChangePct > 0 ? "+" : ""}${result.yoyChangePct}% YoY`} (adjustment: ${sign(result.recentRateAdjustment)})</dd>

                <dt>Seasonality</dt>
                <dd>${result.seasonalityLabel} — informational context only; not included in the central estimate (see "Forecast components" above)</dd>

                <dt>Overdispersion</dt>
                <dd>${result.dispersionRatio} (variance-to-mean ratio — a value noticeably above 1 indicates overdispersion, which is why negative-binomial, rather than plain Poisson, is the better candidate once real regression is built)</dd>

                <dt>Population rate</dt>
                <dd>Not available — no population dataset integrated yet</dd>

                <dt>Source definition consistency</dt>
                <dd>${definitionConsistencyHtml(events.filter(e => e.country === country), country) || "No records to check."}</dd>

                <dt>Forecast method</dt>
                <dd>Descriptive V1 — historical annual rate + trend adjustment + shrunk recent-rate adjustment = model-adjusted expected rate = forecast central estimate (one formula, used identically for the live display, the 12-month probability, and the backtest below), with an uncertainty band from this country's own year-to-year variance. Seasonality is reported as separate context, not folded into the number. Not a fitted Poisson/negative-binomial regression, random forest, or gradient boosting model — those require server-side fitting and validation, not client-side approximation.</dd>

                <dt>Backtesting</dt>
                <dd>${backtestCache[country] ? forecastValidationSummary(backtestCache[country]) : 'Not yet completed for this country. Forecast validation stays "Not yet established" until run — see the Backtest section below.'}</dd>

                <dt>Data used</dt>
                <dd>${result.yearsOfData} year${result.yearsOfData === 1 ? "" : "s"} of data, ${result.totalInWindow} incident${result.totalInWindow === 1 ? "" : "s"} in the window used for this forecast.</dd>
            </dl>
        </div>

        <h3 class="analysis-heading">Backtest this model</h3>
        <p class="meta">
            Rolling-origin validation: for each past year, the model is trained ONLY on data before that year, then
            checked against what actually happened. This is the objective test of whether the forecast has real
            predictive value, not just plausible-looking numbers.
        </p>
        <button id="fcBacktestBtn" type="button" class="backtest-run-btn">Run backtest for ${escapeHtml(country)}</button>
        <div id="fcBacktestOutput">${backtestCache[country] ? renderBacktestTable(backtestCache[country]) : ""}</div>
    `;

    const fcBacktestBtn = document.getElementById("fcBacktestBtn");
    const fcBacktestOutput = document.getElementById("fcBacktestOutput");
    const fcBlendOutput = document.getElementById("fcBlendOutput");

    if (fcBlendOutput) {
        fcBlendOutput.innerHTML = cachedBacktest && !cachedBacktest.insufficientData
            ? renderBlendTuning(tuneShrinkageWeight(cachedBacktest.results))
            : "";
    }

    if (fcBacktestBtn && fcBacktestOutput) {
        fcBacktestBtn.addEventListener("click", () => {
            const backtest = computeBacktest(country);
            backtestCache[country] = backtest;
            // Re-render the whole panel rather than patching pieces —
            // the status badges, prediction interval, and blend table
            // all depend on this result together, and patching them
            // separately risks them drifting out of sync with each other.
            renderForecast(country);
        });
    }

    const fcMethodologyToggle = document.getElementById("fcMethodologyToggle");
    const fcMethodologyBody = document.getElementById("fcMethodologyBody");
    if (fcMethodologyToggle && fcMethodologyBody) {
        fcMethodologyToggle.addEventListener("click", () => {
            const open = fcMethodologyBody.hidden;
            fcMethodologyBody.hidden = !open;
            fcMethodologyToggle.setAttribute("aria-expanded", String(open));
        });
    }
}

// --- Forecast risk overlay on the map (approximate — country centroid) ---

function countryCentroids() {
    const groups = {};
    events.forEach(e => {
        if (!e.country || !Number.isFinite(e.lat) || !Number.isFinite(e.lng)) return;
        if (!groups[e.country]) groups[e.country] = { latSum: 0, lngSum: 0, n: 0 };
        groups[e.country].latSum += e.lat;
        groups[e.country].lngSum += e.lng;
        groups[e.country].n++;
    });
    const centroids = {};
    Object.entries(groups).forEach(([country, g]) => {
        centroids[country] = { lat: g.latSum / g.n, lng: g.lngSum / g.n };
    });
    return centroids;
}

// A small always-visible map control that labels what the colored
// circles mean, so a viewer can't mistake a model output for a count
// of actual incidents. Only shown while the forecast overlay is on.
const forecastLegendControl = L.control({ position: "bottomleft" });
forecastLegendControl.onAdd = function () {
    const div = L.DomUtil.create("div", "forecast-map-legend");
    div.innerHTML = `
        <p class="forecast-map-legend-title">Historical activity index (model output)</p>
        <p class="forecast-map-legend-note">Dashed outline = statistical classification, not an observed incident count.</p>
    `;
    return div;
};

function renderForecastMapOverlay() {
    forecastLayer.clearLayers();
    const centroids = countryCentroids();
    Object.keys(centroids).forEach(country => {
        const result = computeForecast(country);
        if (!result) return;
        const c = centroids[country];
        // Dashed border + lower opacity distinguishes this from the
        // solid, undashed incident markers drawn by addMarker().
        L.circleMarker([c.lat, c.lng], {
            radius: 16,
            color: "#0E1116",
            weight: 2,
            dashArray: "4,3",
            fillColor: RISK_COLORS[result.riskTier],
            fillOpacity: 0.55
        })
            .bindTooltip(
                `NHIRA historical-activity index for ${country}: ${RISK_LABELS[result.riskTier]} (model output, not an incident count)`,
                { direction: "top" }
            )
            .addTo(forecastLayer);
    });
}

function populateForecastCountries() {
    if (!FORECAST_ELEMENTS_PRESENT) return;
    const countries = [...new Set(events.map(e => e.country).filter(Boolean))].sort();
    fcCountry.innerHTML = '<option value="">Select a country…</option>' +
        countries.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
}

function openForecastPanel() {
    forecastPanel.classList.add("open");
    forecastPanel.setAttribute("aria-hidden", "false");
    forecastToggle.setAttribute("aria-expanded", "true");
    if (RESEARCH_ELEMENTS_PRESENT) closeStatsPanel();
    if (REVIEW_ELEMENTS_PRESENT) closeReviewPanel();
    if (window.innerWidth < DUAL_PANEL_MIN_WIDTH) sidePanel.classList.remove("open");
    if (window.innerWidth < 760) scrim.hidden = false;
}

function closeForecastPanel() {
    forecastPanel.classList.remove("open");
    forecastPanel.setAttribute("aria-hidden", "true");
    forecastToggle.setAttribute("aria-expanded", "false");
    scrim.hidden = true;
}

if (FORECAST_ELEMENTS_PRESENT) {
    forecastToggle.addEventListener("click", () => {
        if (forecastPanel.classList.contains("open")) {
            closeForecastPanel();
        } else {
            openForecastPanel();
        }
    });

    closeForecast.addEventListener("click", closeForecastPanel);

    fcGenerateBtn.addEventListener("click", () => renderForecast(fcCountry.value));
    fcCountry.addEventListener("change", () => renderForecast(fcCountry.value));
} else {
    console.warn("Forecast controls not found in the DOM — skipping their setup so the rest of the app still loads.");
}

// ---------------------------------------------------------------------
// Map modes — Observed / Context / Forecast
//
// Observed (default): only actual historical incident markers and hot
// zone rings — nothing model-derived, nothing highlighted.
// Context: Observed, plus rings around whatever incidents appeared in
// the currently open incident's Research Context — only active while
// an incident panel is open.
// Forecast: Observed, plus the forecast risk overlay (off by default,
// so nobody mistakes a model output for an actual incident count).
// ---------------------------------------------------------------------

let mapMode = "observed";
let currentOpenEvent = null;

function renderContextHighlightLayer() {
    contextLayer.clearLayers();
    if (!currentOpenEvent) return;

    const { nearby, sameDate, sameYear, surrounding, subsequent } = buildResearchContext(currentOpenEvent);
    const related = [
        ...nearby.map(x => x.event),
        ...sameDate,
        ...sameYear,
        ...surrounding.map(x => x.event),
        ...subsequent
    ];

    related.forEach(e => {
        if (!Number.isFinite(e.lat) || !Number.isFinite(e.lng)) return;
        L.circleMarker([e.lat, e.lng], {
            radius: 12,
            color: "#F0A202",
            weight: 2,
            dashArray: "3,3",
            fillOpacity: 0
        })
            .bindTooltip(`Related to "${currentOpenEvent.title}" (Research Context)`, { direction: "top" })
            .addTo(contextLayer);
    });

    if (Number.isFinite(currentOpenEvent.lat) && Number.isFinite(currentOpenEvent.lng)) {
        L.circleMarker([currentOpenEvent.lat, currentOpenEvent.lng], {
            radius: 18,
            color: "#F0A202",
            weight: 3,
            fillOpacity: 0
        }).addTo(contextLayer);
    }
}

function setMapMode(mode) {
    mapMode = mode;
    mapModeButtons.forEach(btn => btn.classList.toggle("active", btn.dataset.mode === mode));

    if (mapMode === "forecast" && FORECAST_ELEMENTS_PRESENT) {
        renderForecastMapOverlay();
        if (!map.hasLayer(forecastLayer)) map.addLayer(forecastLayer);
        forecastLegendControl.addTo(map);
    } else {
        if (map.hasLayer(forecastLayer)) map.removeLayer(forecastLayer);
        map.removeControl(forecastLegendControl);
    }

    if (mapMode === "context") {
        renderContextHighlightLayer();
        if (!map.hasLayer(contextLayer)) map.addLayer(contextLayer);
    } else {
        if (map.hasLayer(contextLayer)) map.removeLayer(contextLayer);
    }
}

mapModeButtons.forEach(btn => {
    btn.addEventListener("click", () => setMapMode(btn.dataset.mode));
});

// =====================================================================
// PENDING VERIFICATION
//
// Full pipeline: Source -> automatic detection -> candidate record ->
// Pending Verification -> human review -> history.json ->
// map/statistics/forecast. The collector (see collector.js) produces
// candidates in this exact schema and writes them to pending.json (or
// a backend the collector posts to) — nothing it produces is ever
// auto-published. A human must Approve before anything reaches
// history.json.
//
// Each candidate carries these fields (spec, in order):
//   source            outlet/feed name
//   sourceUrl         link to the original report
//   detectedDate      when NHIRA's collector found it
//   incidentDate      when the incident itself occurred
//   country, state, city
//   title             candidate incident title
//   category          candidate category (Mass Shooting, etc.)
//   fatalities, injuries
//   confidence        0-1 extraction confidence (NOT source confidence
//                      — that is a human judgment made at approval time)
//   duplicateMatch    { status, matchedId, note }
//   verificationStatus UNVERIFIED | NEEDS_RESEARCH | VERIFIED
//                      | REJECTED | EXPIRED
//   reviewedBy, reviewedDate
//
// Plus operational extras a usable incident record still needs but
// weren't in the field spec: venue, lat, lng, description,
// locationPrecision, expirationTime. These aren't optional in
// practice — a record with no coordinates can't be mapped — so the
// collector still captures them; they just aren't primary review
// fields.
//
// Only UNVERIFIED / NEEDS_RESEARCH candidates can go stale.
// verificationStatus of VERIFIED or REJECTED is a permanent human
// decision and is never overwritten by expiration.
// =====================================================================

const REVIEW_STATUSES = ["UNVERIFIED", "NEEDS_RESEARCH", "VERIFIED", "REJECTED", "EXPIRED"];

let pendingCandidates = [];
let currentReviewerName = "";

function effectiveStatus(candidate) {
    const status = String(candidate?.verificationStatus || "UNVERIFIED").toUpperCase();
    if (!REVIEW_STATUSES.includes(status)) return "UNVERIFIED";

    if (status === "UNVERIFIED" || status === "NEEDS_RESEARCH") {
        const expiry = candidate?.expirationTime;
        if (expiry) {
            const t = new Date(expiry);
            if (!Number.isNaN(t.getTime()) && t.getTime() < Date.now()) return "EXPIRED";
        }
    }
    return status;
}

function confidenceLabel(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "Not scored";
    const pct = Math.round(n * 100);
    const band = n >= 0.75 ? "High" : n >= 0.5 ? "Moderate" : "Low";
    return `${band} (${pct}%)`;
}

function formatTimestamp(raw) {
    if (!raw) return "Not recorded";
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return escapeHtml(raw);
    return d.toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit"
    });
}

function formatDateOnly(raw) {
    if (!raw) return "Not recorded";
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return escapeHtml(raw);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function duplicateCheckHtml(dup) {
    if (!dup) return `<p class="review-dup dup-flag">Not checked</p>`;
    const statusKey = String(dup.status || "unknown").toLowerCase();
    const label = statusKey === "no-match" ? "No duplicate found"
        : statusKey === "possible-match" ? "Possible duplicate"
        : statusKey === "match" ? "Duplicate of existing record"
        : "Not checked";
    const cls = statusKey === "no-match" ? "dup-clear" : "dup-flag";
    const scoreHtml = Number.isFinite(dup.score)
        ? ` <span class="triage-score">duplicate_score: ${dup.score.toFixed(2)}</span>`
        : "";
    return `
        <p class="review-dup ${cls}">
            <b>${label}</b>${scoreHtml}${dup.matchedId ? ` — matches NHIRA record #${escapeHtml(dup.matchedId)}` : ""}
            ${dup.note ? `<br><span class="review-dup-note">${escapeHtml(dup.note)}</span>` : ""}
        </p>
    `;
}

// A compact, glanceable triage line — the two numeric scores a
// reviewer needs to decide "does this deserve my attention right
// now" without reading the full record first.
function renderTriageScores(c) {
    const dupScore = Number(c.duplicateMatch?.score);
    const srcConf = Number(c.sourceConfidence);
    if (!Number.isFinite(dupScore) && !Number.isFinite(srcConf)) return "";

    function band(n, highIsBad) {
        // For duplicate_score, high = more likely a duplicate = needs attention.
        // For source_confidence, high = more trustworthy = good.
        const bad = highIsBad ? n >= 0.75 : n < 0.5;
        const warn = highIsBad ? (n >= 0.45 && n < 0.75) : (n >= 0.5 && n < 0.75);
        return bad ? "triage-bad" : warn ? "triage-warn" : "triage-good";
    }

    return `
        <div class="triage-bar">
            ${Number.isFinite(dupScore) ? `<span class="triage-chip ${band(dupScore, true)}">duplicate_score: ${dupScore.toFixed(2)}</span>` : ""}
            ${Number.isFinite(srcConf) ? `<span class="triage-chip ${band(srcConf, false)}">source_confidence: ${srcConf.toFixed(2)}</span>` : ""}
        </div>
    `;
}

// Renders all candidate fields as a labeled grid — this is the
// reviewer-facing record of what the collector found and how it was
// evaluated, spec fields first, operational extras after.
function renderCandidateFields(c, status) {
    return `
        <dl class="signal-meta">
            <dt>Source</dt>
            <dd>${c.source ? escapeHtml(c.source) : "Not recorded"}</dd>

            <dt>Source URL</dt>
            <dd>${c.sourceUrl
                ? `<a href="${escapeHtml(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.sourceUrl)}</a>`
                : "Not recorded"}</dd>

            <dt>Detected date</dt>
            <dd>${formatTimestamp(c.detectedDate)}</dd>

            <dt>Incident date</dt>
            <dd>${formatDateOnly(c.incidentDate)}</dd>

            <dt>Country / State / City</dt>
            <dd>${[c.country, c.state, c.city].filter(Boolean).map(escapeHtml).join(" · ") || "Not extracted"}</dd>

            <dt>Candidate category</dt>
            <dd>${c.category ? escapeHtml(c.category) : "Not classified"}</dd>

            <dt>Extraction confidence</dt>
            <dd>${confidenceLabel(c.confidence)}</dd>

            <dt>Source confidence</dt>
            <dd>${Number.isFinite(Number(c.sourceConfidence)) ? `${confidenceLabel(c.sourceConfidence)} — how reliable this outlet has historically been, not how complete this extraction is` : "Not scored"}</dd>

            <dt>Duplicate score</dt>
            <dd>${Number.isFinite(Number(c.duplicateMatch?.score)) ? Number(c.duplicateMatch.score).toFixed(2) : "Not scored"} (0 = clearly unique, 1 = near-certain duplicate)</dd>

            <dt>Verification status</dt>
            <dd><span class="signal-status signal-${status.toLowerCase()}">${status.replace("_", " ")}</span></dd>

            <dt>Reviewed by</dt>
            <dd>${c.reviewedBy ? escapeHtml(c.reviewedBy) : "Not yet reviewed"}</dd>

            <dt>Reviewed date</dt>
            <dd>${c.reviewedDate ? formatTimestamp(c.reviewedDate) : "Not yet reviewed"}</dd>

            <dt>Location precision</dt>
            <dd>${PRECISION_LABELS[String(c.locationPrecision || "").toLowerCase()] || "Unknown"}</dd>

            <dt>Review expires</dt>
            <dd>${formatTimestamp(c.expirationTime)}${status === "EXPIRED" ? " — stale, still retained for review" : ""}</dd>
        </dl>
    `;
}

// Converts an approved candidate into a publishable history.json
// record, using the full provenance shape (not a flat URL string) so
// this source's specific fatality/injury figures and verification
// status are preserved as attributed facts rather than collapsed into
// the headline number. sourceConfidence here is derived from the
// collector's numeric score, not hardcoded — a genuinely low-confidence
// candidate should surface as needing review, not get a fake "medium".
function candidateToRecord(candidate) {
    const numericConf = Number(candidate.sourceConfidence);
    const sourceConfidence = numericConf >= 0.75 ? "high" : numericConf >= 0.5 ? "medium" : undefined;

    return {
        id: null, // assign on commit — see clean_history.py reassignment logic
        title: candidate.title,
        date: candidate.incidentDate,
        year: candidate.incidentDate ? Number(String(candidate.incidentDate).slice(0, 4)) : candidate.year,
        country: candidate.country,
        state: candidate.state,
        city: candidate.city,
        venue: candidate.venue,
        lat: candidate.lat,
        lng: candidate.lng,
        fatalities: candidate.fatalities,
        injuries: candidate.injuries,
        description: candidate.description,
        category: candidate.category,
        location_precision: candidate.locationPrecision || "unknown",
        sources: candidate.sourceUrl ? [{
            source: candidate.source || null,
            source_url: candidate.sourceUrl,
            source_date: candidate.detectedDate ? String(candidate.detectedDate).slice(0, 10) : null,
            source_type: candidate.sourceType || null,
            source_specific_fatalities: candidate.fatalities ?? null,
            source_specific_injuries: candidate.injuries ?? null,
            verification_status: "VERIFIED", // this source entry was human-approved to reach this point
            verified_date: candidate.reviewedDate || null
        }] : [],
        ...(sourceConfidence ? { sourceConfidence } : {}),
        sourceClassifications: candidate.sourceClassification
            ? [{ source: candidate.source || "Collector source", classification: candidate.sourceClassification }]
            : [],
        provenance: {
            ingestedVia: "automated-source-check",
            candidateId: candidate.candidateId,
            collectorSource: candidate.source || null,
            detectedDate: candidate.detectedDate || null,
            duplicateScore: Number.isFinite(Number(candidate.duplicateMatch?.score)) ? candidate.duplicateMatch.score : null,
            reviewedBy: candidate.reviewedBy || null,
            reviewedDate: candidate.reviewedDate || null
        }
    };
}

function refreshExportBox() {
    if (!rvExportWrap || !rvExport) return;
    const approved = pendingCandidates.filter(c => effectiveStatus(c) === "VERIFIED");
    if (!approved.length) {
        rvExportWrap.hidden = true;
        rvExport.value = "";
        return;
    }
    rvExportWrap.hidden = false;
    rvExport.value = JSON.stringify(approved.map(candidateToRecord), null, 2);
}

function setCandidateStatus(candidateId, newStatus) {
    const candidate = pendingCandidates.find(c => c.candidateId === candidateId);
    if (!candidate) return;

    candidate.verificationStatus = newStatus;
    candidate.reviewedBy = currentReviewerName.trim() || "Unspecified reviewer";
    candidate.reviewedDate = new Date().toISOString();

    // ---- BACKEND HOOK ----------------------------------------------
    // A static build cannot persist this. To make review decisions
    // write through to the real queue/database, PATCH here, e.g.:
    //
    //   fetch("/api/pending/" + candidateId, {
    //       method: "PATCH",
    //       headers: { "Content-Type": "application/json" },
    //       body: JSON.stringify({
    //           verificationStatus: newStatus,
    //           reviewedBy: candidate.reviewedBy,
    //           reviewedDate: candidate.reviewedDate
    //       })
    //   });
    //
    // On VERIFIED, the backend should also insert
    // candidateToRecord(candidate) into the incident database, then
    // let everything derived from it (map, stats, charts, forecast,
    // dataset coverage, last-updated) recalculate from that one write.
    // See collector.js for the matching write-side of this pipeline.
    // ----------------------------------------------------------------

    renderReviewQueue();
}

function renderReviewQueue() {
    if (!REVIEW_ELEMENTS_PRESENT) return;

    const counts = {};
    REVIEW_STATUSES.forEach(s => { counts[s] = 0; });
    pendingCandidates.forEach(c => { counts[effectiveStatus(c)]++; });

    rvSummary.innerHTML = `
        <div class="stat-card"><b>${counts.UNVERIFIED}</b><span>Unverified</span></div>
        <div class="stat-card"><b>${counts.NEEDS_RESEARCH}</b><span>Needs research</span></div>
        <div class="stat-card"><b>${counts.VERIFIED}</b><span>Verified</span></div>
        <div class="stat-card"><b>${counts.EXPIRED}</b><span>Expired</span></div>
    `;

    const filter = rvStatusFilter.value;
    const shown = pendingCandidates.filter(c => filter === "all" || effectiveStatus(c) === filter);

    if (!shown.length) {
        rvList.innerHTML = `<p class="dq-empty">No candidates match this filter. An empty queue means nothing has been ingested yet — not that no incidents occurred.</p>`;
        refreshExportBox();
        return;
    }

    rvList.innerHTML = shown.map(c => {
        const status = effectiveStatus(c);
        const place = [c.city, c.state, c.country].filter(Boolean).map(escapeHtml).join(", ");
        const decided = status === "VERIFIED" || status === "REJECTED";

        return `
            <div class="review-card review-card-${status.toLowerCase()}">
                <div class="review-card-head">
                    <span class="signal-status signal-${status.toLowerCase()}">${status.replace("_", " ")}</span>
                    ${c.category ? `<span class="review-category-badge">${escapeHtml(c.category)}</span>` : ""}
                    <h3>${escapeHtml(c.title || "Untitled candidate")}</h3>
                    <p class="review-card-meta">${formatDateOnly(c.incidentDate)} · ${place || "Location not extracted"}</p>
                    ${renderTriageScores(c)}
                </div>

                <div class="stats">
                    <div class="stat"><b>${escapeHtml(c.fatalities ?? "—")}</b><span>Fatalities</span></div>
                    <div class="stat"><b>${escapeHtml(c.injuries ?? "—")}</b><span>Injuries</span></div>
                </div>

                <p class="review-desc">${escapeHtml(c.description || "No description extracted.")}</p>

                ${duplicateCheckHtml(c.duplicateMatch)}

                ${Array.isArray(c.flaggedCriteria) && c.flaggedCriteria.length ? `
                    <p class="chart-title">Flagged against criteria</p>
                    <ul class="review-criteria">
                        ${c.flaggedCriteria.map(f => `<li>${escapeHtml(f)}</li>`).join("")}
                    </ul>
                    <p class="review-criteria-note">
                        These are automated flags only. NHIRA's final classification is made by the reviewer
                        after reading the underlying source.
                    </p>
                ` : ""}

                <p class="chart-title">Candidate record</p>
                ${renderCandidateFields(c, status)}

                <div class="review-actions">
                    <button type="button" class="rv-btn rv-approve" data-id="${escapeHtml(c.candidateId)}" data-action="VERIFIED" ${decided ? "disabled" : ""}>Approve</button>
                    <button type="button" class="rv-btn rv-research" data-id="${escapeHtml(c.candidateId)}" data-action="NEEDS_RESEARCH" ${decided ? "disabled" : ""}>Needs research</button>
                    <button type="button" class="rv-btn rv-reject" data-id="${escapeHtml(c.candidateId)}" data-action="REJECTED" ${decided ? "disabled" : ""}>Reject</button>
                </div>
            </div>
        `;
    }).join("");

    refreshExportBox();
}

function openReviewPanel() {
    reviewPanel.classList.add("open");
    reviewPanel.setAttribute("aria-hidden", "false");
    reviewToggle.setAttribute("aria-expanded", "true");
    if (RESEARCH_ELEMENTS_PRESENT) closeStatsPanel();
    if (FORECAST_ELEMENTS_PRESENT) closeForecastPanel();
    if (window.innerWidth < DUAL_PANEL_MIN_WIDTH) sidePanel.classList.remove("open");
    if (window.innerWidth < 760) scrim.hidden = false;
    renderReviewQueue();
}

function closeReviewPanel() {
    reviewPanel.classList.remove("open");
    reviewPanel.setAttribute("aria-hidden", "true");
    reviewToggle.setAttribute("aria-expanded", "false");
    scrim.hidden = true;
}

if (REVIEW_ELEMENTS_PRESENT) {
    fetch("pending.json")
        .then(r => (r.ok ? r.json() : []))
        .then(data => {
            pendingCandidates = Array.isArray(data) ? data : [];
            renderReviewQueue();
        })
        .catch(() => {
            // No pending.json deployed yet, or the collector hasn't run —
            // that's a valid state, not an error.
            pendingCandidates = [];
            renderReviewQueue();
        });

    reviewToggle.addEventListener("click", () => {
        if (reviewPanel.classList.contains("open")) {
            closeReviewPanel();
        } else {
            openReviewPanel();
        }
    });

    closeReview.addEventListener("click", closeReviewPanel);
    rvStatusFilter.addEventListener("change", renderReviewQueue);

    if (rvReviewerName) {
        rvReviewerName.addEventListener("input", () => {
            currentReviewerName = rvReviewerName.value;
        });
    }

    rvList.addEventListener("click", e => {
        const btn = e.target.closest(".rv-btn");
        if (!btn || btn.disabled) return;
        setCandidateStatus(btn.dataset.id, btn.dataset.action);
    });
} else {
    console.warn("Pending Verification controls not found in the DOM — skipping their setup so the rest of the app still loads.");
}


// =====================================================================
// GEOGRAPHIC RESOLUTION GATE
//
// HARD RULE: no city- or neighborhood-level model output may be
// displayed unless it passes minimum-data AND out-of-sample
// validation. A sparse dataset must never be allowed to render a
// convincing-looking but meaningless heat map.
//
// Out-of-sample validation is not implemented (it needs a backtesting
// harness), so validationPassed is permanently false in this build —
// which means city/neighborhood output is gated off by construction,
// not by a threshold that could accidentally be met.
// =====================================================================

const GEO_LEVEL_REQUIREMENTS = {
    country:      { minIncidents: 10, minYears: 5,  requiresValidation: false },
    state:        { minIncidents: 30, minYears: 10, requiresValidation: false },
    city:         { minIncidents: 50, minYears: 10, requiresValidation: true },
    neighborhood: { minIncidents: 200, minYears: 15, requiresValidation: true }
};

// Flips to true only when a real out-of-sample backtest exists and
// beats a naive baseline. Nothing in this build can set it.
const OUT_OF_SAMPLE_VALIDATION_PASSED = false;

function geoLevelAvailability(level, incidentCount, yearSpan) {
    const req = GEO_LEVEL_REQUIREMENTS[level];
    if (!req) return { allowed: false, reason: "Unknown geographic level." };

    if (incidentCount < req.minIncidents) {
        return {
            allowed: false,
            reason: `Insufficient data: ${incidentCount} record(s), minimum ${req.minIncidents} required at ${level} level.`
        };
    }
    if (yearSpan < req.minYears) {
        return {
            allowed: false,
            reason: `Insufficient time span: ${yearSpan} year(s), minimum ${req.minYears} required at ${level} level.`
        };
    }
    if (req.requiresValidation && !OUT_OF_SAMPLE_VALIDATION_PASSED) {
        return {
            allowed: false,
            reason: `${level.charAt(0).toUpperCase() + level.slice(1)}-level output requires out-of-sample validation, which has not yet been performed. Display is blocked by design.`
        };
    }
    return { allowed: true, reason: "" };
}

// ---------------------------------------------------------------------
// Play / Pause timeline
// ---------------------------------------------------------------------

function stopPlayback() {
    if (playTimer) {
        clearInterval(playTimer);
        playTimer = null;
    }
    playBtn.disabled = false;
    pauseBtn.disabled = true;
}

function startPlayback() {
    if (playTimer) return;
    if (Number(slider.value) >= MAX_YEAR) slider.value = MIN_YEAR;

    playBtn.disabled = true;
    pauseBtn.disabled = false;

    playTimer = setInterval(() => {
        const nextYear = Number(slider.value) + PLAY_STEP_YEARS;
        if (nextYear >= MAX_YEAR) {
            slider.value = MAX_YEAR;
            applyFilters();
            stopPlayback();
            return;
        }
        slider.value = nextYear;
        applyFilters();
    }, PLAY_STEP_MS);
}

playBtn.addEventListener("click", startPlayback);
pauseBtn.addEventListener("click", stopPlayback);
slider.addEventListener("pointerdown", stopPlayback);
pauseBtn.disabled = true;

if (nowBtn) {
    nowBtn.addEventListener("click", () => {
        stopPlayback();
        slider.value = Math.min(Math.max(THIS_YEAR, MIN_YEAR), MAX_YEAR);
        applyFilters();
    });
}

// ---------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------

function openSheet() {
    sidePanel.classList.add("open");
    sidePanel.setAttribute("aria-hidden", "false");
    if (RESEARCH_ELEMENTS_PRESENT && window.innerWidth < DUAL_PANEL_MIN_WIDTH) closeStatsPanel();
    if (FORECAST_ELEMENTS_PRESENT && window.innerWidth < DUAL_PANEL_MIN_WIDTH) closeForecastPanel();
    if (REVIEW_ELEMENTS_PRESENT && window.innerWidth < DUAL_PANEL_MIN_WIDTH) closeReviewPanel();
    if (window.innerWidth < 760) scrim.hidden = false;
    setTimeout(() => map.invalidateSize(), 300);
}

function closeSheet() {
    sidePanel.classList.remove("open");
    sidePanel.setAttribute("aria-hidden", "true");
    if (RESEARCH_ELEMENTS_PRESENT && window.innerWidth < DUAL_PANEL_MIN_WIDTH) closeStatsPanel();
    if (FORECAST_ELEMENTS_PRESENT && window.innerWidth < DUAL_PANEL_MIN_WIDTH) closeForecastPanel();
    if (REVIEW_ELEMENTS_PRESENT && window.innerWidth < DUAL_PANEL_MIN_WIDTH) closeReviewPanel();
    scrim.hidden = true;
    currentOpenEvent = null;
    if (mapMode === "context") renderContextHighlightLayer();
    setTimeout(() => map.invalidateSize(), 300);
}

// ---------------------------------------------------------------------
// Research Context
// ---------------------------------------------------------------------

const NEARBY_RADIUS_KM = 1000;
const SURROUNDING_WINDOW_YEARS = 5;
const SUBSEQUENT_WINDOW_YEARS = 15;
const CONTEXT_LIST_LIMIT = 5;

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceTier(km) {
    if (km <= 25) return "Very close";
    if (km <= 100) return "Regional";
    if (km <= 250) return "Extended regional";
    return "National";
}

function buildResearchContext(event) {
    const others = events.filter(e => e.id !== event.id);

    const nearby = others
        .map(e => ({ event: e, distanceKm: haversineKm(event.lat, event.lng, e.lat, e.lng) }))
        .filter(x => x.distanceKm <= NEARBY_RADIUS_KM)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, CONTEXT_LIST_LIMIT)
        .map(x => ({ ...x, tier: distanceTier(x.distanceKm) }));

    const sameDate = event.date
        ? others.filter(e => e.date && e.date === event.date).slice(0, CONTEXT_LIST_LIMIT)
        : [];
    const sameDateIds = new Set(sameDate.map(e => e.id));

    const sameYear = others
        .filter(e => e.year === event.year && !sameDateIds.has(e.id))
        .slice(0, CONTEXT_LIST_LIMIT);
    const sameYearIds = new Set(sameYear.map(e => e.id));

    const surrounding = others
        .map(e => ({ event: e, rawDiff: e.year - event.year, yearDiff: Math.abs(e.year - event.year) }))
        .filter(x =>
            x.yearDiff > 0 &&
            x.yearDiff <= SURROUNDING_WINDOW_YEARS &&
            !sameDateIds.has(x.event.id) &&
            !sameYearIds.has(x.event.id)
        )
        .sort((a, b) => a.yearDiff - b.yearDiff)
        .slice(0, CONTEXT_LIST_LIMIT);

    const subsequent = others
        .filter(e =>
            e.country && event.country && e.country === event.country &&
            e.year > event.year && e.year <= event.year + SUBSEQUENT_WINDOW_YEARS
        )
        .sort((a, b) => a.year - b.year)
        .slice(0, CONTEXT_LIST_LIMIT);

    return { nearby, sameDate, sameYear, surrounding, subsequent };
}

function contextListItem(e, metaText) {
    return `
        <li class="rc-item" data-goto-id="${e.id}" tabindex="0" role="button">
            <span class="rc-item-title">${escapeHtml(e.title)}</span>
            <span class="rc-item-meta">${metaText}</span>
        </li>
    `;
}

function locationText(e) {
    return escapeHtml([e.city, e.country].filter(Boolean).join(", "));
}

function renderResearchContext(event) {
    const { nearby, sameDate, sameYear, surrounding, subsequent } = buildResearchContext(event);

    const nearbyHtml = nearby.length
        ? nearby.map(({ event: e, distanceKm, tier }) =>
            contextListItem(e, `${Math.round(distanceKm).toLocaleString()} km away · ${tier} · ${escapeHtml(e.year)}`)
          ).join("")
        : `<li class="rc-empty">No matching NHIRA records within ${NEARBY_RADIUS_KM.toLocaleString()} km. This reflects the current dataset, not confirmed evidence that nothing occurred nearby.</li>`;

    const sameDateHtml = sameDate.length
        ? sameDate.map(e => contextListItem(e, `Same date · ${locationText(e)}`)).join("")
        : `<li class="rc-empty">No matching NHIRA records on the same date.</li>`;

    const sameYearHtml = sameYear.length
        ? sameYear.map(e => contextListItem(e, `Same year · ${locationText(e)}`)).join("")
        : `<li class="rc-empty">No matching NHIRA records in ${escapeHtml(event.year)}.</li>`;

    const surroundingHtml = surrounding.length
        ? surrounding.map(({ event: e, yearDiff, rawDiff }) => {
            const direction = rawDiff < 0 ? "before" : "after";
            return contextListItem(e, `${yearDiff} year${yearDiff === 1 ? "" : "s"} ${direction} · ${locationText(e)}`);
          }).join("")
        : `<li class="rc-empty">No matching NHIRA records within ${SURROUNDING_WINDOW_YEARS} years of ${escapeHtml(event.year)}.</li>`;

    const people = Array.isArray(event.peopleInvolved) ? event.peopleInvolved : [];
    const orgs = Array.isArray(event.organizationsInvolved) ? event.organizationsInvolved : [];
    const involvedHtml = (people.length || orgs.length)
        ? `
            ${people.length ? `<p class="rc-chip-row"><b>People</b><br>${people.map(escapeHtml).join(", ")}</p>` : ""}
            ${orgs.length ? `<p class="rc-chip-row"><b>Organizations</b><br>${orgs.map(escapeHtml).join(", ")}</p>` : ""}
        `
        : `<p class="rc-empty-text">Not yet documented.</p>`;

    const consequencesText = Array.isArray(event.consequences)
        ? event.consequences.filter(Boolean).map(escapeHtml).join("<br>")
        : (event.consequences ? escapeHtml(event.consequences) : "");

    const subsequentHtml = subsequent.length
        ? subsequent.map(e => contextListItem(e, `${escapeHtml(e.year)} · ${escapeHtml(e.country)}`)).join("")
        : `<li class="rc-empty">No matching NHIRA records found in ${escapeHtml(event.country || "this country")} in the following ${SUBSEQUENT_WINDOW_YEARS} years — this reflects a gap in the current dataset, not confirmed evidence that no incidents occurred.</li>`;

    return `
        <h3 class="analysis-heading rc-heading">Research Context</h3>

        <div class="rc-section">
            <p class="chart-title">What was happening nearby?</p>
            <ul class="rc-list">${nearbyHtml}</ul>
        </div>

        <div class="rc-section">
            <p class="chart-title">Same date</p>
            <ul class="rc-list">${sameDateHtml}</ul>
        </div>

        <div class="rc-section">
            <p class="chart-title">Same year</p>
            <ul class="rc-list">${sameYearHtml}</ul>
        </div>

        <div class="rc-section">
            <p class="chart-title">Surrounding period (±${SURROUNDING_WINDOW_YEARS} years)</p>
            <ul class="rc-list">${surroundingHtml}</ul>
        </div>

        <div class="rc-section">
            <p class="chart-title">Who was involved?</p>
            ${involvedHtml}
        </div>

        <div class="rc-section">
            <p class="chart-title">What happened afterward?</p>
            ${consequencesText ? `<p class="rc-consequences">${consequencesText}</p>` : `<p class="rc-empty-text">Consequences not yet documented.</p>`}
            <ul class="rc-list">${subsequentHtml}</ul>
        </div>
    `;
}

// ---------------------------------------------------------------------
// Per-incident Data Quality
// ---------------------------------------------------------------------

const DQ_FIELD_LABELS = [
    ["date", "Date"],
    ["location", "Location"],
    ["fatalities", "Fatalities"],
    ["coordinates", "Coordinates"],
    ["category", "Category"]
];

const DQ_STATUS_LABELS = {
    verified: "Verified",
    reviewed: "Reviewed",
    multiple: "Multiple sources",
    unverified: "Unverified",
    disputed: "Disputed"
};

// =====================================================================
// DATA QUALITY SCORE (composite percentage)
//
// An equal-weighted average of whichever signals actually exist for
// this record. Components with no evidence are excluded rather than
// counted as failures — a record with only 2 of 6 possible signals
// documented is scored on those 2, not penalized for the other 4
// simply not having been assessed yet. If NOTHING is documented,
// this returns null and the UI says "not yet assessed" rather than
// showing a fabricated 0%.
// =====================================================================

const QUALITY_STATUS_WEIGHTS = {
    verified: 1.0,
    multiple: 0.8,
    reviewed: 0.7,
    disputed: 0.4,
    unverified: 0.2
};

function statusToScore(statusKey) {
    if (!statusKey) return null;
    return QUALITY_STATUS_WEIGHTS[String(statusKey).toLowerCase()] ?? null;
}

const DQ_COMPONENT_LABELS = {
    sourceReliability: "Source reliability (historical-source verification)",
    exactLocation: "Exact/approximate coordinates",
    casualtyVerification: "Casualty verification",
    dateVerification: "Date verification",
    duplicateCheck: "Duplicate detection",
    classificationConfidence: "Classification confidence",
    casualtyStandardDocumented: "Victim-only casualty standard documented"
};

// Core fields a usable, mappable, comparable incident record needs.
// This is a simple presence check — it flags what's MISSING, it
// doesn't grade what's present (that's computeDataQualityScore's job).
const MISSING_DATA_CHECK_FIELDS = [
    ["title", "Title"],
    ["date", "Date"],
    ["lat", "Latitude"],
    ["lng", "Longitude"],
    ["fatalities", "Fatalities"],
    ["injuries", "Injuries"],
    ["venue", "Venue"],
    ["category", "Category"]
];

function computeMissingDataFlags(event) {
    const missing = MISSING_DATA_CHECK_FIELDS
        .filter(([key]) => event[key] === undefined || event[key] === null || event[key] === "")
        .map(([, label]) => label);

    if (!(Array.isArray(event.sources) && event.sources.length)) missing.push("Sources");
    if (!event.location_precision) missing.push("Location precision");
    if (!event.sourceDefinition) missing.push("Source definition");

    return missing;
}

function computeDataQualityScore(event) {
    const components = {};

    if (isProvenanceSources(event.sources)) {
        const verifiedCount = event.sources.filter(s => String(s.verification_status).toUpperCase() === "VERIFIED").length;
        if (event.sources.length) components.sourceReliability = verifiedCount / event.sources.length;
    } else if (event.sourceConfidence) {
        const CONF_SCORE = { high: 1.0, medium: 0.65, conflicting: 0.35 };
        const score = CONF_SCORE[String(event.sourceConfidence).toLowerCase()];
        if (score !== undefined) components.sourceReliability = score;
    }

    const precisionKey = event.location_precision ? String(event.location_precision).toLowerCase() : null;
    const PRECISION_SCORE = { exact: 1.0, city_centroid: 0.6, multi_location: 0.5, approximate: 0.4, unknown: 0.2 };
    if (precisionKey && PRECISION_SCORE[precisionKey] !== undefined) components.exactLocation = PRECISION_SCORE[precisionKey];

    const dq = event.dataQuality || {};
    const casualtyScores = [statusToScore(dq.fatalities), statusToScore(dq.injuries)].filter(s => s !== null);
    if (casualtyScores.length) components.casualtyVerification = casualtyScores.reduce((a, b) => a + b, 0) / casualtyScores.length;

    const dateScore = statusToScore(dq.date);
    if (dateScore !== null) components.dateVerification = dateScore;

    const dupScore = Number(event.provenance?.duplicateScore);
    if (Number.isFinite(dupScore)) components.duplicateCheck = 1 - dupScore;

    const classScore = statusToScore(dq.category);
    if (classScore !== null) components.classificationConfidence = classScore;

    // Victim-only casualty standard — is it even KNOWN whether this
    // record's fatality count includes or excludes the perpetrator?
    // Full credit only when the source definition's convention is
    // actually confirmed (not just that a definition string exists).
    if (event.sourceDefinition) {
        const def = SOURCE_DEFINITIONS[event.sourceDefinition];
        if (def) {
            components.casualtyStandardDocumented = def.perpetratorExcluded === null ? 0.4 : 1.0;
        } else {
            components.casualtyStandardDocumented = 0.2; // named but not in the registry — barely better than unknown
        }
    }

    const values = Object.values(components);
    if (!values.length) return null;

    return {
        overall: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100),
        components
    };
}

function renderDataQualityScore(event) {
    const result = computeDataQualityScore(event);
    const missingFlags = computeMissingDataFlags(event);

    const missingHtml = missingFlags.length ? `
        <p class="chart-title">Missing-data flags</p>
        <ul class="review-criteria">
            ${missingFlags.map(f => `<li>${escapeHtml(f)} not recorded</li>`).join("")}
        </ul>
    ` : `<p class="definition-note definition-ok">No missing core fields detected for this record.</p>`;

    if (!result) {
        return `<p class="dq-empty">Data quality not yet assessed for this record — no source, location, verification, or classification signals documented.</p>${missingHtml}`;
    }

    const rows = Object.entries(result.components).map(([key, val]) =>
        `<li><span class="dq-field">${DQ_COMPONENT_LABELS[key] || key}</span><span class="dq-status">${Math.round(val * 100)}%</span></li>`
    ).join("");

    return `
        <div class="dq-score-header">
            <span class="dq-score-label">Data Quality</span>
            <span class="dq-score-value">${result.overall}%</span>
        </div>
        <ul class="dq-list dq-score-breakdown">${rows}</ul>
        <p class="review-criteria-note">
            Equal-weighted average of the signals actually documented for this record — components with no evidence
            yet are excluded rather than scored as failures. This reflects documented evidence, not an independent
            fact-check.
        </p>
        ${missingHtml}
    `;
}

function renderDataQuality(event) {
    const dq = event.dataQuality;
    if (!dq || typeof dq !== "object") {
        return `<p class="dq-empty">Data quality not yet reviewed for this record.</p>`;
    }

    const rows = DQ_FIELD_LABELS
        .filter(([key]) => dq[key])
        .map(([key, label]) => {
            const statusKey = String(dq[key]).toLowerCase();
            const statusLabel = DQ_STATUS_LABELS[statusKey] || dq[key];
            const statusClass = DQ_STATUS_LABELS[statusKey] ? `dq-${statusKey}` : "dq-unverified";
            return `<li><span class="dq-field">${label}</span><span class="dq-status ${statusClass}">${escapeHtml(statusLabel)}</span></li>`;
        });

    return rows.length
        ? `<ul class="dq-list">${rows.join("")}</ul>`
        : `<p class="dq-empty">Data quality not yet reviewed for this record.</p>`;
}

// =====================================================================
// PROVENANCE LAYER
//
// event.sources supports two shapes:
//   legacy:     ["https://...", "https://..."]  (plain URL strings)
//   provenance: [{ source, source_url, source_date, source_type,
//                  source_specific_fatalities, source_specific_injuries,
//                  verification_status, verified_date }, ...]
//
// The legacy shape still renders exactly as before — nothing in the
// existing dataset breaks. New records can use the provenance shape,
// which is what lets NHIRA hold "FBI said 12, local reporting later
// said 13" as two distinct, attributed facts instead of overwriting
// one with the other.
// =====================================================================

function isProvenanceSources(sources) {
    return Array.isArray(sources) && sources.length > 0 &&
        typeof sources[0] === "object" && sources[0] !== null;
}

function renderProvenance(event) {
    const sources = Array.isArray(event.sources) ? event.sources : [];

    if (!sources.length) {
        return `<p class="field"><b>Sources</b><br>No sources on file</p>`;
    }

    if (!isProvenanceSources(sources)) {
        // Legacy plain-URL format — render exactly as before.
        const html = sources
            .map(s => `<a href="${escapeHtml(s)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s)}</a>`)
            .join("<br>");
        return `<p class="field"><b>Sources</b><br>${html}</p>`;
    }

    const fatalityValues = sources.map(s => s.source_specific_fatalities).filter(v => v !== undefined && v !== null);
    const injuryValues = sources.map(s => s.source_specific_injuries).filter(v => v !== undefined && v !== null);
    const fatalitiesDiffer = new Set(fatalityValues).size > 1;
    const injuriesDiffer = new Set(injuryValues).size > 1;

    const disagreementNote = (fatalitiesDiffer || injuriesDiffer)
        ? `<p class="prov-disagreement">Sources report different ${
            fatalitiesDiffer && injuriesDiffer ? "fatality and injury counts" : fatalitiesDiffer ? "fatality counts" : "injury counts"
          } for this incident. The headline figures above use NHIRA's primary recorded value — check each source below for what it specifically reported.</p>`
        : "";

    const cards = sources.map(s => `
        <div class="prov-card">
            <p class="prov-card-head">
                <b>${escapeHtml(s.source || "Unknown source")}</b>
                ${s.source_type ? `<span class="prov-type">${escapeHtml(s.source_type)}</span>` : ""}
            </p>
            <dl class="prov-fields">
                <dt>Source URL</dt>
                <dd>${s.source_url
                    ? `<a href="${escapeHtml(s.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.source_url)}</a>`
                    : "Not recorded"}</dd>

                <dt>Source date</dt>
                <dd>${s.source_date ? escapeHtml(s.source_date) : "Not recorded"}</dd>

                <dt>Fatalities (this source)</dt>
                <dd>${s.source_specific_fatalities ?? "Not stated"}</dd>

                <dt>Injuries (this source)</dt>
                <dd>${s.source_specific_injuries ?? "Not stated"}</dd>

                <dt>Verification status</dt>
                <dd>${s.verification_status
                    ? `<span class="signal-status signal-${String(s.verification_status).toLowerCase()}">${escapeHtml(s.verification_status).replace("_", " ")}</span>`
                    : "Not recorded"}</dd>

                <dt>Verified date</dt>
                <dd>${s.verified_date ? escapeHtml(s.verified_date) : "Not verified"}</dd>
            </dl>
        </div>
    `).join("");

    return `
        <div class="prov-section">
            <p class="field"><b>Sources &amp; Provenance</b></p>
            ${disagreementNote}
            ${cards}
        </div>
    `;
}

// NHIRA's own category (event.resolvedType, driven by event.type) is
// never overwritten by an external classification. sourceClassifications
// is stored and displayed alongside it, never merged into it, so NHIRA
// can eventually compare how FBI/GVA/Violence Project/local police each
// classified the same incident.
function renderSourceClassifications(event) {
    if (!Array.isArray(event.sourceClassifications) || !event.sourceClassifications.length) return "";
    return `
        <div class="prov-section">
            <p class="field"><b>Source classifications</b></p>
            <ul class="source-class-list">
                ${event.sourceClassifications.map(c =>
                    `<li><b>${escapeHtml(c.source)}:</b> ${escapeHtml(c.classification)}</li>`
                ).join("")}
            </ul>
            <p class="review-criteria-note">
                These are the originating sources' own classifications, kept separate from NHIRA's category above —
                one is never overwritten by the other.
            </p>
        </div>
    `;
}

function renderPrecisionBadge(event) {
    const key = String(event.location_precision || "").toLowerCase();
    if (!PRECISION_LABELS[key]) return "";
    const warn = key === "city_centroid" || key === "multi_location" || key === "approximate";
    return `
        <div class="precision-badge ${warn ? "precision-warn" : ""}">
            Location precision: ${PRECISION_LABELS[key]}
            ${warn ? " — treat as a representative point, not an exact target location" : ""}
        </div>
    `;
}

// =====================================================================
// DATA SOURCES & DEFINITIONS REGISTRY
//
// Different sources count "incidents" under different definitions —
// e.g. the FBI's Active Shooter definition, Statistics Canada's
// police-reported mass-casualty-event standard, and a generic
// police-reported shooting count are NOT the same inclusion criteria.
// Mixing them within one country's records (or comparing across
// countries) can make the model see a definitional change as a real
// change in risk. This registry never blocks anything — it surfaces
// what's actually being measured so a researcher can judge it.
//
// Every entry states plainly what is and isn't confirmed. Where a
// convention (e.g. whether the perpetrator is counted as a victim)
// isn't documented in the publicly available summary of a source,
// this says so as `null` rather than guessing — an unconfirmed "false"
// is a false claim of knowledge NHIRA doesn't have.
// =====================================================================

const SOURCE_DEFINITIONS = {
    "FBI Active Shooter": {
        issuingBody: "Federal Bureau of Investigation",
        scope: "United States",
        inclusionThreshold: "One or more individuals actively engaged in killing or attempting to kill people in a populated area, per the FBI's Active Shooter Incidents program.",
        perpetratorExcluded: null,
        fatalityConventionNote: "Whether a perpetrator's own death is counted in the reported fatality total is not standardized across FBI Active Shooter reports and should be checked per-record against the cited report.",
        citation: "FBI Active Shooter Incidents in the United States (annual reports)",
        citationUrl: null
    },
    "Statistics Canada Mass Casualty Event": {
        issuingBody: "Statistics Canada (Canadian Centre for Justice and Community Safety Statistics)",
        scope: "Canada",
        inclusionThreshold: "A police-reported violent incident (excluding criminal negligence causing bodily harm or death) where four or more victims sustained physical injury — minor or major — or died.",
        perpetratorExcluded: null,
        fatalityConventionNote: "Counts victims who were INJURED (minor or major) as well as those who died — a lower and broader threshold than a fatalities-only definition. Not confirmed whether a perpetrator killed during the incident is counted among the victims.",
        citation: "Savage, L. & Conroy, S. (2026). \"Police-reported mass casualty events in Canada, 2010 to 2024.\" Juristat. Statistics Canada Catalogue no. 85-002-X.",
        citationUrl: "https://www150.statcan.gc.ca/n1/pub/85-002-x/2026001/article/00010-eng.htm",
        scopeWarning: "This definition is substantially BROADER than \"mass shooting\": it covers any violent-crime method (stabbings, vehicle-ramming, shootings, etc. — StatCan reports only 64% of these events even involved a weapon of any kind), and counts injuries as well as deaths. Do not compare StatCan mass-casualty-event totals directly against a shooting-specific count without first filtering by method."
    },
    "Gun Violence Archive": {
        issuingBody: "Gun Violence Archive (nonprofit research group)",
        scope: "United States",
        inclusionThreshold: "Four or more people shot in one incident, excluding the perpetrator(s), at one location at roughly the same time.",
        perpetratorExcluded: true,
        fatalityConventionNote: "Victim-only by definition — the perpetrator is explicitly excluded from the shot/killed count.",
        citation: "Gun Violence Archive mass shooting definition",
        citationUrl: null
    },
    "Police-reported Shooting": {
        issuingBody: "Varies — local or regional police service",
        scope: "Varies by jurisdiction",
        inclusionThreshold: "Any shooting incident reported to police. Victim-count thresholds for what counts as \"mass\" are not standardized across jurisdictions.",
        perpetratorExcluded: null,
        fatalityConventionNote: "Varies by jurisdiction and individual report — check the specific source cited on the record.",
        citation: "Varies — see individual record's source_url",
        citationUrl: null
    },
    "Historical Incident Source": {
        issuingBody: "NHIRA compilation from historical/secondary sources",
        scope: "Varies",
        inclusionThreshold: "Compiled from news reporting and secondary historical sources; no single standardized threshold across the whole category.",
        perpetratorExcluded: null,
        fatalityConventionNote: "Varies by original source and not centrally standardized — this is exactly the category of record that benefits most from the per-source provenance layer.",
        citation: "Varies — see individual record's provenance",
        citationUrl: null
    }
};

// Real, cited aggregate reference figures — NOT fabricated per-year
// splits. Only the actual published totals are stored here; anything
// not confirmed by the citation is left out rather than estimated.
const REFERENCE_DATASETS = {
    Canada: {
        "Statistics Canada Mass Casualty Event": {
            period: "2010–2024",
            totalEvents: 5475,
            totalVictims: 26634,
            totalAccused: 7402,
            citation: SOURCE_DEFINITIONS["Statistics Canada Mass Casualty Event"].citation,
            citationUrl: SOURCE_DEFINITIONS["Statistics Canada Mass Casualty Event"].citationUrl,
            scopeWarning: SOURCE_DEFINITIONS["Statistics Canada Mass Casualty Event"].scopeWarning
        }
    }
};

function renderDefinitionRegistryEntry(name, def) {
    return `
        <div class="prov-card">
            <p class="prov-card-head"><b>${escapeHtml(name)}</b></p>
            <dl class="prov-fields">
                <dt>Issuing body</dt><dd>${escapeHtml(def.issuingBody)}</dd>
                <dt>Scope</dt><dd>${escapeHtml(def.scope)}</dd>
                <dt>Inclusion threshold</dt><dd>${escapeHtml(def.inclusionThreshold)}</dd>
                <dt>Perpetrator excluded from casualties?</dt>
                <dd>${def.perpetratorExcluded === true ? "Yes, by definition" : def.perpetratorExcluded === false ? "No" : "Not confirmed from the public documentation — do not assume either way"}</dd>
                <dt>Fatality/casualty convention</dt><dd>${escapeHtml(def.fatalityConventionNote)}</dd>
                <dt>Citation</dt>
                <dd>${def.citationUrl
                    ? `<a href="${escapeHtml(def.citationUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(def.citation)}</a>`
                    : escapeHtml(def.citation)}</dd>
            </dl>
            ${def.scopeWarning ? `<p class="definition-note definition-warn">${escapeHtml(def.scopeWarning)}</p>` : ""}
        </div>
    `;
}

// The honest cross-check: compares NHIRA's own Canada record count
// against the real StatCan aggregate, WITH the scope mismatch stated
// up front. This deliberately does NOT produce a "discrepancy alert" —
// a naive alert here would be actively misleading, since the two
// figures aren't measuring the same thing.
function renderCanadaCrossCheck() {
    const ref = REFERENCE_DATASETS.Canada?.["Statistics Canada Mass Casualty Event"];
    if (!ref) return "";

    const nhiraCanadaEvents = events.filter(e => e.country === "Canada");
    const nhiraTotalFatalities = nhiraCanadaEvents.reduce((s, e) => s + toNumber(e.fatalities), 0);

    return `
        <h3 class="analysis-heading">Canada cross-check</h3>
        <div class="prov-card">
            <p class="prov-card-head"><b>Statistics Canada reference (${escapeHtml(ref.period)})</b></p>
            <dl class="prov-fields">
                <dt>Mass casualty events (StatCan, all methods)</dt><dd>${ref.totalEvents.toLocaleString()}</dd>
                <dt>Total victims (StatCan, injured + killed)</dt><dd>${ref.totalVictims.toLocaleString()}</dd>
                <dt>Total accused (StatCan)</dt><dd>${ref.totalAccused.toLocaleString()}</dd>
                <dt>Source</dt><dd><a href="${escapeHtml(ref.citationUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(ref.citation)}</a></dd>
            </dl>
            <p class="definition-note definition-warn">${escapeHtml(ref.scopeWarning)}</p>
        </div>
        <div class="prov-card">
            <p class="prov-card-head"><b>NHIRA's current Canada records</b></p>
            <dl class="prov-fields">
                <dt>Records on file</dt><dd>${nhiraCanadaEvents.length.toLocaleString()}</dd>
                <dt>Total fatalities recorded</dt><dd>${nhiraTotalFatalities.toLocaleString()}</dd>
            </dl>
        </div>
        <p class="review-criteria-note">
            NHIRA's ${nhiraCanadaEvents.length.toLocaleString()} Canada record(s) are not directly comparable to StatCan's
            ${ref.totalEvents.toLocaleString()} figure above — NHIRA's Canada records are (as far as documented) individually
            notable shooting/mass-violence incidents, while StatCan's figure counts every police-reported violent incident
            meeting a 4-victim injury-or-death threshold across ALL methods nationwide. A valid cross-check would require either
            a shooting-specific subset from StatCan or explicit scoping of what NHIRA intends to track for Canada — this section
            exists to make that gap visible, not to paper over it with a number that looks like a discrepancy check but isn't one.
        </p>
    `;
}

function renderDataSourcesDefinitions() {
    const inUse = new Set(events.map(e => e.sourceDefinition).filter(Boolean));
    const registryEntries = Object.entries(SOURCE_DEFINITIONS);

    return `
        <h3 class="analysis-heading">Data Sources &amp; Definitions</h3>
        <p class="meta">
            Every counting standard NHIRA knows about, and what it actually measures. ${inUse.size
                ? `Currently in use in this dataset: ${[...inUse].map(escapeHtml).join(", ")}.`
                : "No records currently carry a recorded source definition."}
        </p>
        ${registryEntries.map(([name, def]) => renderDefinitionRegistryEntry(name, def)).join("")}
        ${renderCanadaCrossCheck()}
    `;
}

function renderDefinitionBadge(event) {
    if (!event.sourceDefinition) return "";
    const def = SOURCE_DEFINITIONS[event.sourceDefinition];
    if (!def) return `<div class="precision-badge">Source definition: ${escapeHtml(event.sourceDefinition)}</div>`;

    const perpetratorNote = def.perpetratorExcluded === true ? "perpetrator excluded from casualty count"
        : def.perpetratorExcluded === false ? "perpetrator included in casualty count"
        : "perpetrator-inclusion convention not confirmed";

    return `
        <div class="precision-badge ${def.scopeWarning ? "precision-warn" : ""}">
            Source definition: ${escapeHtml(event.sourceDefinition)} (${escapeHtml(def.issuingBody)}) — ${escapeHtml(perpetratorNote)}
            ${def.scopeWarning ? `<br><span>${escapeHtml(def.scopeWarning)}</span>` : ""}
        </div>
    `;
}

function checkDefinitionConsistency(countryEvents) {
    const definitions = [...new Set(
        countryEvents.map(e => e.sourceDefinition).filter(Boolean)
    )];
    const undefinedCount = countryEvents.filter(e => !e.sourceDefinition).length;
    return {
        definitions,
        mixed: definitions.length > 1,
        undefinedCount,
        totalCount: countryEvents.length
    };
}

function definitionConsistencyHtml(countryEvents, countryLabel) {
    const check = checkDefinitionConsistency(countryEvents);
    if (check.totalCount === 0) return "";

    if (check.definitions.length === 0) {
        return `<p class="definition-note definition-warn">No source definition recorded for any ${escapeHtml(countryLabel)} record — inclusion criteria unknown. Trend comparisons against other countries or over time should be treated with caution until this is documented.</p>`;
    }
    if (check.mixed) {
        return `<p class="definition-note definition-warn">
            <b>${escapeHtml(countryLabel)}'s records mix ${check.definitions.length} different counting definitions:</b>
            ${check.definitions.map(escapeHtml).join(", ")}${check.undefinedCount ? `, plus ${check.undefinedCount} record(s) with no definition recorded` : ""}.
            A trend change here may reflect a change in what's being counted, not a change in real-world risk.
        </p>`;
    }
    return `<p class="definition-note definition-ok">
        All ${check.totalCount - check.undefinedCount} defined ${escapeHtml(countryLabel)} record(s) use a single counting standard: <b>${escapeHtml(check.definitions[0])}</b>.
        ${check.undefinedCount ? `${check.undefinedCount} record(s) have no definition recorded.` : ""}
    </p>`;
}

function openPanel(event) {
    currentOpenEvent = event;
    if (mapMode === "context") renderContextHighlightLayer();

    const type = INCIDENT_TYPES[event.resolvedType] || INCIDENT_TYPES.other;
    const projected = event.year > THIS_YEAR;

    const place = [event.city, event.state, event.country]
        .filter(Boolean)
        .map(escapeHtml)
        .join(", ");

    const CONFIDENCE_LABELS = { high: "High", medium: "Medium", conflicting: "Conflicting" };
    const confidenceKey = String(event.sourceConfidence || "").toLowerCase();
    const confidenceHtml = CONFIDENCE_LABELS[confidenceKey]
        ? `<div class="confidence-badge confidence-${confidenceKey}">Source confidence: ${CONFIDENCE_LABELS[confidenceKey]}</div>`
        : "";

    function statBlock(value, estimateRange, label) {
        const hasEstimate = estimateRange !== undefined && estimateRange !== null && estimateRange !== "";
        return `
            <div class="stat">
                <b>${escapeHtml(value ?? "—")}</b><span>${label}</span>
                ${hasEstimate ? `
                    <div class="estimate-note">
                        <span class="estimate-label">Official historical figure</span>
                        Other estimates: ${escapeHtml(estimateRange)}
                    </div>
                ` : ""}
            </div>
        `;
    }

    panelContent.innerHTML = `
        <span class="tag" style="--tag:${type.color}">${escapeHtml(type.label)}${projected ? " &middot; projected" : ""}</span>

        <h2>${escapeHtml(event.title)}</h2>
        <p class="meta">${place} &middot; ${escapeHtml(event.date || event.year)}</p>

        ${confidenceHtml}
        ${renderPrecisionBadge(event)}
        ${renderDefinitionBadge(event)}

        <div class="stats">
            ${statBlock(event.fatalities, event.fatalitiesEstimateRange, "Fatalities")}
            ${statBlock(event.injuries, event.injuriesEstimateRange, "Injuries")}
        </div>

        <p>${escapeHtml(event.description)}</p>

        <hr>

        <p class="field"><b>Venue</b><br>${escapeHtml(event.venue) || "Not recorded"}</p>
        ${renderProvenance(event)}
        ${renderSourceClassifications(event)}

        <div class="dq-section">
            <p class="chart-title">Data quality</p>
            ${renderDataQualityScore(event)}
            ${renderDataQuality(event)}
        </div>

        ${renderResearchContext(event)}
    `;

    openSheet();
}

panelContent.addEventListener("click", e => {
    const item = e.target.closest("[data-goto-id]");
    if (!item) return;
    const targetId = Number(item.dataset.gotoId);
    const target = events.find(ev => ev.id === targetId);
    if (target) openPanel(target);
});

closePanel.addEventListener("click", closeSheet);
scrim.addEventListener("click", closeSheet);
map.on("click", closeSheet);
document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeSheet();
});

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

window.addEventListener("resize", () => map.invalidateSize());

buildLegend();
updateYearReadout(slider.value);

// Defensive re-check: if the map container's size wasn't final at the
// moment Leaflet initialized (a common cause of a blank map with no
// tiles/zoom control), this forces Leaflet to re-measure and repaint.
setTimeout(() => map.invalidateSize(), 100);
setTimeout(() => map.invalidateSize(), 500);
window.addEventListener("load", () => map.invalidateSize());