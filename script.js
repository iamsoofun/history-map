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

        return withinRange && matchesText && matchesActiveResearchFilters(event) && matchesActiveDashFilters(event);
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

// =====================================================================
// REGIME-CHANGE DETECTOR
//
// A disclosed HEURISTIC, not a formal econometric structural-break
// test (a real Chow test or CUSUM test needs regression machinery
// this build doesn't have). It flags one of five states so a model
// trained on an early period doesn't silently assume the recent
// period behaves the same way:
//   Stable / Increasing / Decreasing / High-volatility / Structural break
// =====================================================================

function detectRegime(usableYears, yearlyCounts) {
    if (usableYears.length < 4) return { regime: "Insufficient data", detail: "Need at least 4 years of data." };

    const counts = usableYears.map(y => yearlyCounts[y] || 0);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    const coefficientOfVariation = mean > 0 ? Math.sqrt(variance) / mean : 0;

    const mid = Math.floor(usableYears.length / 2);
    const earlyCounts = counts.slice(0, mid);
    const lateCounts = counts.slice(mid);
    const earlyMean = earlyCounts.reduce((a, b) => a + b, 0) / earlyCounts.length;
    const lateMean = lateCounts.reduce((a, b) => a + b, 0) / lateCounts.length;
    const earlyStd = Math.sqrt(earlyCounts.reduce((a, b) => a + (b - earlyMean) ** 2, 0) / earlyCounts.length);

    // A genuine level-shift ("structural break") looks like: flat
    // within the early half, flat within the late half, but a big gap
    // BETWEEN the two halves. A smooth, steady climb also produces a
    // big early-vs-late mean gap, but it does NOT look flat within
    // each half — both halves have their own real trend. Checking
    // within-half slope first is what tells the two apart; without
    // it, every sustained trend gets misread as a sudden break.
    const earlySlope = linearTrendSlope(earlyCounts.map((c, i) => [i, c]));
    const lateSlope = linearTrendSlope(lateCounts.map((c, i) => [i, c]));
    // Flatness needs to be judged RELATIVE to each half's own scale,
    // not by a fixed absolute slope. A late half of [20, 21, 19] has
    // an OLS slope of -0.5 in absolute terms — comfortably "flat" next
    // to a mean of 20, but an absolute threshold couldn't tell that
    // apart from a genuinely trending series with a small mean.
    const earlySlopeRelative = earlyMean > 0 ? Math.abs(earlySlope) / earlyMean : Math.abs(earlySlope);
    const lateSlopeRelative = lateMean > 0 ? Math.abs(lateSlope) / lateMean : Math.abs(lateSlope);
    const bothHalvesFlat = earlySlopeRelative < 0.15 && lateSlopeRelative < 0.15;
    // When the early half has zero internal variance (a perfectly
    // flat run — the cleanest possible break signature), earlyStd is
    // 0 and a purely relative threshold (gap > 2×earlyStd) can never
    // fire no matter how large the actual jump is. Fall back to an
    // absolute-gap threshold in that case instead of silently failing
    // to detect the clearest kind of break there is.
    const structuralBreak = bothHalvesFlat && (
        earlyStd > 0
            ? Math.abs(lateMean - earlyMean) > 2 * earlyStd
            : Math.abs(lateMean - earlyMean) >= Math.max(1, mean * 0.3)
    );

    // Structural break is checked BEFORE volatility: a flat-then-jump
    // series legitimately has high overall variance too, but
    // "structural break" is the more specific, more useful diagnosis
    // when both are true — volatility alone would bury that signal.
    if (structuralBreak) {
        return { regime: "Structural break", detail: `Flat within each half of the data, but the recent half (avg ${Math.round(lateMean * 10) / 10}/yr) sits well above/below the earlier half (avg ${Math.round(earlyMean * 10) / 10}/yr) — heuristic level-shift detector, not a formal statistical test with a p-value.` };
    }
    if (coefficientOfVariation > 0.75) {
        return { regime: "High-volatility", detail: `Year-to-year counts vary widely relative to the mean (coefficient of variation ${Math.round(coefficientOfVariation * 100) / 100}), without a clean level-shift pattern.` };
    }

    const trendSlope = linearTrendSlope(usableYears.map((y, i) => [i, yearlyCounts[y] || 0]));
    if (trendSlope > 0.15) return { regime: "Increasing", detail: "Sustained upward trend across the data window." };
    if (trendSlope < -0.15) return { regime: "Decreasing", detail: "Sustained downward trend across the data window." };
    return { regime: "Stable", detail: "No sustained trend, high volatility, or level shift detected." };
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

    // Explicit measurement windows for "Recent Activity" — spelled out
    // separately so nobody has to infer what's being compared from a
    // single YoY percentage. A -97% YoY figure means something very
    // different next to "2 incidents last year" than next to "80".
    const last3 = usableYears.slice(-3).map(y => yearlyCounts[y] || 0);
    const recentActivityWindows = {
        latestYearLabel: lastYear,
        latestYearCount: lastYear !== undefined ? (yearlyCounts[lastYear] || 0) : null,
        priorYearLabel: prevYear,
        priorYearCount: prevYear !== undefined ? (yearlyCounts[prevYear] || 0) : null,
        threeYearAnnualizedRate: last3.length ? Math.round((last3.reduce((a, b) => a + b, 0) / last3.length) * 10) / 10 : null
    };

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
    //
    // "Insufficient data" is a genuine fourth state, not just a low
    // score — below this floor, the point estimate itself is
    // suppressed in the UI rather than shown with a "Low" label next
    // to it. A confident-looking number next to the word "Low" still
    // reads as a number to act on; "Insufficient data" doesn't.
    const FORECAST_CONFIDENCE_MIN_YEARS = 2;
    const FORECAST_CONFIDENCE_MIN_INCIDENTS = 3;
    let dataConfidence;
    if (usableYears.length < FORECAST_CONFIDENCE_MIN_YEARS || totalInWindow < FORECAST_CONFIDENCE_MIN_INCIDENTS) {
        dataConfidence = "Insufficient data";
    } else if (usableYears.length >= 8 && totalInWindow >= 15 && dispersionRatio < 3) dataConfidence = "High";
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

    const regimeResult = detectRegime(usableYears, yearlyCounts);
    const populationAdjustedRate = computePopulationAdjustedRate(country, historicalAnnualRate);

    return {
        country, periodLabel, riskTier, estimateLow, estimateHigh,
        modelEstimate, historicalAnnualRate, modelAdjustedRate,
        baseline: historicalAnnualRate,
        trendAdjustment, recentRateAdjustment,
        trendLabel, seasonalityLabel, seasonalityRatio, dataConfidence, forecastValidation, dataCoverage,
        dispersionRatio, yoyChangePct, yoyContradictsTier,
        yearsOfData: usableYears.length, totalInWindow,
        multiWindowTrend, acceleration, timeSinceLastIncidentDays, geographicConcentration,
        incidentProbability12mo, regime: regimeResult, populationAdjustedRate, recentActivityWindows
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

// =====================================================================
// POPULATION-ADJUSTED RATE
//
// Locked spec: population-adjusted rate is reported "Not available"
// rather than fabricated wherever real population data hasn't been
// integrated for that country. This registry starts with exactly two
// entries — the two countries actively growing in this dataset — each
// with a real, cited, dated figure. Every other country returns "Not
// available" until it's added the same way: with a citation, not a
// guess. State/province-level population data would need a much
// larger data-entry effort and is not attempted here.
//
// These are point-in-time estimates and WILL go stale — re-verify and
// update asOf when revisiting this registry, don't just trust it
// indefinitely.
// =====================================================================

const POPULATION_DATA = {
    "United States": {
        population: 341784857,
        asOf: "2025",
        citation: "U.S. Census Bureau (2025 official estimate), via Demographics of the United States",
        citationUrl: "https://en.wikipedia.org/wiki/Demographics_of_the_United_States"
    },
    Canada: {
        population: 41651653,
        asOf: "July 1, 2025",
        citation: "Statistics Canada, \"Canada's population estimates: Age and gender, July 1, 2025\"",
        citationUrl: "https://www150.statcan.gc.ca/n1/daily-quotidien/250924/dq250924a-eng.htm"
    }
};

function computePopulationAdjustedRate(country, annualRate) {
    const pop = POPULATION_DATA[country];
    if (!pop || !Number.isFinite(annualRate)) return null;
    return {
        perMillion: Math.round((annualRate / pop.population) * 1_000_000 * 100) / 100,
        per100k: Math.round((annualRate / pop.population) * 100_000 * 1000) / 1000,
        population: pop.population,
        asOf: pop.asOf,
        citation: pop.citation,
        citationUrl: pop.citationUrl
    };
}

// =====================================================================
// C.5 — HISTORICAL (YEAR-SPECIFIC) POPULATION
//
// Using TODAY's population to adjust a forecast made "as of" 2010
// leaks information from outside the historical prediction window
// into the calculation — exactly what walk-forward testing exists to
// prevent everywhere else in this model. This is a real annual
// population series, not a single snapshot, so a backtest year gets
// the population that actually existed around that year.
//
// US: complete annual series, 1900-2025, U.S. Census Bureau
// (pre-1980 historical estimates, 1980s-2020s intercensal/postcensal
// series), compiled via Multpl.
// Canada: real data points at 5-year intervals from 1955 (UN World
// Population Prospects 2024 Revision, medium-fertility variant, via
// Worldometer) plus annual figures for 2020, 2022-2026. Years between
// known points are LINEARLY INTERPOLATED — disclosed as such, not
// presented as a real annual estimate. No data before 1955; lookups
// for earlier years return null rather than extrapolating blindly.
// =====================================================================

const US_POPULATION_BY_YEAR = {
    1900: 76090000, 1901: 77580000, 1902: 79160000, 1903: 80630000, 1904: 82170000,
    1905: 83820000, 1906: 85450000, 1907: 87010000, 1908: 88710000, 1909: 90490000,
    1910: 92410000, 1911: 93860000, 1912: 95330000, 1913: 97220000, 1914: 99110000,
    1915: 100550000, 1916: 101960000, 1917: 103270000, 1918: 103210000, 1919: 104510000,
    1920: 106460000, 1921: 108540000, 1922: 110050000, 1923: 111950000, 1924: 114110000,
    1925: 115830000, 1926: 117400000, 1927: 119040000, 1928: 120510000, 1929: 121770000,
    1930: 123080000, 1931: 124040000, 1932: 124840000, 1933: 125580000, 1934: 126370000,
    1935: 127250000, 1936: 128050000, 1937: 128820000, 1938: 129820000, 1939: 130880000,
    1940: 132120000, 1941: 133400000, 1942: 134860000, 1943: 136740000, 1944: 138400000,
    1945: 139930000, 1946: 141390000, 1947: 144130000, 1948: 146630000, 1949: 149190000,
    1950: 152270000, 1951: 154880000, 1952: 157550000, 1953: 160180000, 1954: 163030000,
    1955: 165930000, 1956: 168900000, 1957: 171980000, 1958: 174880000, 1959: 177830000,
    1960: 180670000, 1961: 183690000, 1962: 186540000, 1963: 189240000, 1964: 191890000,
    1965: 194300000, 1966: 196560000, 1967: 198710000, 1968: 200710000, 1969: 202680000,
    1970: 205050000, 1971: 207660000, 1972: 209900000, 1973: 211910000, 1974: 213850000,
    1975: 215970000, 1976: 218040000, 1977: 220240000, 1978: 222580000, 1979: 225060000,
    1980: 227220000, 1981: 229470000, 1982: 231660000, 1983: 233790000, 1984: 235820000,
    1985: 237920000, 1986: 240130000, 1987: 242290000, 1988: 244500000, 1989: 246820000,
    1990: 249620000, 1991: 252980000, 1992: 256510000, 1993: 259920000, 1994: 263130000,
    1995: 266280000, 1996: 269390000, 1997: 272650000, 1998: 275850000, 1999: 279040000,
    2000: 282160000, 2001: 284970000, 2002: 287630000, 2003: 290110000, 2004: 292810000,
    2005: 295520000, 2006: 298380000, 2007: 301230000, 2008: 304090000, 2009: 306770000,
    2010: 309320000, 2011: 311560000, 2012: 313830000, 2013: 315990000, 2014: 318300000,
    2015: 320640000, 2016: 322940000, 2017: 324990000, 2018: 326690000, 2019: 328240000,
    2020: 331580000, 2021: 332100000, 2022: 334020000, 2023: 336810000, 2024: 340110000,
    2025: 342030000
};

const CANADA_POPULATION_BY_YEAR = {
    1955: 15728274, 1960: 17898790, 1965: 19685518, 1970: 21440022, 1975: 23148986,
    1980: 24533776, 1985: 25927465, 1990: 27789443, 1995: 29459131, 2000: 30891803,
    2005: 32440173, 2010: 34196899, 2015: 35962234, 2017: 36708083, 2020: 38171902,
    2022: 38821259, 2023: 39299105, 2024: 39742430, 2025: 40126723, 2026: 40467728
};

const HISTORICAL_POPULATION_SERIES = {
    "United States": {
        data: US_POPULATION_BY_YEAR,
        citation: "U.S. Census Bureau — historical national population estimates (1900-1989), intercensal estimates (1990-2009), monthly population estimates (2010-2025)",
        citationUrl: "https://www.census.gov/data/tables/time-series/demo/popest/pre-1980-national.html",
        interpolated: false
    },
    Canada: {
        data: CANADA_POPULATION_BY_YEAR,
        citation: "United Nations, Dept. of Economic and Social Affairs, Population Division — World Population Prospects 2024 Revision (medium-fertility variant), via Worldometer",
        citationUrl: "https://www.worldometers.info/world-population/canada-population/",
        interpolated: true // years between the stored points are linearly interpolated
    }
};

function getHistoricalPopulation(country, year) {
    const series = HISTORICAL_POPULATION_SERIES[country];
    if (!series) return null;

    const years = Object.keys(series.data).map(Number).sort((a, b) => a - b);
    if (!years.length) return null;

    if (series.data[year] !== undefined) return { population: series.data[year], interpolated: false };

    // Outside the known range entirely — don't extrapolate.
    if (year < years[0] || year > years[years.length - 1]) return null;

    // Linear interpolation between the two nearest known points.
    let lower = years[0], upper = years[years.length - 1];
    for (let i = 0; i < years.length - 1; i++) {
        if (years[i] <= year && years[i + 1] >= year) {
            lower = years[i];
            upper = years[i + 1];
            break;
        }
    }
    if (lower === upper) return { population: series.data[lower], interpolated: false };

    const fraction = (year - lower) / (upper - lower);
    const interpolatedPop = Math.round(series.data[lower] + (series.data[upper] - series.data[lower]) * fraction);
    return { population: interpolatedPop, interpolated: true };
}

function computeHistoricalPopulationAdjustedRate(country, annualRate, year) {
    const series = HISTORICAL_POPULATION_SERIES[country];
    if (!series || !Number.isFinite(annualRate)) return null;

    const lookup = getHistoricalPopulation(country, year);
    if (!lookup) return null;

    return {
        perMillion: Math.round((annualRate / lookup.population) * 1_000_000 * 100) / 100,
        per100k: Math.round((annualRate / lookup.population) * 100_000 * 1000) / 1000,
        population: lookup.population,
        year,
        interpolated: lookup.population && series.interpolated && series.data[year] === undefined,
        citation: series.citation,
        citationUrl: series.citationUrl
    };
}

// =====================================================================
// D2 — VIOLENT CRIME / HOMICIDE ENVIRONMENT (US, state-level, partial)
//
// Real, verified FBI UCR data via OpenCrime.us (cross-checked against
// independent Wikipedia-published FBI figures at two points — Alaska
// 2024 and Alabama 2018/2024 — both matched exactly). Deliberately
// PARTIAL: only 6 of 51 US states/DC are covered here (the portion of
// a much larger file that was actually retrievable). This is the same
// honest-partial-coverage pattern as POPULATION_DATA covering 2 of
// ~190 countries — every other state returns "Not available," never a
// guessed or interpolated-across-states value. Extending coverage to
// the remaining states needs the complete source file, not inference.
// =====================================================================

const STATE_NAME_TO_ABBR = {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
    colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
    hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
    kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
    massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
    montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
    "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
    oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
    virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
    "district of columbia": "DC"
};

function normalizeStateAbbr(stateValue) {
    if (!stateValue) return null;
    const trimmed = String(stateValue).trim();
    if (trimmed.length === 2) return trimmed.toUpperCase(); // already an abbreviation
    return STATE_NAME_TO_ABBR[trimmed.toLowerCase()] || null;
}

// year -> { violentRate, homicideRate, population } per 100k residents.
// Source: OpenCrime.us (processed FBI Crime Data Explorer / Summary
// Reporting System estimates), cross-verified against independently
// retrieved FBI-sourced figures published via Wikipedia.
const VIOLENT_CRIME_BY_STATE_YEAR = {
    AK: { 2000: { violentRate: 566.9, homicideRate: 4.31, population: 626932 }, 2001: { violentRate: 589.5, homicideRate: 6.16, population: 633630 }, 2002: { violentRate: 565.4, homicideRate: 5.14, population: 641482 }, 2003: { violentRate: 598, homicideRate: 6.02, population: 648280 }, 2004: { violentRate: 632.3, homicideRate: 5.63, population: 657755 }, 2005: { violentRate: 632.3, homicideRate: 4.82, population: 663253 }, 2006: { violentRate: 688, homicideRate: 5.37, population: 670053 }, 2007: { violentRate: 661.3, homicideRate: 6.29, population: 683478 }, 2008: { violentRate: 652.1, homicideRate: 3.93, population: 686293 }, 2009: { violentRate: 633.4, homicideRate: 3.15, population: 698473 }, 2010: { violentRate: 635.3, homicideRate: 4.34, population: 714146 }, 2011: { violentRate: 610.1, homicideRate: 4.14, population: 723860 }, 2012: { violentRate: 604.1, homicideRate: 4.11, population: 730307 }, 2013: { violentRate: 638.7, homicideRate: 4.61, population: 737259 }, 2014: { violentRate: 635.5, homicideRate: 5.56, population: 737046 }, 2015: { violentRate: 730.8, homicideRate: 8, population: 737709 }, 2016: { violentRate: 804.6, homicideRate: 7.01, population: 741522 }, 2017: { violentRate: 856.7, homicideRate: 8.38, population: 739786 }, 2018: { violentRate: 891.7, homicideRate: 6.39, population: 735139 }, 2019: { violentRate: 865, homicideRate: 9.41, population: 733603 }, 2020: { violentRate: 837.8, homicideRate: 6.7, population: 731158 }, 2021: { violentRate: 759.1, homicideRate: 6.13, population: 734182 }, 2022: { violentRate: 767.1, homicideRate: 9.54, population: 733583 }, 2023: { violentRate: 733.6, homicideRate: 8.01, population: 736510 }, 2024: { violentRate: 724.1, homicideRate: 6.89, population: 740133 } },
    AL: { 2000: { violentRate: 486.2, homicideRate: 7.4, population: 4447100 }, 2001: { violentRate: 438.2, homicideRate: 8.48, population: 4468912 }, 2002: { violentRate: 445, homicideRate: 6.77, population: 4478896 }, 2003: { violentRate: 429.2, homicideRate: 6.64, population: 4503726 }, 2004: { violentRate: 427, homicideRate: 5.61, population: 4525375 }, 2005: { violentRate: 432.6, homicideRate: 8.22, population: 4548327 }, 2006: { violentRate: 425.2, homicideRate: 8.31, population: 4599030 }, 2007: { violentRate: 448.9, homicideRate: 8.9, population: 4627851 }, 2008: { violentRate: 452.8, homicideRate: 7.53, population: 4661900 }, 2009: { violentRate: 450.1, homicideRate: 6.84, population: 4708708 }, 2010: { violentRate: 383.7, homicideRate: 5.75, population: 4785401 }, 2011: { violentRate: 419.8, homicideRate: 6.22, population: 4803689 }, 2012: { violentRate: 450.3, homicideRate: 7.1, population: 4817528 }, 2013: { violentRate: 431, homicideRate: 7.16, population: 4833996 }, 2014: { violentRate: 427.7, homicideRate: 5.69, population: 4846411 }, 2015: { violentRate: 473, homicideRate: 7.17, population: 4853875 }, 2016: { violentRate: 532.4, homicideRate: 8.37, population: 4860545 }, 2017: { violentRate: 522.4, homicideRate: 8.59, population: 4875120 }, 2018: { violentRate: 523.1, homicideRate: 7.84, population: 4887681 }, 2019: { violentRate: 504.7, homicideRate: 7.95, population: 4907965 }, 2020: { violentRate: 453.6, homicideRate: 9.57, population: 4921532 }, 2021: { violentRate: 348.3, homicideRate: 9.43, population: 5049846 }, 2022: { violentRate: 438.1, homicideRate: 11.59, population: 5074296 }, 2023: { violentRate: 417.2, homicideRate: 10.51, population: 5117673 }, 2024: { violentRate: 359.9, homicideRate: 8.72, population: 5157699 } },
    AR: { 2000: { violentRate: 445.3, homicideRate: 6.28, population: 2673400 }, 2001: { violentRate: 452.4, homicideRate: 5.49, population: 2694698 }, 2002: { violentRate: 425, homicideRate: 5.25, population: 2706268 }, 2003: { violentRate: 456.4, homicideRate: 6.6, population: 2727774 }, 2004: { violentRate: 502.3, homicideRate: 6.4, population: 2750000 }, 2005: { violentRate: 528.5, homicideRate: 6.81, population: 2775708 }, 2006: { violentRate: 552.8, homicideRate: 7.29, population: 2810872 }, 2007: { violentRate: 537.1, homicideRate: 6.98, population: 2834797 }, 2008: { violentRate: 513, homicideRate: 5.78, population: 2855390 }, 2009: { violentRate: 515.8, homicideRate: 6.19, population: 2889450 }, 2010: { violentRate: 503.5, homicideRate: 4.59, population: 2921588 }, 2011: { violentRate: 482.3, homicideRate: 5.44, population: 2938582 }, 2012: { violentRate: 469.6, homicideRate: 5.9, population: 2949828 }, 2013: { violentRate: 463.2, homicideRate: 5.34, population: 2958765 }, 2014: { violentRate: 480.2, homicideRate: 5.9, population: 2966835 }, 2015: { violentRate: 529.5, homicideRate: 6.35, population: 2977853 }, 2016: { violentRate: 554.3, homicideRate: 7.26, population: 2988231 }, 2017: { violentRate: 566, homicideRate: 8.29, population: 3002997 }, 2018: { violentRate: 561.6, homicideRate: 7.38, population: 3009733 }, 2019: { violentRate: 580.8, homicideRate: 7.85, population: 3020985 }, 2020: { violentRate: 671.9, homicideRate: 10.59, population: 3030522 }, 2021: { violentRate: 702.4, homicideRate: 11.03, population: 3028122 }, 2022: { violentRate: 653.2, homicideRate: 10.28, population: 3045637 }, 2023: { violentRate: 623.3, homicideRate: 9.58, population: 3069463 }, 2024: { violentRate: 579.4, homicideRate: 7.32, population: 3088354 } },
    AZ: { 2000: { violentRate: 531.7, homicideRate: 7, population: 5130632 }, 2001: { violentRate: 540.3, homicideRate: 7.54, population: 5306966 }, 2002: { violentRate: 554.5, homicideRate: 7.11, population: 5441125 }, 2003: { violentRate: 513.3, homicideRate: 7.9, population: 5579222 }, 2004: { violentRate: 504.4, homicideRate: 7.21, population: 5739879 }, 2005: { violentRate: 512, homicideRate: 7.48, population: 5953007 }, 2006: { violentRate: 542.6, homicideRate: 8.64, population: 6166318 }, 2007: { violentRate: 518, homicideRate: 8.65, population: 6338755 }, 2008: { violentRate: 485.6, homicideRate: 7.11, population: 6500180 }, 2009: { violentRate: 426.5, homicideRate: 5.76, population: 6595778 }, 2010: { violentRate: 413.6, homicideRate: 6.36, population: 6413158 }, 2011: { violentRate: 414.2, homicideRate: 6.14, population: 6467315 }, 2012: { violentRate: 428.6, homicideRate: 5.46, population: 6551149 }, 2013: { violentRate: 415.6, homicideRate: 5.35, population: 6634997 }, 2014: { violentRate: 392.7, homicideRate: 4.62, population: 6728783 }, 2015: { violentRate: 410.2, homicideRate: 4.49, population: 6817565 }, 2016: { violentRate: 471, homicideRate: 5.63, population: 6908642 }, 2017: { violentRate: 505.7, homicideRate: 5.99, population: 7048876 }, 2018: { violentRate: 475.7, homicideRate: 5.35, population: 7158024 }, 2019: { violentRate: 447.1, homicideRate: 5.44, population: 7291843 }, 2020: { violentRate: 484.8, homicideRate: 6.91, population: 7421401 }, 2021: { violentRate: 425.6, homicideRate: 6.68, population: 7264877 }, 2022: { violentRate: 446.2, homicideRate: 7.03, population: 7359197 }, 2023: { violentRate: 433.8, homicideRate: 6.49, population: 7473027 }, 2024: { violentRate: 421.9, homicideRate: 4.93, population: 7582384 } },
    CA: { 2000: { violentRate: 621.6, homicideRate: 6.14, population: 33871648 }, 2001: { violentRate: 615.2, homicideRate: 6.38, population: 34600463 }, 2002: { violentRate: 595.4, homicideRate: 6.84, population: 35001986 }, 2003: { violentRate: 579.6, homicideRate: 6.79, population: 35462712 }, 2004: { violentRate: 527.8, homicideRate: 6.67, population: 35842038 }, 2005: { violentRate: 526, homicideRate: 6.92, population: 36154147 }, 2006: { violentRate: 533.5, homicideRate: 6.82, population: 36457549 }, 2007: { violentRate: 524.1, homicideRate: 6.19, population: 36553215 }, 2008: { violentRate: 504.2, homicideRate: 5.83, population: 36756666 }, 2009: { violentRate: 473.3, homicideRate: 5.34, population: 36961664 }, 2010: { violentRate: 439.6, homicideRate: 4.84, population: 37338198 }, 2011: { violentRate: 411.2, homicideRate: 4.76, population: 37683933 }, 2012: { violentRate: 423.5, homicideRate: 4.96, population: 37999878 }, 2013: { violentRate: 402.6, homicideRate: 4.54, population: 38431393 }, 2014: { violentRate: 396.4, homicideRate: 4.38, population: 38792291 }, 2015: { violentRate: 428, homicideRate: 4.77, population: 38993940 }, 2016: { violentRate: 444.8, homicideRate: 4.91, population: 39296476 }, 2017: { violentRate: 453.3, homicideRate: 4.64, population: 39399349 }, 2018: { violentRate: 447.5, homicideRate: 4.41, population: 39461588 }, 2019: { violentRate: 442.1, homicideRate: 4.29, population: 39437610 }, 2020: { violentRate: 442, homicideRate: 5.6, population: 39368078 }, 2021: { violentRate: 481.2, homicideRate: 5.99, population: 39142991 }, 2022: { violentRate: 503.6, homicideRate: 5.76, population: 39029342 }, 2023: { violentRate: 506.9, homicideRate: 4.96, population: 39198693 }, 2024: { violentRate: 486, homicideRate: 4.52, population: 39431263 } },
    CO: { 2000: { violentRate: 334, homicideRate: 3.12, population: 4301261 }, 2001: { violentRate: 349.6, homicideRate: 3.57, population: 4430989 }, 2002: { violentRate: 352.9, homicideRate: 3.98, population: 4501051 }, 2003: { violentRate: 346.5, homicideRate: 4.07, population: 4547633 }, 2004: { violentRate: 372, homicideRate: 4.37, population: 4601821 }, 2005: { violentRate: 396.7, homicideRate: 3.71, population: 4663295 }, 2006: { violentRate: 395.4, homicideRate: 3.6, population: 4753377 }, 2007: { violentRate: 351.8, homicideRate: 3.19, population: 4861515 }, 2008: { violentRate: 353.9, homicideRate: 3.34, population: 4939456 }, 2009: { violentRate: 338.8, homicideRate: 3.16, population: 5024748 }, 2010: { violentRate: 323.7, homicideRate: 2.56, population: 5047692 }, 2011: { violentRate: 314.4, homicideRate: 3.03, population: 5116302 }, 2012: { violentRate: 307.4, homicideRate: 2.93, population: 5189458 }, 2013: { violentRate: 305.4, homicideRate: 3.3, population: 5272086 }, 2014: { violentRate: 307.8, homicideRate: 2.8, population: 5355588 }, 2015: { violentRate: 318.4, homicideRate: 3.17, population: 5448819 }, 2016: { violentRate: 344.1, homicideRate: 3.42, population: 5530105 }, 2017: { violentRate: 372.2, homicideRate: 3.95, population: 5615902 }, 2018: { violentRate: 401.5, homicideRate: 3.78, population: 5691287 }, 2019: { violentRate: 384.6, homicideRate: 3.98, population: 5758486 }, 2020: { violentRate: 423.1, homicideRate: 5.06, population: 5807719 }, 2021: { violentRate: 480.4, homicideRate: 6.19, population: 5811297 }, 2022: { violentRate: 500.4, homicideRate: 6.37, population: 5839926 }, 2023: { violentRate: 485.2, homicideRate: 5.39, population: 5901339 }, 2024: { violentRate: 476.3, homicideRate: 4.53, population: 5957493 } }
};

const VIOLENT_CRIME_COVERAGE = {
    states: Object.keys(VIOLENT_CRIME_BY_STATE_YEAR), // ["AK","AL","AR","AZ","CA","CO"]
    yearRange: [2000, 2024],
    citation: "OpenCrime.us, processed FBI Crime Data Explorer (Summary Reporting System estimates) — cross-verified against independently retrieved FBI-published figures (Wikipedia, List of U.S. states and territories by violent crime rate) at two points (Alaska 2024, Alabama 2018/2024), both matching exactly",
    citationUrl: "https://www.opencrime.us/downloads",
    note: "Partial coverage by design: 6 of 51 US states/DC. Every other state returns \"Not available\" — never guessed or interpolated across states."
};

function getViolentCrimeRate(stateValue, year) {
    const abbr = normalizeStateAbbr(stateValue);
    if (!abbr) return null;
    const stateData = VIOLENT_CRIME_BY_STATE_YEAR[abbr];
    if (!stateData || !stateData[year]) return null;
    return { ...stateData[year], stateAbbr: abbr };
}

// D2 factor: is the incident-weighted violent-crime environment for
// recent years elevated relative to the country's own historical
// average — computed ONLY from incidents in covered states, honestly
// reporting what fraction of incidents that covers. This is
// deliberately a DIFFERENT signal from recentActivity (which tracks
// incident COUNT trend): this tracks the surrounding crime-rate
// environment's trend, which can move independently of NHIRA's own
// incident count.
function computeViolentCrimeFactor(countryEvents, usableYears, allYears, yearlyCounts) {
    function weightedAvgCrimeRate(years) {
        let totalWeight = 0, weightedSum = 0, coveredIncidents = 0, totalIncidents = 0;
        years.forEach(y => {
            const yearEvents = countryEvents.filter(e => e.year === y);
            totalIncidents += yearEvents.length;
            yearEvents.forEach(e => {
                const cr = getViolentCrimeRate(e.state, y);
                if (cr) {
                    weightedSum += cr.violentRate;
                    totalWeight += 1;
                    coveredIncidents += 1;
                }
            });
        });
        return {
            avg: totalWeight > 0 ? weightedSum / totalWeight : null,
            coveragePct: totalIncidents > 0 ? Math.round((coveredIncidents / totalIncidents) * 1000) / 10 : 0
        };
    }

    const recentYears = usableYears.slice(-2);
    const recent = weightedAvgCrimeRate(recentYears);
    const historical = weightedAvgCrimeRate(allYears);

    if (recent.avg === null || historical.avg === null || historical.avg === 0) return null;

    return {
        score: ratioToScore(recent.avg / historical.avg),
        detail: `${Math.round(recent.avg * 10) / 10} recent vs. ${Math.round(historical.avg * 10) / 10} long-run violent-crime rate in covered states (${historical.coveragePct}% of incidents have state-level crime data)`,
        coveragePct: historical.coveragePct
    };
}


const RISK_SCORE_WEIGHTS = {
    recentActivity: 25,
    historicalBaseline: 20,
    acceleration: 20,
    geographicClustering: 15,
    casualtySeverity: 10,
    temporalSeasonal: 10
};

// C.4 — population added as a 7th factor, deliberately NOT given a
// large weight by default. Population takes 10 points, carved from
// the existing six (each scaled by 0.9) so the total still sums to
// 100 — it's added on top of, not stacked in addition to, full
// weight. Used only when includePopulation is explicitly requested
// AND the country has cited population data (currently US/Canada).
const RISK_SCORE_WEIGHTS_WITH_POPULATION = {
    recentActivity: 22.5,
    historicalBaseline: 18,
    acceleration: 18,
    geographicClustering: 13.5,
    casualtySeverity: 9,
    temporalSeasonal: 9,
    populationAdjusted: 10
};

// D2 test: violent-crime environment, carved the same modest 10
// points from the base six — kept as its OWN independent weight set
// (not combined with population) so the "does D2 help" test is a
// clean, isolated comparison against the no-population baseline, not
// entangled with whether population is also active.
const RISK_SCORE_WEIGHTS_WITH_VIOLENT_CRIME = {
    recentActivity: 22.5,
    historicalBaseline: 18,
    acceleration: 18,
    geographicClustering: 13.5,
    casualtySeverity: 9,
    temporalSeasonal: 9,
    violentCrimeEnvironment: 10
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

function computeRiskScoreFactors(country, asOfYear, excludeKey, populationMode, includeViolentCrime) {
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

    // 7. Population-adjusted rate — two modes:
    //
    // "static" (C.4): today's population snapshot used for both the
    // recent and long-run terms. Mathematically expected to track
    // recentActivity closely, since a near-constant divisor doesn't
    // change the relative pattern of high/low years within one
    // country's own history — a real limitation of a single snapshot,
    // not a modeling bug.
    //
    // "historical" (C.5): each YEAR's own per-capita rate is computed
    // using the population that actually existed around that year, so
    // a forecast made "as of" 2010 uses ~2010 population, not today's.
    // This is the version that can genuinely differ from
    // recentActivity, because it captures population CHANGE over the
    // window, not just a rescaled constant.
    if (populationMode === "static") {
        const popAdjusted = computePopulationAdjustedRate(country, recentRate);
        const popAdjustedBaseline = computePopulationAdjustedRate(country, longRunRate);
        factors.populationAdjusted = (popAdjusted && popAdjustedBaseline && popAdjustedBaseline.per100k > 0)
            ? {
                score: ratioToScore(popAdjusted.per100k / popAdjustedBaseline.per100k),
                detail: `${popAdjusted.per100k}/100k recent vs. ${popAdjustedBaseline.per100k}/100k long-run (static population snapshot, ${popAdjustedBaseline.population.toLocaleString()})`
              }
            : null;
    } else if (populationMode === "historical") {
        const recentYearsList = usableYears.slice(-2);
        const recentPerCapitaValues = recentYearsList
            .map(y => { const p = getHistoricalPopulation(country, y); return p ? ((yearlyCounts[y] || 0) / p.population) * 100000 : null; })
            .filter(v => v !== null);
        const allPerCapitaValues = allYears
            .map(y => { const p = getHistoricalPopulation(country, y); return p ? ((yearlyCounts[y] || 0) / p.population) * 100000 : null; })
            .filter(v => v !== null);

        const recentPerCapitaAvg = recentPerCapitaValues.length ? recentPerCapitaValues.reduce((a, b) => a + b, 0) / recentPerCapitaValues.length : null;
        const longRunPerCapitaAvg = allPerCapitaValues.length ? allPerCapitaValues.reduce((a, b) => a + b, 0) / allPerCapitaValues.length : null;

        factors.populationAdjusted = (recentPerCapitaAvg !== null && longRunPerCapitaAvg !== null && longRunPerCapitaAvg > 0)
            ? {
                score: ratioToScore(recentPerCapitaAvg / longRunPerCapitaAvg),
                detail: `${Math.round(recentPerCapitaAvg * 1000) / 1000}/100k recent vs. ${Math.round(longRunPerCapitaAvg * 1000) / 1000}/100k long-run, using each year's own population (${allPerCapitaValues.length} of ${allYears.length} years had population data)`
              }
            : null;
    }

    // D2 — violent-crime environment (only computed when explicitly
    // requested; only produces a value where covered-state incidents
    // exist for both the recent and historical windows).
    if (includeViolentCrime) {
        const vcFactor = computeViolentCrimeFactor(countryEvents, usableYears, allYears, yearlyCounts);
        factors.violentCrimeEnvironment = vcFactor ? { score: vcFactor.score, detail: vcFactor.detail } : null;
    }

    const activeWeights = includeViolentCrime ? RISK_SCORE_WEIGHTS_WITH_VIOLENT_CRIME
        : populationMode ? RISK_SCORE_WEIGHTS_WITH_POPULATION
        : RISK_SCORE_WEIGHTS;

    // Composite: weighted average of AVAILABLE factors only, reweighted
    // so the used weights sum to 100% — never padded with a guess.
    // excludeKey (ablation testing) forces one factor out of the
    // composite even when it WAS computable, by treating it the same
    // as "not available" and letting the other weights absorb its
    // share — same reweighting path either way, so ablation results
    // are directly comparable to the normal missing-factor case.
    const availableKeys = Object.keys(factors).filter(k => factors[k] !== null && k !== excludeKey);
    if (insufficientOverall || availableKeys.length < RISK_SCORE_MIN_FACTORS) {
        return {
            factors, compositeScore: null, tier: null,
            availableCount: availableKeys.length,
            insufficientOverall,
            totalIncidents: countryEvents.length,
            totalYears: allYears.length
        };
    }

    const usedWeightSum = availableKeys.reduce((s, k) => s + activeWeights[k], 0);
    const compositeScore = Math.round(
        availableKeys.reduce((s, k) => s + factors[k].score * (activeWeights[k] / usedWeightSum), 0)
    );

    const tier = compositeScore >= 80 ? "veryhigh" : compositeScore >= 60 ? "high" : compositeScore >= 40 ? "elevated" : "lower";

    // Factor dispersion — NOT a confidence interval. It's the standard
    // deviation of the individual factor scores feeding into this
    // composite. If the six (or however many are available) factors
    // largely agree, the spread is small; if they pull in different
    // directions, the composite is smoothing over real disagreement
    // between signals. That disagreement is what's being labeled here.
    const factorScores = availableKeys.map(k => factors[k].score);
    const factorMean = factorScores.reduce((a, b) => a + b, 0) / factorScores.length;
    const factorStd = Math.sqrt(factorScores.reduce((a, b) => a + (b - factorMean) ** 2, 0) / factorScores.length);

    return {
        factors, compositeScore, tier, availableCount: availableKeys.length, usedWeightSum,
        factorDispersion: Math.round(factorStd * 10) / 10
    };
}

const RISK_TIER_ICONS = { lower: "🟢", elevated: "🟡", high: "🟠", veryhigh: "🔴" };
const RISK_TIER_NAMES = { lower: "Baseline", elevated: "Elevated", high: "High", veryhigh: "Very High" };

const RISK_FACTOR_LABELS = {
    recentActivity: "Recent incident activity",
    historicalBaseline: "Historical baseline",
    acceleration: "Acceleration / trend",
    geographicClustering: "Geographic clustering",
    casualtySeverity: "Casualty severity",
    temporalSeasonal: "Temporal / seasonal pattern",
    populationAdjusted: "Population-adjusted rate (historical)"
};

// =====================================================================
// MODEL C PRODUCTION LOCK — Phase 3 of the locked sequence: "Freeze
// C.5." This is a DELIBERATE EDITORIAL DECISION, not something the
// code re-derives live. A country only appears here after a human has
// actually reviewed its C.3→C.4→C.5 comparison and decided, as the
// site owner, that C.5 should be the production version — the exact
// numbers that justified the decision are recorded alongside it so
// the claim is traceable, not just asserted.
//
// This is why it fixes the sync gap for real: the previous version
// checked backtestCache, which is empty on every fresh page load —
// meaning ordinary visitors (who never click "Run Backtest") always
// saw the un-validated fallback, even for a country that WAS validated.
// A lock works for every visitor immediately, because it doesn't
// depend on anything happening in their browser session.
//
// Canada is deliberately NOT in this registry — only US-specific
// numbers have been reviewed and locked in this conversation. Add
// Canada here only after its own C.4→C.5 comparison has actually been
// reviewed and confirmed, the same way, with its own numbers.
// =====================================================================

const MODEL_C_PRODUCTION_LOCK = {
    "United States": {
        populationMode: "historical",
        lockedReason: "C.5 (historical population) vs. C.3 (no population), US walk-forward backtest: "
            + "Probability MAE 0.407→0.396, Probability RMSE 0.411→0.402, Recall 87.5%→95.8%, Precision 95.5%→92.0%. "
            + "No look-ahead leakage — year-specific population confirmed to use only data available as of each forecast year."
    }
    // Canada: not yet locked — awaiting its own reviewed C.4/C.5 comparison.
};

// =====================================================================
// C.5.1 STATUS — same editorial-lock pattern as MODEL_C_PRODUCTION_LOCK.
// A country only appears here after a human has reviewed the real
// C.3→C.4→C.5.1 formal comparison (empirical vs. Negative Binomial,
// same held-out years, six dimensions) and made the call. The lock
// records the actual audit numbers and fitted parameters — not just
// a boolean — so the reasoning is traceable later, not just the
// conclusion.
// =====================================================================

const C51_INTERVAL_LOCK = {
    Canada: {
        method: "Negative Binomial",
        // NB parameters as fitted by the completed audit. Worth being
        // precise rather than impressive: the training-window
        // dispersion ratio (0.71) is UNDER 1 — i.e. NOT overdispersed
        // relative to Poisson — so the fitted r (10000) reduces this
        // to a near-Poisson interval in practice. It's genuinely the
        // NB code path, using genuinely NB-fitted parameters; those
        // parameters just happen to collapse toward Poisson because
        // that's what Canada's training data actually supports. Not
        // the same as "we chose NB because the data is overdispersed."
        rParameter: 10000,
        dispersionRatio: 0.71,
        results: {
            coverage80: { nominalPct: 80, actualCoveragePct: 76.7, calibrationErrorPct: 3.3 },
            coverage90: { nominalPct: 90, actualCoveragePct: 83.3, calibrationErrorPct: 6.7 }
        },
        testWindow: {
            definition: "Same 50/25/25 train/calibrate/test split used throughout C.5.1 — r fit from the earliest 59 years, coverage evaluated on the most recent 30 years, never touched during fitting.",
            trainYears: 59, calYears: 30, testYears: 30
        },
        comparisonMethod: "Empirical multiplier method was also tested on the identical held-out years and did NOT achieve calibration at either target (70%/70% actual vs. 80%/90% nominal) — NB was selected because it's the only one of the two that cleared the ±15pp calibration bar at BOTH coverage levels.",
        reason: "NB selected via the completed C.5.1 formal comparison (C.3→C.4→C.5.1, empirical vs. NB, same held-out years) — the only method achieving reasonable calibration at both 80% and 90% targets for Canada.",
        lockedDate: "2026-08-16",
        status: "Production-locked for Canada"
    }
    // United States: explicitly NOT locked. Neither empirical (13.3%/
    // 23.3% actual coverage vs. 80%/90% nominal) nor NB (36.7%/46.7%)
    // achieved calibration on real data — training-window residual std
    // was 0.26, test-window std was 12.37, a ~47x volatility jump no
    // fixed-width interval method could be expected to cover. Documented
    // as a known limitation of the current historical-count formulation,
    // not left unresolved by omission.
};

function getC51Status(country) {
    const locked = C51_INTERVAL_LOCK[country];
    if (locked) return { status: "locked", ...locked };

    const cached = backtestCache[country];
    if (!cached || cached.insufficientData) return { status: "not_run" };

    const before80 = computeIntervalCalibration(cached.results, 0.8);
    const before90 = computeIntervalCalibration(cached.results, 0.9);
    const after80 = computeRecalibratedInterval(cached.results, 0, 0.8);
    const after90 = computeRecalibratedInterval(cached.results, 0, 0.9);

    if (!after80 || !after90) return { status: "not_run" };

    const sameTestYears = before80 && before90
        && before80.testYears === after80.testYears
        && before90.testYears === after90.testYears;

    const anyWellCalibrated = after80.wellCalibrated || after90.wellCalibrated;

    return {
        status: "under_review",
        sameTestYears,
        before80, before90, after80, after90,
        anyWellCalibrated
    };
}

// =====================================================================
// D2 GATE DECISION — same governance pattern as MODEL_C_PRODUCTION_LOCK
// and C51_INTERVAL_LOCK: a documented decision with the real evidence
// attached, not a boolean. This is scoped explicitly to the CURRENT
// 6-of-51-state implementation — it's a verdict on this dataset, not
// a permanent claim that violent-crime environment data can't help
// Model C. A future test with genuinely complete state coverage would
// be a different test.
// =====================================================================

const D2_GATE_DECISION = {
    status: "rejected",
    scope: "Current 6-of-51-state implementation (Alaska, Alabama, Arkansas, Arizona, California, Colorado), 2000-2024 — not a verdict on the underlying hypothesis with complete coverage.",
    evidence: {
        recallDelta: 0, precisionDelta: 0,
        probMAE: { without: 0.448, with: 0.452, delta: 0.004 },
        probRMSE: { without: 0.455, with: 0.457, delta: 0.002 },
        brier: { without: 0.207, with: 0.209 },
        stateCoveragePct: 21.4, // fraction of US incidents actually in a covered state
        incidentsCovered: 124, incidentsTotal: 579,
        windowRobustness: "Result identical across 5/10/15/20-year training windows — not noisy, a stable null-to-slightly-negative finding."
    },
    reason: "Every tested metric (recall, precision, probability MAE/RMSE, Brier score) either showed zero change or a small consistent degradation, stable across all four tested training windows — satisfies the stated REJECT criterion (\"consistently fails to improve Model C\") directly, not marginally.",
    decidedDate: "2026-08-17"
};

function getLivePopulationMode(country) {
    const locked = MODEL_C_PRODUCTION_LOCK[country];
    if (locked) return { mode: locked.populationMode, status: "locked", lockedReason: locked.lockedReason };

    // Fallback for any country NOT yet locked: live per-session
    // detection, useful for previewing status before deciding to lock
    // it in, but never itself presented as a production guarantee.
    const cached = backtestCache[country];
    if (!cached || cached.insufficientData) return { mode: undefined, status: "not_run" };
    if (!POPULATION_DATA[country] || !HISTORICAL_POPULATION_SERIES[country]) return { mode: undefined, status: "no_data" };

    const popTest = computePopulationFactorTest(country, cached);
    if (!popTest || !popTest.deltasC5) return { mode: undefined, status: "not_run" };

    return popTest.validated
        ? { mode: "historical", status: "validated_unlocked", popTest }
        : { mode: undefined, status: "not_validated", popTest };
}

// =====================================================================
// MODEL STATUS PANEL — one place to see, at a glance, which parts of
// NHIRA are production, which are research-only, and which are
// locked. Every row here reads the SAME lock registries and status
// functions that already gate the live forecast — this panel doesn't
// compute its own separate notion of "status," it just surfaces the
// real one. If MODEL_C_PRODUCTION_LOCK or C51_INTERVAL_LOCK change,
// this panel updates automatically; there's nothing here to keep in
// sync by hand.
// =====================================================================

// =====================================================================
// KNOWN ISSUES REGISTRY — same documentation discipline as the lock
// registries: real evidence attached, not just a status word. This
// tracks findings that are real and worth acting on eventually, but
// aren't a single component's pass/fail gate — they're properties of
// the underlying model/data that surfaced from combining evidence
// across multiple tests.
// =====================================================================

// =====================================================================
// RESEARCH FINDINGS REGISTRY — same documentation discipline as the
// lock registries: real evidence attached, not just a status word.
// Unlike KNOWN_ISSUES entries (which track open, unresolved
// observations), a research finding here represents a CLOSED
// experiment with a frozen, pre-registered methodology that has
// reached its conclusion — the stopping rules that closed it are
// part of the record, not just the verdict.
// =====================================================================

const RESEARCH_FINDINGS_REGISTRY = {
    usModelCThresholdStability: {
        title: "US Model C — Threshold Stability",
        verdict: "NOT SUPPORTED",
        scope: "US Model C's binary elevated-year classification THRESHOLD specifically. Not a verdict on Model C's point forecast, population adjustment, or usefulness for other purposes — those remain separately validated and untouched by this finding.",
        evidence: [
            "Existing threshold robustness failure: precision swings 65.8pp (21.7% → 87.5%) across a ±10 move from the originally chosen threshold of 45 (C.1/C.2 robustness audit).",
            "Degenerate F1 operating point: Model C's own F1-optimal threshold, chosen from training data without a degeneracy gate, produced 100% recall, 66.7% precision, 100% false-positive rate on held-out years (D1 threshold-fairness test).",
            "Nested walk-forward validation, frozen and pre-registered before this code was written: three independently-specified candidate procedures (degeneracy-constrained F1, multi-split lexicographic consistency, balanced accuracy) were run against real, cleaned NHIRA data (871 records, duplicates merged).",
            "All three procedures were UNABLE to select even one admissible threshold during INNER validation — the failure occurs before the outer holdout is ever touched, meaning this is not an artifact of one unlucky evaluation split."
        ],
        methodologicalGuarantees: [
            "No outer-holdout-dependent selection — thresholds were chosen using only inner training/validation data; the outer holdout was touched exactly once, for final evaluation.",
            "No post-result threshold adjustment — per the frozen stopping rule, no fourth procedure was attempted after all three failed.",
            "Leakage-tested at every layer (nested splits, all three procedures individually) by distorting the outer holdout and confirming zero effect on any selection."
        ],
        implication: "A formal negative result about US Model C's current binary classification thresholding formulation specifically. Does not mean Model C is useless for every purpose — its point forecast and population adjustment remain separately validated. The production Risk Score was never touched during this experiment.",
        recordedDate: "2026-08-17"
    },
    continuousProbabilityCalibration: {
        title: "Model C — Continuous Probability Calibration",
        verdict: { "United States": "INCONCLUSIVE", Canada: "INCONCLUSIVE" },
        scope: "Whether Model C's raw, UNMODIFIED riskScoreValue/100 is a genuinely calibrated continuous probability — independent of the (already-closed, NOT SUPPORTED) binary threshold question. The score was never recalibrated, rescaled, or clipped before evaluation; any slope/intercept fit was diagnostic-only, never applied back to the tested score.",
        evidence: [
            "US: only 1 of 4 pre-registered walk-forward windows had the minimum 2 adequately-sampled buckets required to be evaluable (25% ≤ the 50% data-sufficiency threshold) — the frozen INCONCLUSIVE rule fired before any pass/fail count was even relevant. That one evaluable window: base rate 1.6%, model Brier score 0.227 vs. a baseline Brier near 0 — worse than trivial, though a single window is not itself conclusive.",
            "Canada: exactly 2 of 4 windows evaluable (50%, not >50%, so the same data-sufficiency rule fires) — of those two, one passed all primary criteria and one failed, which would have been NOT SUPPORTED on a straight majority count but is correctly reported as INCONCLUSIVE per the pre-registered precedence of the sufficiency check.",
            "Both countries' results are consistent with the same underlying constraint already documented elsewhere in this registry: annual elevated-year counts are too rare, relative to the pre-registered quantile-binning/windowing structure, to reliably distinguish the continuous score from a base-rate baseline with the current dataset size."
        ],
        methodologicalGuarantees: [
            "Bin edges, training base rate, and the diagnostic slope/intercept fit were confirmed identical whether or not that window's own evaluation labels were altered — verified directly, not assumed.",
            "Cross-window leakage-tested: distorting the final window's evaluation data left every earlier window's result byte-identical.",
            "No recalibration applied to the tested score at any point — primary evaluation used raw riskScoreValue/100 throughout.",
            "INCONCLUSIVE was pre-declared as a legitimate, distinct outcome before any code was written or any result seen — not introduced after the fact to soften a result."
        ],
        implication: "Neither a pass nor a fail — the current annual sample size is the binding constraint, not evidence against Model C's continuous score. A larger dataset (the ongoing incident-database expansion) is the direct, identified path to eventually resolving this, rather than adjusting the windowing/binning parameters after seeing this result.",
        recordedDate: "2026-08-17"
    }
};

const KNOWN_ISSUES_REGISTRY = {};

function computeModelStatusPanel() {
    const rows = [];

    rows.push({ component: "Production Risk Score", level: "green", status: "Active", detail: "Computed per-country — never from pooled or research-only data." });
    rows.push({ component: "C.1 — United States model", level: "green", status: "Active (production)", detail: "Own historical data, own walk-forward-tuned threshold." });
    rows.push({ component: "C.2 — Canada model", level: "green", status: "Active (production)", detail: "Own historical data, own walk-forward-tuned threshold — never pooled with the US." });
    rows.push({ component: "C.3 — Pooled (US + Canada)", level: "yellow", status: "Research only", detail: "Never used for the live forecast of either country — pooled recall has historically been worse than either country alone." });

    ["United States", "Canada"].forEach(country => {
        const popMode = getLivePopulationMode(country);
        if (popMode.status === "locked") {
            rows.push({ component: `C.5 Population Adjustment (${country})`, level: "green", status: "Validated & locked", detail: popMode.lockedReason || "" });
        } else if (popMode.status === "validated_unlocked") {
            rows.push({ component: `C.5 Population Adjustment (${country})`, level: "yellow", status: "Validated this session, not locked", detail: "Not yet reviewed and added to the production lock registry — won't show this way for other visitors." });
        } else {
            rows.push({ component: `C.5 Population Adjustment (${country})`, level: "gray", status: "Not yet locked", detail: "Run a backtest to check validation status." });
        }
    });

    const c51Us = getC51Status("United States");
    const c51Ca = getC51Status("Canada");
    const c51Locked = c51Us.status === "locked" || c51Ca.status === "locked";
    rows.push({
        component: "C.5.1 Prediction Intervals",
        level: c51Locked ? "green" : "orange",
        status: c51Locked ? "Locked" : "Under review",
        detail: c51Locked ? "" : "No country's interval calibration has been formally reviewed and locked yet — C51_INTERVAL_LOCK is empty by design until that happens."
    });

    rows.push({ component: "D2 — Violent-Crime Factor", level: "red", status: "Rejected (current data)", detail: `Consistently failed to improve Model C across all tested windows (recall/precision unchanged, Brier ${D2_GATE_DECISION.evidence.brier.without}→${D2_GATE_DECISION.evidence.brier.with}) — scoped to the current ${D2_GATE_DECISION.evidence.stateCoveragePct}%-coverage dataset, not a permanent verdict on the concept.` });
    rows.push({ component: "Model D1 (candidate ensemble)", level: "gray", status: "Built — awaiting evaluation", detail: "Learned blend of Model C's Risk Score and count-model probability. Not production; must beat Model C on held-out years and hold up across training windows to become a tournament candidate." });
    rows.push({ component: "Model D (ensemble)", level: "locked", status: "Locked", detail: "Gated behind C.5.1 lock and individual D-variable validation." });
    rows.push({ component: "Forecast Clock (time-to-event)", level: "locked", status: "Locked", detail: "Gated behind Model D — not unlocked yet." });

    const usFinding = RESEARCH_FINDINGS_REGISTRY.usModelCThresholdStability;
    rows.push({ component: usFinding.title, level: "red", status: usFinding.verdict, detail: usFinding.implication });

    const calibFinding = RESEARCH_FINDINGS_REGISTRY.continuousProbabilityCalibration;
    rows.push({ component: calibFinding.title, level: "gray", status: `US: ${calibFinding.verdict["United States"]} · Canada: ${calibFinding.verdict.Canada}`, detail: calibFinding.implication });

    return rows;
}

function renderModelStatusPanel() {
    const rows = computeModelStatusPanel();
    const icon = { green: "🟢", yellow: "🟡", orange: "🟠", red: "🔴", gray: "⚪", locked: "🔒" };

    return `
        <div class="model-status-panel">
            <table class="backtest-table">
                <thead><tr><th>Component</th><th>Status</th><th>Detail</th></tr></thead>
                <tbody>
                    ${rows.map(r => `
                        <tr>
                            <td>${escapeHtml(r.component)}</td>
                            <td>${icon[r.level] || ""} ${escapeHtml(r.status)}</td>
                            <td class="backtest-range">${escapeHtml(r.detail)}</td>
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        </div>
    `;
}

function renderRiskScore(country) {
    const liveMode = getLivePopulationMode(country);

    const result = computeRiskScoreFactors(country, THIS_YEAR, undefined, liveMode.mode);
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

    const activeWeights = liveMode.mode ? RISK_SCORE_WEIGHTS_WITH_POPULATION : RISK_SCORE_WEIGHTS;
    const factorRows = Object.entries(RISK_FACTOR_LABELS).map(([key, label]) => {
        const f = result.factors[key];
        return `
            <tr>
                <td>${label} <span class="backtest-range">(${activeWeights[key] === undefined ? "0" : activeWeights[key]}% weight)</span></td>
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
        ${(() => {
            if (liveMode.status === "locked") {
                return `<p class="definition-note definition-ok"><b>Model C.5 — validated historical-population version (locked for production).</b> Population-adjusted rate is ACTIVE in this score, using the population that existed around each historical year — the exact methodology the backtest confirmed. ${escapeHtml(liveMode.lockedReason)}</p>`;
            }
            if (liveMode.status === "validated_unlocked") {
                return `<p class="definition-note definition-ok">A backtest run this session shows historical-population adjustment validates for ${escapeHtml(country)} and is active in this score — but this hasn't been reviewed and locked for production yet, so it won't show this way for other visitors until it is.</p>`;
            }
            if (liveMode.status === "not_validated") {
                return `<p class="definition-note definition-warn">A backtest has been run for ${escapeHtml(country)}, but historical population adjustment did not validate (see the C.3→C.4→C.5 comparison below) — this score uses the standard 6-factor version without it.</p>`;
            }
            if (liveMode.status === "no_data") {
                return `<p class="definition-note definition-warn">No population data on file for ${escapeHtml(country)} — this score uses the standard 6-factor version.</p>`;
            }
            return `<p class="definition-note definition-warn">Population data exists for ${escapeHtml(country)} but hasn't been validated for live use yet — run a backtest below to check whether historical-population adjustment should be active in this score.</p>`;
        })()}
        <table class="backtest-table">
            <thead><tr><th>Factor</th><th>Score</th><th>Why</th></tr></thead>
            <tbody>${factorRows}</tbody>
        </table>

        <p class="chart-title">Score uncertainty</p>
        ${(() => {
            const dispersionLevel = result.factorDispersion < 12 ? "Low" : result.factorDispersion < 22 ? "Moderate" : "High";
            const evidenceQuality = result.availableCount >= 6 ? "Full" : result.availableCount >= 5 ? "High" : result.availableCount >= 4 ? "Moderate" : "Low";

            const cachedBacktest = backtestCache[country];
            let rangeHtml = `Not yet available — run a backtest below to compute this country's historical score range.`;
            if (cachedBacktest && !cachedBacktest.insufficientData) {
                const scored = cachedBacktest.results.filter(r => r.riskScoreValue !== null).map(r => r.riskScoreValue);
                if (scored.length >= 3) {
                    rangeHtml = `${Math.min(...scored)}–${Math.max(...scored)}, across ${scored.length} backtested year(s) — the actual range of NHIRA Risk Scores this country has historically had, not a statistical confidence interval.`;
                } else {
                    rangeHtml = `Not enough backtested years with a computable score yet (need at least 3, have ${scored.length}).`;
                }
            }

            return `
                <dl class="forecast-fields">
                    <dt>Uncertainty (factor agreement)</dt>
                    <dd><b>${dispersionLevel}</b> — standard deviation of the ${result.availableCount} contributing factor scores is ${result.factorDispersion} points. This measures how much the underlying signals agree with each other, NOT a statistical confidence interval on the composite score itself.</dd>

                    <dt>Historical score range</dt>
                    <dd>${rangeHtml}</dd>

                    <dt>Evidence quality</dt>
                    <dd><b>${evidenceQuality}</b> — ${result.availableCount} of 6 possible factors were computable (${result.usedWeightSum}% of full weight).</dd>
                </dl>
            `;
        })()}

        <p class="forecast-disclaimer">
            This is a research measure of whether ${escapeHtml(country)} currently shows a statistically elevated incident
            pattern relative to its own baseline — it is not a claim that any specific incident is predictable, and it does
            not identify people, targets, or locations at the individual level.
        </p>
    `;
}

function computeAnnualForecastAsOf(country, asOfYear, windowOverride) {
    const countryEvents = events.filter(e => e.country === country && e.year <= asOfYear);
    if (countryEvents.length === 0) return null;

    const yearlyCounts = countBy(countryEvents, e => e.year);
    const allYears = Object.keys(yearlyCounts).map(Number).sort((a, b) => a - b);
    if (allYears.length === 0) return null;

    // windowOverride exists ONLY for robustness testing (C.1/C.2
    // sensitivity audit) — every production call site omits it, so
    // `?? FORECAST_WINDOW_YEARS` keeps their behavior byte-for-byte
    // identical to before this parameter existed.
    const effectiveWindow = windowOverride ?? FORECAST_WINDOW_YEARS;
    const windowYears = allYears.filter(y => y > asOfYear - effectiveWindow);
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

function computeBacktest(country, windowOverride) {
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
        const forecast = computeAnnualForecastAsOf(country, y, windowOverride);
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
            actual, hit, naiveBaseline, elevatedThreshold,
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

    // Threshold sweep decides whether the fixed 60-point tier boundary
    // is actually the best cutoff for the binary elevated-year call —
    // it usually isn't a coincidence that it matches; it's a separate,
    // walk-forward-chosen value. riskScoreMetrics above still reports
    // the FIXED-threshold numbers (so it's directly comparable across
    // countries using one consistent rule); the sweep below reports
    // what a TUNED threshold would actually achieve, honestly
    // validated on years it was never chosen using.
    const thresholdSweep = computeRiskScoreThresholdSweep(results);
    const tunedThreshold = thresholdSweep ? thresholdSweep.recommendedThreshold : 60;
    const incrementalValue = computeIncrementalValue(results, tunedThreshold);
    const brierScores = computeAllBrierScores(results);

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
        riskScoreMetrics, thresholdSweep, incrementalValue, brierScores,
        yearsTested: results.length
    };
}

// =====================================================================
// MODEL C THRESHOLD OPTIMIZATION
//
// The 60-point tier boundary (used for the human-readable Baseline/
// Elevated/High/Very High labels) is a fixed, disclosed convention —
// not necessarily the best cutoff for the binary "elevated year" call.
// This sweeps candidate thresholds, picks whichever has the best
// precision/recall balance (F1) on TRAINING years only, then reports
// that threshold's real performance on held-out years it was never
// chosen using. Same walk-forward discipline as the blend-weight
// tuner and the interval calibration check.
// =====================================================================

const RISK_SCORE_THRESHOLD_CANDIDATES = [40, 45, 50, 55, 60, 65, 70];

function riskScoreMetricsAtThreshold(window, threshold) {
    const scored = window.filter(r => r.riskScoreValue !== null);
    if (!scored.length) return { precision: null, recall: null, f1: null, n: 0 };
    const tp = scored.filter(r => r.riskScoreValue >= threshold && r.actualElevated).length;
    const fp = scored.filter(r => r.riskScoreValue >= threshold && !r.actualElevated).length;
    const fn = scored.filter(r => r.riskScoreValue < threshold && r.actualElevated).length;
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : null;
    const recall = (tp + fn) > 0 ? tp / (tp + fn) : null;
    const f1 = (precision !== null && recall !== null && (precision + recall) > 0)
        ? 2 * precision * recall / (precision + recall) : null;
    return { precision, recall, f1, n: scored.length };
}

function computeRiskScoreThresholdSweep(results) {
    const scored = results.filter(r => r.riskScoreValue !== null);
    if (scored.length < MIN_YEARS_FOR_BLEND_TUNING) return null;

    const splitIndex = Math.max(3, Math.floor(scored.length * 0.7));
    const trainWindow = scored.slice(0, splitIndex);
    const testWindow = scored.slice(splitIndex);
    if (trainWindow.length < 3 || testWindow.length < 2) return null;

    const sweep = RISK_SCORE_THRESHOLD_CANDIDATES.map(threshold => {
        const m = riskScoreMetricsAtThreshold(trainWindow, threshold);
        return {
            threshold,
            trainPrecisionPct: m.precision === null ? null : Math.round(m.precision * 1000) / 10,
            trainRecallPct: m.recall === null ? null : Math.round(m.recall * 1000) / 10,
            trainF1: m.f1
        };
    });

    const withF1 = sweep.filter(s => s.trainF1 !== null);
    const chosen = withF1.length
        ? withF1.reduce((best, s) => (s.trainF1 > best.trainF1 ? s : best), withF1[0])
        : sweep[Math.floor(sweep.length / 2)]; // fallback: middle candidate if F1 is never computable

    const testMetrics = riskScoreMetricsAtThreshold(testWindow, chosen.threshold);

    return {
        sweep,
        recommendedThreshold: chosen.threshold,
        testPrecisionPct: testMetrics.precision === null ? null : Math.round(testMetrics.precision * 1000) / 10,
        testRecallPct: testMetrics.recall === null ? null : Math.round(testMetrics.recall * 1000) / 10,
        trainYears: trainWindow.length,
        testYears: testWindow.length
    };
}

// =====================================================================
// INCREMENTAL VALUE — does Model C add anything Model B doesn't?
//
// For each backtested year, compare whether B's flag (Model A's count
// vs. elevated threshold) and C's flag (Risk Score vs. its
// walk-forward-recommended threshold) were each individually right.
// If C is only ever right when B is ALSO right, C is redundant. The
// number that actually answers the question is bWrongCRight — years
// where C caught something B missed.
// =====================================================================

function computeIncrementalValue(results, cThreshold) {
    const scored = results.filter(r => r.riskScoreValue !== null);
    if (!scored.length) return null;

    let bothRight = 0, bothWrong = 0, bRightCWrong = 0, bWrongCRight = 0;
    scored.forEach(r => {
        const bCorrect = r.predictedElevated === r.actualElevated;
        const cCorrect = (r.riskScoreValue >= cThreshold) === r.actualElevated;
        if (bCorrect && cCorrect) bothRight++;
        else if (bCorrect && !cCorrect) bRightCWrong++;
        else if (!bCorrect && cCorrect) bWrongCRight++;
        else bothWrong++;
    });

    return {
        n: scored.length, bothRight, bothWrong, bRightCWrong, bWrongCRight,
        cAddsValue: bWrongCRight > bRightCWrong
    };
}

// =====================================================================
// BRIER SCORE
//
// Mean squared error between a stated probability and the actual
// binary outcome (0 or 1). Lower is better: 0 = perfect, 0.25 = no
// better than a coin flip, 1 = perfectly wrong every time. Unlike
// precision/recall (which only judge a hard yes/no call), Brier score
// rewards a well-calibrated PROBABILITY — the right lens for anything
// expressed as "X% probability."
// =====================================================================

function computeBrierScore(results, probabilityFn) {
    const scored = results
        .map(r => ({ p: probabilityFn(r), actual: r.actualElevated ? 1 : 0 }))
        .filter(x => x.p !== null && Number.isFinite(x.p));
    if (!scored.length) return null;
    const sum = scored.reduce((s, x) => s + (x.p - x.actual) ** 2, 0);
    return { score: Math.round((sum / scored.length) * 1000) / 1000, n: scored.length };
}

function computeAllBrierScores(results) {
    const modelB = computeBrierScore(results, r =>
        Number.isFinite(r.predictedCentral) && Number.isFinite(r.elevatedThreshold)
            ? poissonProbabilityAbove(r.predictedCentral, r.elevatedThreshold)
            : null
    );
    const modelC = computeBrierScore(results, r =>
        r.riskScoreValue !== null ? r.riskScoreValue / 100 : null
    );

    // Baseline: the simplest defensible "no-skill" probability forecast
    // — the overall historical elevated-rate across ALL backtested
    // years, applied as one constant probability to every year (the
    // standard "climatology" baseline used in forecast scoring).
    const overallElevatedRate = results.length
        ? results.filter(r => r.actualElevated).length / results.length
        : null;
    const baseline = overallElevatedRate !== null
        ? computeBrierScore(results, () => overallElevatedRate)
        : null;

    return { modelB, modelC, baseline };
}

// =====================================================================
// MODEL C ABLATION TESTING
//
// Before adding a 7th factor (population), find out whether the
// existing six deserve the weight they already have. Runs the SAME
// walk-forward years as the main backtest, seven ways: the full
// model, then each factor removed one at a time. Every variant is
// judged against the SAME held-out ground truth (actualElevated) and
// the SAME classification threshold (the full model's own
// walk-forward-recommended threshold, held fixed) — changing only one
// thing (which factor is excluded) so the comparison is clean.
//
// "MAE"/"RMSE" here are NOT in incident-count units (Model C doesn't
// forecast a count) — they're mean absolute/squared error between the
// score-as-probability (score/100) and the binary actual outcome, the
// natural analogs for a probability-style output. RMSE of that is
// mathematically sqrt(Brier score). "Calibration" is calibration-in-
// the-large (|mean predicted probability − mean actual rate|) — a
// single honest number, not a full bucket table, since splitting an
// already-small backtest seven ways would leave each bucket too thin
// to say anything reliable (exactly the problem just fixed in the
// main calibration dashboard).
// =====================================================================

const ABLATION_VARIANTS = [
    { key: null, label: "Full Model C" },
    { key: "recentActivity", label: "C without recent activity" },
    { key: "historicalBaseline", label: "C without historical baseline" },
    { key: "acceleration", label: "C without trend" },
    { key: "geographicClustering", label: "C without geography" },
    { key: "casualtySeverity", label: "C without severity" },
    { key: "temporalSeasonal", label: "C without seasonality" }
];

function computeAblationVariantMetrics(country, backtestYears, excludeKey, threshold, populationMode, includeViolentCrime) {
    const rows = backtestYears.map(({ trainThrough, actualElevated }) => {
        const rs = computeRiskScoreFactors(country, trainThrough, excludeKey || undefined, populationMode, includeViolentCrime);
        if (!rs || rs.compositeScore === null) return null;
        return { probability: rs.compositeScore / 100, actualElevated };
    }).filter(Boolean);

    const coverage = backtestYears.length ? Math.round((rows.length / backtestYears.length) * 1000) / 10 : 0;
    if (!rows.length) return { coverage, n: 0, precision: null, recall: null, falsePositiveRate: null, falseNegativeRate: null, calibrationGap: null, probMAE: null, probRMSE: null };

    const tp = rows.filter(r => r.probability * 100 >= threshold && r.actualElevated).length;
    const fp = rows.filter(r => r.probability * 100 >= threshold && !r.actualElevated).length;
    const fn = rows.filter(r => r.probability * 100 < threshold && r.actualElevated).length;
    const tn = rows.filter(r => r.probability * 100 < threshold && !r.actualElevated).length;

    const precision = (tp + fp) > 0 ? Math.round((tp / (tp + fp)) * 1000) / 10 : null;
    const recall = (tp + fn) > 0 ? Math.round((tp / (tp + fn)) * 1000) / 10 : null;
    const falsePositiveRate = (fp + tn) > 0 ? Math.round((fp / (fp + tn)) * 1000) / 10 : null;
    const falseNegativeRate = (fn + tp) > 0 ? Math.round((fn / (fn + tp)) * 1000) / 10 : null;

    const meanProb = rows.reduce((s, r) => s + r.probability, 0) / rows.length;
    const meanActual = rows.reduce((s, r) => s + (r.actualElevated ? 1 : 0), 0) / rows.length;
    const calibrationGap = Math.round(Math.abs(meanProb - meanActual) * 1000) / 10;

    const probMAE = Math.round((rows.reduce((s, r) => s + Math.abs(r.probability - (r.actualElevated ? 1 : 0)), 0) / rows.length) * 1000) / 1000;
    const probRMSE = Math.round(Math.sqrt(rows.reduce((s, r) => s + (r.probability - (r.actualElevated ? 1 : 0)) ** 2, 0) / rows.length) * 1000) / 1000;

    return { coverage, n: rows.length, precision, recall, falsePositiveRate, falseNegativeRate, calibrationGap, probMAE, probRMSE };
}

function computeAblationTest(country, backtest) {
    if (!backtest || backtest.insufficientData || !backtest.results.length) return null;

    const threshold = backtest.thresholdSweep ? backtest.thresholdSweep.recommendedThreshold : 60;
    const backtestYears = backtest.results.map(r => ({ trainThrough: r.trainThrough, actualElevated: r.actualElevated }));
    if (backtestYears.length < 4) return null;

    const variants = ABLATION_VARIANTS.map(v => ({
        key: v.key,
        label: v.label,
        metrics: computeAblationVariantMetrics(country, backtestYears, v.key, threshold)
    }));

    const full = variants[0];
    const withDeltas = variants.map(v => {
        if (v.key === null || !full.metrics.n || !v.metrics.n) return { ...v, deltas: null };
        const d = (a, b) => (a === null || b === null) ? null : Math.round((a - b) * 10) / 10;
        return {
            ...v,
            deltas: {
                recall: d(v.metrics.recall, full.metrics.recall),
                precision: d(v.metrics.precision, full.metrics.precision),
                probMAE: v.metrics.probMAE === null || full.metrics.probMAE === null ? null : Math.round((v.metrics.probMAE - full.metrics.probMAE) * 1000) / 1000
            }
        };
    });

    return { threshold, variants: withDeltas, sharedYears: backtestYears.length };
}

// =====================================================================
// C.4 — DOES POPULATION ADJUSTMENT ACTUALLY HELP?
//
// Same methodology as ablation testing, run in reverse: instead of
// removing a factor, this ADDS population as a 7th factor (10-point
// weight, carved from the existing six) and compares the resulting
// model against the unmodified baseline on the same walk-forward
// years, same shared threshold. Only runs for countries with cited
// population data (currently US/Canada).
// =====================================================================

// Three-way comparison, per the locked development sequence: C.3 (no
// population) -> C.4 (static/current population) -> C.5 (year-specific
// historical population). If C.5 holds up at least as well as C.4 —
// and both, ideally, hold up versus the no-population baseline — that
// tells us whether a real population time series is actually adding
// value, versus just being a data-completeness exercise.
function computePopulationFactorTest(country, backtest) {
    if (!backtest || backtest.insufficientData || !backtest.results.length) return null;
    if (!POPULATION_DATA[country] || !HISTORICAL_POPULATION_SERIES[country]) return null;

    const threshold = backtest.thresholdSweep ? backtest.thresholdSweep.recommendedThreshold : 60;
    const backtestYears = backtest.results.map(r => ({ trainThrough: r.trainThrough, actualElevated: r.actualElevated }));
    if (backtestYears.length < 4) return null;

    const c3 = computeAblationVariantMetrics(country, backtestYears, null, threshold, undefined);
    const c4 = computeAblationVariantMetrics(country, backtestYears, null, threshold, "static");
    const c5 = computeAblationVariantMetrics(country, backtestYears, null, threshold, "historical");

    if (!c3.n || !c4.n || !c5.n) {
        return { threshold, c3, c4, c5, deltas: null, validated: false, sharedYears: backtestYears.length };
    }

    const d = (a, b) => (a === null || b === null) ? null : Math.round((a - b) * 10) / 10;
    const dRaw = (a, b) => (a === null || b === null) ? null : Math.round((a - b) * 1000) / 1000;

    const deltasC4 = {
        recall: d(c4.recall, c3.recall), precision: d(c4.precision, c3.precision),
        probMAE: dRaw(c4.probMAE, c3.probMAE), probRMSE: dRaw(c4.probRMSE, c3.probRMSE)
    };
    const deltasC5 = {
        recall: d(c5.recall, c3.recall), precision: d(c5.precision, c3.precision),
        probMAE: dRaw(c5.probMAE, c3.probMAE), probRMSE: dRaw(c5.probRMSE, c3.probRMSE)
    };
    const deltasC5vsC4 = {
        recall: d(c5.recall, c4.recall), precision: d(c5.precision, c4.precision),
        probMAE: dRaw(c5.probMAE, c4.probMAE), probRMSE: dRaw(c5.probRMSE, c4.probRMSE)
    };

    // "Validated" is a strict, mechanical check, not a judgment call:
    // C.5 must not make MAE or RMSE meaningfully worse than C.3 (the
    // no-population baseline), and must not make recall meaningfully
    // worse either. This can only ever be TRUE from real numbers —
    // there's no path that marks it true by default.
    const tolerance = 0.02; // small numerical noise tolerance
    const validated = deltasC5.probMAE !== null && deltasC5.probMAE <= tolerance
        && deltasC5.probRMSE !== null && deltasC5.probRMSE <= tolerance
        && deltasC5.recall !== null && deltasC5.recall >= -2; // allow at most a 2pp recall dip

    return {
        threshold, c3, c4, c5,
        deltasC4, deltasC5, deltasC5vsC4,
        validated,
        sharedYears: backtestYears.length
    };
}

// D2 TEST — does adding the violent-crime environment factor improve
// Model C? Only meaningful for the United States (the only country
// with covered-state data), and only where actual coverage exists in
// the backtested years — reported honestly, not assumed.
function computeD2Test(country, backtest) {
    if (!backtest || backtest.insufficientData || !backtest.results.length) return null;
    if (country !== "United States") return null; // covered states are all US states

    const threshold = backtest.thresholdSweep ? backtest.thresholdSweep.recommendedThreshold : 60;
    const backtestYears = backtest.results.map(r => ({ trainThrough: r.trainThrough, actualElevated: r.actualElevated }));
    if (backtestYears.length < 4) return null;

    const withoutD2 = computeAblationVariantMetrics(country, backtestYears, null, threshold, undefined, false);
    const withD2 = computeAblationVariantMetrics(country, backtestYears, null, threshold, undefined, true);

    if (!withoutD2.n || !withD2.n) {
        return { threshold, withoutD2, withD2, deltas: null, sharedYears: backtestYears.length };
    }

    const d = (a, b) => (a === null || b === null) ? null : Math.round((a - b) * 10) / 10;
    const dRaw = (a, b) => (a === null || b === null) ? null : Math.round((a - b) * 1000) / 1000;

    return {
        threshold, withoutD2, withD2,
        deltas: {
            recall: d(withD2.recall, withoutD2.recall),
            precision: d(withD2.precision, withoutD2.precision),
            probMAE: dRaw(withD2.probMAE, withoutD2.probMAE),
            probRMSE: dRaw(withD2.probRMSE, withoutD2.probRMSE)
        },
        coverageNote: VIOLENT_CRIME_COVERAGE.note,
        sharedYears: backtestYears.length
    };
}

// =====================================================================
// C.1/C.2 ROBUSTNESS TESTING
//
// An AUDIT, not optimization: examines whether the production model
// holds up under reasonable alternative configurations. NOTHING here
// feeds back into what threshold, window, or weight the live forecast
// actually uses — that would turn an audit into another form of
// overfitting, exactly the failure mode this test exists to catch.
// Every check below is read-only against data already produced by the
// SAME walk-forward backtest already proven leakage-free elsewhere.
// =====================================================================

const ROBUSTNESS_WINDOW_CANDIDATES = [5, 10, 15, 20]; // 10 is the production default

function computeWindowSensitivity(country) {
    return ROBUSTNESS_WINDOW_CANDIDATES.map(window => {
        const bt = computeBacktest(country, window);
        if (bt.insufficientData) return { window, insufficientData: true };
        return {
            window,
            modelMAE: bt.modelMAE, naiveMAE: bt.naiveMAE, beatsNaive: bt.beatsNaive,
            recall: bt.recall, precision: bt.precision,
            yearsTested: bt.yearsTested
        };
    });
}

// Threshold sensitivity: reuses the risk-score values ALREADY computed
// by the production backtest — no new walk-forward run needed. Checks
// whether recall/precision "collapse" (defined as a swing of more
// than 25 percentage points) when the threshold moves modestly (±5,
// ±10 points) from whatever was actually chosen.
function computeThresholdSensitivity(backtest) {
    if (!backtest || backtest.insufficientData) return null;
    const chosen = backtest.thresholdSweep ? backtest.thresholdSweep.recommendedThreshold : 60;
    const offsets = [-10, -5, 0, 5, 10];
    const rows = offsets.map(offset => {
        const t = Math.max(0, Math.min(100, chosen + offset));
        const m = riskScoreMetricsAtThreshold(backtest.results, t);
        return { threshold: t, offset, recall: m.recall === null ? null : Math.round(m.recall * 1000) / 10, precision: m.precision === null ? null : Math.round(m.precision * 1000) / 10 };
    });
    const recalls = rows.map(r => r.recall).filter(r => r !== null);
    const precisions = rows.map(r => r.precision).filter(r => r !== null);
    const recallSwing = recalls.length ? Math.max(...recalls) - Math.min(...recalls) : null;
    const precisionSwing = precisions.length ? Math.max(...precisions) - Math.min(...precisions) : null;
    return {
        chosen, rows,
        recallSwing, precisionSwing,
        collapses: (recallSwing !== null && recallSwing > 25) || (precisionSwing !== null && precisionSwing > 25)
    };
}

// Recent-history sensitivity: splits the ALREADY-backtested years into
// first/second half and compares — the same split-half pattern
// already proven for the C.5.1 comparison, applied here to Model
// A/B's own metrics.
function computeRecentHistorySensitivity(backtest) {
    if (!backtest || backtest.insufficientData || backtest.results.length < 6) return null;
    const mid = Math.floor(backtest.results.length / 2);
    const firstHalf = backtest.results.slice(0, mid);
    const secondHalf = backtest.results.slice(mid);

    function summarize(rows) {
        if (!rows.length) return null;
        const mae = rows.reduce((s, r) => s + r.modelError, 0) / rows.length;
        const tp = rows.filter(r => r.predictedElevated && r.actualElevated).length;
        const fp = rows.filter(r => r.predictedElevated && !r.actualElevated).length;
        const fn = rows.filter(r => !r.predictedElevated && r.actualElevated).length;
        return {
            n: rows.length,
            mae: Math.round(mae * 100) / 100,
            recall: (tp + fn) > 0 ? Math.round((tp / (tp + fn)) * 1000) / 10 : null,
            precision: (tp + fp) > 0 ? Math.round((tp / (tp + fp)) * 1000) / 10 : null
        };
    }

    const first = summarize(firstHalf);
    const second = summarize(secondHalf);
    const recallGap = (first?.recall !== null && second?.recall !== null) ? Math.abs(first.recall - second.recall) : null;
    return { first, second, recallGap, drivenByRecentYears: recallGap !== null && recallGap > 30 };
}

// Outlier sensitivity: removes the single highest-actual-incident-
// count year from the backtest and checks whether MAE/recall/
// precision shift dramatically without it.
function computeCountOutlierSensitivity(backtest) {
    if (!backtest || backtest.insufficientData || backtest.results.length < 6) return null;
    const worst = backtest.results.reduce((w, r) => (r.actual > (w ? w.actual : -1) ? r : w), null);
    if (!worst) return null;

    const without = backtest.results.filter(r => r !== worst);
    function summarize(rows) {
        const mae = rows.reduce((s, r) => s + r.modelError, 0) / rows.length;
        const tp = rows.filter(r => r.predictedElevated && r.actualElevated).length;
        const fp = rows.filter(r => r.predictedElevated && !r.actualElevated).length;
        const fn = rows.filter(r => !r.predictedElevated && r.actualElevated).length;
        return {
            mae: Math.round(mae * 100) / 100,
            recall: (tp + fn) > 0 ? Math.round((tp / (tp + fn)) * 1000) / 10 : null,
            precision: (tp + fp) > 0 ? Math.round((tp / (tp + fp)) * 1000) / 10 : null
        };
    }

    const withOutlier = summarize(backtest.results);
    const withoutOutlier = summarize(without);
    const maeSwingPct = withOutlier.mae > 0 ? Math.round((Math.abs(withOutlier.mae - withoutOutlier.mae) / withOutlier.mae) * 1000) / 10 : null;

    return {
        outlierYear: worst.forecastYear, outlierActual: worst.actual,
        withOutlier, withoutOutlier, maeSwingPct,
        outlierDriven: maeSwingPct !== null && maeSwingPct > 30
    };
}

function computeC1C2RobustnessAudit(country) {
    const backtest = backtestCache[country] || computeBacktest(country);
    if (backtest.insufficientData) return { insufficientData: true };

    const windowSensitivity = computeWindowSensitivity(country);
    const thresholdSensitivity = computeThresholdSensitivity(backtest);
    const recentHistorySensitivity = computeRecentHistorySensitivity(backtest);
    const outlierSensitivity = computeCountOutlierSensitivity(backtest);

    // Mechanical verdict — every reason is a disclosed, checkable
    // threshold, never a subjective call made after seeing the numbers.
    const reasons = [];
    let robust = true;

    const validWindows = windowSensitivity.filter(w => !w.insufficientData);
    const windowsBeatingNaive = validWindows.filter(w => w.beatsNaive).length;
    if (validWindows.length && windowsBeatingNaive === 0) {
        robust = false;
        reasons.push("Model A does not beat the naive baseline at ANY tested training window — not a robustness failure specifically, but means the count forecast itself isn't earning its place regardless of window choice.");
    } else if (validWindows.length && windowsBeatingNaive < validWindows.length) {
        reasons.push(`Model A beats naive at ${windowsBeatingNaive} of ${validWindows.length} tested windows — window choice matters more than ideal, worth noting even if not disqualifying.`);
    }

    if (thresholdSensitivity && thresholdSensitivity.collapses) {
        robust = false;
        reasons.push(`Elevated-year detection collapses under modest threshold changes (recall swing ${thresholdSensitivity.recallSwing ?? "n/a"}pp, precision swing ${thresholdSensitivity.precisionSwing ?? "n/a"}pp) — the chosen threshold may be sitting on a knife-edge rather than a genuinely stable operating point.`);
    }

    if (recentHistorySensitivity && recentHistorySensitivity.drivenByRecentYears) {
        robust = false;
        reasons.push(`Recall differs by ${recentHistorySensitivity.recallGap}pp between the first and second half of the backtested years — performance looks disproportionately driven by one era rather than holding steady across history.`);
    }

    if (outlierSensitivity && outlierSensitivity.outlierDriven) {
        robust = false;
        reasons.push(`Removing the single highest-incident year (${outlierSensitivity.outlierYear}, ${outlierSensitivity.outlierActual} incidents) changes MAE by ${outlierSensitivity.maeSwingPct}% — results may be disproportionately shaped by one extreme year rather than a broad pattern.`);
    }

    if (reasons.length === 0) {
        reasons.push("No collapse detected across window, threshold, recent-history, or outlier checks — results hold up reasonably well under the tested alternative configurations.");
    }

    return {
        insufficientData: false,
        country, robust, reasons,
        windowSensitivity, thresholdSensitivity, recentHistorySensitivity, outlierSensitivity
    };
}

// =====================================================================
// MODEL D1 — constrained candidate ensemble
//
// Per the FROZEN specification (pre-registered before this code was
// written): D1 = Model C + only inputs with a completed evidence gate.
// D2 is excluded (rejected). Model B is excluded (no formal gate yet).
// Given those constraints, the only honest thing D1 can be is a
// LEARNED blend of Model C's own two internal signals — the Risk
// Score's classification probability and Model A's count-derived
// (Poisson) probability — with the blend weight chosen via the exact
// same walk-forward discipline as tuneShrinkageWeight: selected on
// training years only, reported on held-out years that selection
// never saw. Model C alone remains the production baseline throughout
// this entire evaluation; nothing here changes it.
// =====================================================================

const D1_BLEND_WEIGHT_CANDIDATES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

function d1BlendProbability(row, weight) {
    // weight=1 -> pure Risk Score signal. weight=0 -> pure count-model
    // (Poisson) signal. Both are already-gated Model C components.
    const riskProb = row.riskScoreValue !== null ? row.riskScoreValue / 100 : null;
    const countProb = (Number.isFinite(row.predictedCentral) && Number.isFinite(row.elevatedThreshold))
        ? poissonProbabilityAbove(row.predictedCentral, row.elevatedThreshold) : null;
    if (riskProb === null && countProb === null) return null;
    if (riskProb === null) return countProb;
    if (countProb === null) return riskProb;
    return weight * riskProb + (1 - weight) * countProb;
}

function d1MetricsAtWeight(rows, weight, threshold) {
    const scored = rows.map(r => ({ p: d1BlendProbability(r, weight), actual: r.actualElevated }))
        .filter(r => r.p !== null);
    if (!scored.length) return null;

    const tp = scored.filter(r => r.p * 100 >= threshold && r.actual).length;
    const fp = scored.filter(r => r.p * 100 >= threshold && !r.actual).length;
    const fn = scored.filter(r => r.p * 100 < threshold && r.actual).length;
    const tn = scored.filter(r => r.p * 100 < threshold && !r.actual).length;

    const probMAE = scored.reduce((s, r) => s + Math.abs(r.p - (r.actual ? 1 : 0)), 0) / scored.length;
    const probRMSE = Math.sqrt(scored.reduce((s, r) => s + (r.p - (r.actual ? 1 : 0)) ** 2, 0) / scored.length);
    const brier = probMAE === null ? null : scored.reduce((s, r) => s + (r.p - (r.actual ? 1 : 0)) ** 2, 0) / scored.length;

    return {
        n: scored.length,
        probMAE: Math.round(probMAE * 1000) / 1000,
        probRMSE: Math.round(probRMSE * 1000) / 1000,
        brier: Math.round(brier * 1000) / 1000,
        recall: (tp + fn) > 0 ? Math.round((tp / (tp + fn)) * 1000) / 10 : null,
        precision: (tp + fp) > 0 ? Math.round((tp / (tp + fp)) * 1000) / 10 : null,
        falsePositiveRate: (fp + tn) > 0 ? Math.round((fp / (fp + tn)) * 1000) / 10 : null,
        falseNegativeRate: (fn + tp) > 0 ? Math.round((fn / (fn + tp)) * 1000) / 10 : null
    };
}

const D1_THRESHOLD_CANDIDATES = [40, 45, 50, 55, 60, 65, 70]; // same candidate set as the Risk Score's own threshold sweep

// Best-F1 threshold for a GIVEN probability source (weight), chosen
// from TRAINING years only. Model C (weight=1) and D1 (weight=chosen)
// each get their own honestly-tuned operating point instead of being
// forced through a shared, unvalidated threshold of 60 — that
// mismatch (60 was tuned for the Risk Score, not for D1's blended
// probability, which at low weights is a fundamentally different
// quantity) was a real fairness gap in the comparison, not something
// to paper over by loosening the pass/fail bar itself.
function bestThresholdForWeight(trainWindow, weight) {
    const scored = D1_THRESHOLD_CANDIDATES.map(t => {
        const m = d1MetricsAtWeight(trainWindow, weight, t);
        if (!m || m.precision === null || m.recall === null || (m.precision + m.recall) === 0) {
            return { threshold: t, f1: null };
        }
        return { threshold: t, f1: 2 * m.precision * m.recall / (m.precision + m.recall) };
    });
    const valid = scored.filter(s => s.f1 !== null);
    if (!valid.length) return 60; // honest fallback, never silently invented
    return valid.reduce((best, s) => (s.f1 > best.f1 ? s : best), valid[0]).threshold;
}

function computeD1BlendWeight(backtestResults) {
    if (!backtestResults || backtestResults.length < MIN_YEARS_FOR_BLEND_TUNING) return null;

    const splitIndex = Math.max(3, Math.floor(backtestResults.length * 0.7));
    const trainWindow = backtestResults.slice(0, splitIndex);
    const testWindow = backtestResults.slice(splitIndex);
    if (trainWindow.length < 3 || testWindow.length < 2) return null;

    // Blend weight is chosen first, at a neutral 60, purely to rank
    // candidates by probability accuracy (MAE isn't sensitive to
    // threshold choice the way precision/recall are).
    const threshold = 60;
    const weightResults = D1_BLEND_WEIGHT_CANDIDATES.map(w => {
        const m = d1MetricsAtWeight(trainWindow, w, threshold);
        return { weight: w, trainProbMAE: m ? m.probMAE : null };
    });

    const withMAE = weightResults.filter(r => r.trainProbMAE !== null);
    if (!withMAE.length) return null;
    const chosen = withMAE.reduce((best, r) => (r.trainProbMAE < best.trainProbMAE ? r : best), withMAE[0]);

    // NOW give each side of the comparison its own honestly-tuned
    // threshold, from the same training window, never the held-out
    // test years.
    const d1Threshold = bestThresholdForWeight(trainWindow, chosen.weight);
    const modelCThreshold = bestThresholdForWeight(trainWindow, 1);

    return {
        chosenWeight: chosen.weight,
        weightResults,
        d1Threshold, modelCThreshold,
        trainYears: trainWindow.length, testYears: testWindow.length,
        testWindow, threshold
    };
}

// D1 vs. Model C (pure Risk Score, weight=1), on the SAME held-out
// years the weight selection never touched. Also runs D1's own
// window-robustness check, reusing the exact framework already
// proven for C.1/C.2 — per the pre-registered safeguard, D1 cannot
// be promoted on one good aggregate number while collapsing under a
// training-window change.
function computeD1Test(country) {
    const backtest = backtestCache[country] || computeBacktest(country);
    if (backtest.insufficientData) return { insufficientData: true };

    const tuning = computeD1BlendWeight(backtest.results);
    if (!tuning) return { insufficientData: true };

    const d1Metrics = d1MetricsAtWeight(tuning.testWindow, tuning.chosenWeight, tuning.d1Threshold);
    const modelCMetrics = d1MetricsAtWeight(tuning.testWindow, 1, tuning.modelCThreshold); // weight=1 = pure Risk Score = Model C alone, at ITS OWN tuned threshold

    if (!d1Metrics || !modelCMetrics) return { insufficientData: true };

    // Robustness: rerun the SAME comparison at each alternative
    // training window, checking whether D1's advantage (if any) holds
    // or evaporates. This is what keeps a lucky single split from
    // being mistaken for real, repeatable improvement.
    const windowRobustness = ROBUSTNESS_WINDOW_CANDIDATES.map(w => {
        const bt = computeBacktest(country, w);
        if (bt.insufficientData) return { window: w, insufficientData: true };
        const wTuning = computeD1BlendWeight(bt.results);
        if (!wTuning) return { window: w, insufficientData: true };
        const wD1 = d1MetricsAtWeight(wTuning.testWindow, wTuning.chosenWeight, wTuning.d1Threshold);
        const wC = d1MetricsAtWeight(wTuning.testWindow, 1, wTuning.modelCThreshold);
        return {
            window: w,
            d1ProbMAE: wD1 ? wD1.probMAE : null, cProbMAE: wC ? wC.probMAE : null,
            d1BeatsC: wD1 && wC ? wD1.probMAE < wC.probMAE : null
        };
    });

    const validWindows = windowRobustness.filter(w => !w.insufficientData && w.d1BeatsC !== null);
    const windowsD1Wins = validWindows.filter(w => w.d1BeatsC).length;

    // Mechanical promotion rule, pre-registered: D1 must beat C on the
    // held-out test AND not lose on recall/precision by a meaningful
    // margin AND win (or at least not lose) at a MAJORITY of tested
    // windows — a single lucky split does not count as "beats C."
    const beatsOnHeldOut = d1Metrics.probMAE < modelCMetrics.probMAE;
    const recallHeld = d1Metrics.recall !== null && modelCMetrics.recall !== null
        ? d1Metrics.recall >= modelCMetrics.recall - 5 : true; // within 5pp, not a real loss
    const precisionHeld = d1Metrics.precision !== null && modelCMetrics.precision !== null
        ? d1Metrics.precision >= modelCMetrics.precision - 5 : true;
    const robustAcrossWindows = validWindows.length > 0 && windowsD1Wins >= Math.ceil(validWindows.length / 2);

    const promoted = beatsOnHeldOut && recallHeld && precisionHeld && robustAcrossWindows;

    const reasons = [];
    reasons.push(beatsOnHeldOut
        ? `D1 improves probability MAE on held-out years (${d1Metrics.probMAE} vs. C's ${modelCMetrics.probMAE}).`
        : `D1 does NOT improve probability MAE on held-out years (${d1Metrics.probMAE} vs. C's ${modelCMetrics.probMAE}).`);
    if (!recallHeld) reasons.push(`Recall drops by more than 5pp vs. Model C alone (${d1Metrics.recall}% vs. ${modelCMetrics.recall}%) — disqualifying even if error improved.`);
    if (!precisionHeld) reasons.push(`Precision drops by more than 5pp vs. Model C alone (${d1Metrics.precision}% vs. ${modelCMetrics.precision}%) — disqualifying even if error improved.`);
    reasons.push(`D1 beats C at ${windowsD1Wins} of ${validWindows.length} tested training windows — ${robustAcrossWindows ? "a majority, treated as repeatable" : "not a majority, treated as not repeatable"}.`);

    return {
        insufficientData: false,
        country, promoted, reasons,
        chosenWeight: tuning.chosenWeight,
        trainYears: tuning.trainYears, testYears: tuning.testYears,
        d1Metrics, modelCMetrics, windowRobustness
    };
}

// =====================================================================
// US THRESHOLD-STABILITY EXPERIMENT — nested walk-forward scaffolding
//
// Per the frozen spec: the 70/30 split is NOT the central structure.
// This builds genuinely nested validation:
//   historical data → OUTER TRAIN / OUTER HOLDOUT split
//   OUTER TRAIN → multiple INNER train/val splits (walk-forward)
//   threshold selection happens ENTIRELY within OUTER TRAIN
//   OUTER HOLDOUT is touched exactly once, at final evaluation
//
// This scaffolding is shared by all three candidate procedures — none
// of them get their own separate holdout. Same holdout, three
// separate attempts, one honest final answer.
// =====================================================================

function computeNestedSplits(backtestResults, outerHoldoutFraction, numInnerSplits) {
    const n = backtestResults.length;
    const outerTrainEnd = Math.floor(n * (1 - outerHoldoutFraction));
    const outerTrain = backtestResults.slice(0, outerTrainEnd);
    const outerHoldout = backtestResults.slice(outerTrainEnd);
    if (outerTrain.length < 6 || outerHoldout.length < 2) return null;

    // Inner splits: walk-forward, growing training window, entirely
    // WITHIN outerTrain. Each inner split's validation slice is years
    // the inner split's own training portion never saw — same
    // no-leakage discipline as everything else, just nested one level
    // deeper.
    const innerSplits = [];
    const minInnerTrain = Math.max(3, Math.floor(outerTrain.length * 0.4));
    const remaining = outerTrain.length - minInnerTrain;
    const step = Math.max(1, Math.floor(remaining / numInnerSplits));
    for (let i = 0; i < numInnerSplits; i++) {
        const trainEnd = minInnerTrain + i * step;
        const valEnd = Math.min(outerTrain.length, trainEnd + step);
        if (trainEnd >= outerTrain.length || valEnd <= trainEnd) continue;
        innerSplits.push({ train: outerTrain.slice(0, trainEnd), val: outerTrain.slice(trainEnd, valEnd) });
    }
    if (!innerSplits.length) return null;

    return { outerTrain, outerHoldout, innerSplits, outerTrainYears: outerTrain.length, outerHoldoutYears: outerHoldout.length };
}

// Self-contained metrics function for this experiment — includes FPR/
// FNR (needed for the degeneracy gate), which the app's existing
// riskScoreMetricsAtThreshold does not compute. Built separately
// rather than modifying that shared function, to avoid any risk to
// code other parts of the app already depend on.
function computeThresholdStabilityMetrics(rows, threshold) {
    const scored = rows.filter(r => r.riskScoreValue !== null);
    if (!scored.length) return null;
    const tp = scored.filter(r => r.riskScoreValue >= threshold && r.actualElevated).length;
    const fp = scored.filter(r => r.riskScoreValue >= threshold && !r.actualElevated).length;
    const fn = scored.filter(r => r.riskScoreValue < threshold && r.actualElevated).length;
    const tn = scored.filter(r => r.riskScoreValue < threshold && !r.actualElevated).length;
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : null;
    const recall = (tp + fn) > 0 ? tp / (tp + fn) : null;
    const falsePositiveRate = (fp + tn) > 0 ? fp / (fp + tn) : null;
    const falseNegativeRate = (fn + tp) > 0 ? fn / (fn + tp) : null;
    // Balanced accuracy = average of recall on each class = (recall + specificity) / 2
    const specificity = falsePositiveRate === null ? null : 1 - falsePositiveRate;
    const balancedAccuracy = (recall !== null && specificity !== null) ? (recall + specificity) / 2 : null;
    return { n: scored.length, precision, recall, falsePositiveRate, falseNegativeRate, balancedAccuracy, tp, fp, fn, tn };
}

// Degeneracy gate — an ADMISSIBILITY floor, not a quality signal.
// Clearing this means "not obviously broken," nothing more.
function passesDegeneracyGate(metrics, fprCeiling) {
    if (!metrics) return false;
    if (metrics.precision === null || metrics.recall === null) return false;
    if (metrics.precision <= 0 || metrics.recall <= 0) return false;
    if (metrics.falsePositiveRate !== null && metrics.falsePositiveRate > fprCeiling) return false;
    return true;
}

const THRESHOLD_STABILITY_CANDIDATES = [30, 35, 40, 45, 50, 55, 60, 65, 70];
const DEGENERACY_FPR_CEILING = 0.5;

// =====================================================================
// PROCEDURE A — Degeneracy-constrained F1
//
// Within outerTrain only: a single train/val split. Candidates are
// scored for degeneracy on the VALIDATION slice (never on train — a
// threshold that's only non-degenerate on the data it was fit to
// tells us nothing). Among the admissible survivors, pick the one
// maximizing F1 on the training slice. F1 itself is retained
// deliberately even though it's what produced the original degenerate
// result — its failure under this stricter gate is itself part of the
// evidence this experiment is designed to produce.
// =====================================================================

function runProcedureA(outerTrain) {
    const splitIdx = Math.max(3, Math.floor(outerTrain.length * 0.7));
    const train = outerTrain.slice(0, splitIdx);
    const val = outerTrain.slice(splitIdx);
    if (train.length < 3 || val.length < 2) return null;

    const scored = THRESHOLD_STABILITY_CANDIDATES.map(t => {
        const trainMetrics = computeThresholdStabilityMetrics(train, t);
        const valMetrics = computeThresholdStabilityMetrics(val, t);
        const admissible = passesDegeneracyGate(valMetrics, DEGENERACY_FPR_CEILING);
        const f1 = (trainMetrics && trainMetrics.precision !== null && trainMetrics.recall !== null && (trainMetrics.precision + trainMetrics.recall) > 0)
            ? 2 * trainMetrics.precision * trainMetrics.recall / (trainMetrics.precision + trainMetrics.recall) : null;
        return { threshold: t, admissible, f1, trainMetrics, valMetrics };
    });

    const admissibleCandidates = scored.filter(s => s.admissible && s.f1 !== null);
    if (!admissibleCandidates.length) {
        return { procedure: "A — Degeneracy-constrained F1", selected: null, allResults: scored, trainYears: train.length, valYears: val.length,
            outcome: "No threshold in the candidate set cleared the degeneracy gate on the validation slice — every candidate was either degenerate or had no computable F1." };
    }

    const chosen = admissibleCandidates.reduce((best, s) => (s.f1 > best.f1 ? s : best), admissibleCandidates[0]);
    return {
        procedure: "A — Degeneracy-constrained F1",
        selected: chosen.threshold,
        allResults: scored, trainYears: train.length, valYears: val.length,
        outcome: `Selected threshold ${chosen.threshold} — best F1 (${Math.round(chosen.f1 * 1000) / 1000}) among ${admissibleCandidates.length} degeneracy-admissible candidates.`
    };
}

// =====================================================================
// PROCEDURE B — Multi-split consistency (lexicographic)
//
// Evaluated across EVERY inner split's validation slice, not one.
// Lexicographic selection, per the frozen spec — NOT lowest-variance-
// wins alone, which would let a threshold that's mediocre everywhere
// win by default:
//   1. Eliminate thresholds that are degenerate on ANY inner split.
//   2. Among survivors, minimize cross-split variance of balanced
//      accuracy.
//   3. If tied/near-tied, maximize median balanced accuracy.
//   4. Final tiebreak: the candidate closest to the center of the
//      tested threshold range (simplest/most central).
// =====================================================================

const LEXICOGRAPHIC_TOLERANCE = 0.001; // "near-tied" epsilon, disclosed rather than left implicit

function runProcedureB(innerSplits) {
    if (!innerSplits || innerSplits.length < 2) return null;

    const scored = THRESHOLD_STABILITY_CANDIDATES.map(t => {
        const splitMetrics = innerSplits.map(s => computeThresholdStabilityMetrics(s.val, t));
        const allAdmissible = splitMetrics.every(m => passesDegeneracyGate(m, DEGENERACY_FPR_CEILING));
        const balancedAccs = splitMetrics.map(m => (m && m.balancedAccuracy !== null) ? m.balancedAccuracy : null).filter(v => v !== null);
        if (balancedAccs.length < innerSplits.length) {
            // Missing coverage on any split is treated the same as
            // inadmissible — a threshold that can't even be scored on
            // every split can't be judged "consistent."
            return { threshold: t, admissible: false, variance: null, medianBA: null, splitMetrics };
        }
        const mean = balancedAccs.reduce((a, b) => a + b, 0) / balancedAccs.length;
        const variance = balancedAccs.reduce((a, b) => a + (b - mean) ** 2, 0) / balancedAccs.length;
        const sorted = [...balancedAccs].sort((a, b) => a - b);
        const medianBA = sorted.length % 2 === 0
            ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
            : sorted[Math.floor(sorted.length / 2)];
        return { threshold: t, admissible: allAdmissible, variance, medianBA, splitMetrics };
    });

    const admissible = scored.filter(r => r.admissible && r.variance !== null);
    if (!admissible.length) {
        return { procedure: "B — Multi-split consistency", selected: null, allResults: scored,
            outcome: `No threshold was admissible (non-degenerate) across all ${innerSplits.length} inner splits.` };
    }

    // Step 2: minimize variance
    const minVariance = Math.min(...admissible.map(r => r.variance));
    let survivors = admissible.filter(r => r.variance <= minVariance + LEXICOGRAPHIC_TOLERANCE);

    // Step 3: if still tied, maximize median balanced accuracy
    if (survivors.length > 1) {
        const maxMedianBA = Math.max(...survivors.map(r => r.medianBA));
        survivors = survivors.filter(r => r.medianBA >= maxMedianBA - LEXICOGRAPHIC_TOLERANCE);
    }

    // Step 4: final tiebreak — most central threshold
    const midpoint = (THRESHOLD_STABILITY_CANDIDATES[0] + THRESHOLD_STABILITY_CANDIDATES[THRESHOLD_STABILITY_CANDIDATES.length - 1]) / 2;
    const chosen = survivors.reduce((best, r) => (Math.abs(r.threshold - midpoint) < Math.abs(best.threshold - midpoint) ? r : best), survivors[0]);

    return {
        procedure: "B — Multi-split consistency",
        selected: chosen.threshold,
        allResults: scored,
        innerSplitCount: innerSplits.length,
        outcome: `Selected threshold ${chosen.threshold} — admissible across all ${innerSplits.length} inner splits, cross-split variance ${Math.round(chosen.variance * 10000) / 10000}, median balanced accuracy ${Math.round(chosen.medianBA * 1000) / 1000}.`
    };
}

// =====================================================================
// PROCEDURE C — Balanced accuracy
//
// Same single train/val split structure as A, but directly optimizes
// VALIDATION balanced accuracy (matching how scikit-learn's own
// TunedThresholdClassifierCV defaults to balanced accuracy
// specifically because it's less sensitive to class imbalance) rather
// than training-set F1. A genuinely different selection idea from A,
// not a variant of it.
// =====================================================================

function runProcedureC(outerTrain) {
    const splitIdx = Math.max(3, Math.floor(outerTrain.length * 0.7));
    const train = outerTrain.slice(0, splitIdx);
    const val = outerTrain.slice(splitIdx);
    if (train.length < 3 || val.length < 2) return null;

    const scored = THRESHOLD_STABILITY_CANDIDATES.map(t => {
        const valMetrics = computeThresholdStabilityMetrics(val, t);
        const admissible = passesDegeneracyGate(valMetrics, DEGENERACY_FPR_CEILING);
        return { threshold: t, admissible, balancedAccuracy: valMetrics ? valMetrics.balancedAccuracy : null, valMetrics };
    });

    const admissibleCandidates = scored.filter(s => s.admissible && s.balancedAccuracy !== null);
    if (!admissibleCandidates.length) {
        return { procedure: "C — Balanced accuracy", selected: null, allResults: scored, trainYears: train.length, valYears: val.length,
            outcome: "No threshold cleared the degeneracy gate on the validation slice." };
    }

    const chosen = admissibleCandidates.reduce((best, s) => (s.balancedAccuracy > best.balancedAccuracy ? s : best), admissibleCandidates[0]);
    return {
        procedure: "C — Balanced accuracy",
        selected: chosen.threshold,
        allResults: scored, trainYears: train.length, valYears: val.length,
        outcome: `Selected threshold ${chosen.threshold} — best validation balanced accuracy (${Math.round(chosen.balancedAccuracy * 1000) / 1000}) among ${admissibleCandidates.length} admissible candidates.`
    };
}

// =====================================================================
// OUTER EVALUATION + FROZEN VERDICT
//
// Runs all three procedures on outerTrain (never touching
// outerHoldout during selection), then evaluates whichever thresholds
// were actually selected against the OUTER HOLDOUT exactly once. The
// existing US Model C threshold (45, the walk-forward-tuned
// production reference) is the fixed baseline every procedure must
// beat. No procedure's threshold is adjusted after this point — per
// the frozen stopping rule, there is no fourth attempt.
// =====================================================================

// Existing baseline threshold, per country — the currently-established
// walk-forward-tuned reference for each, NOT re-derived here. Using a
// single shared constant for both countries was a real bug (an
// earlier version of this code applied the US's value to Canada too);
// fixed to be country-specific.
const EXISTING_BASELINE_THRESHOLD = { "United States": 45, Canada: 40 };

function evaluateProcedureOnOuterHoldout(procedureResult, outerHoldout, baselineThreshold) {
    if (!procedureResult || procedureResult.selected === null) {
        return { procedure: procedureResult ? procedureResult.procedure : "unknown", selected: null, passed: false,
            failureReasons: ["No threshold was selected during inner selection — automatic fail."] };
    }

    const threshold = procedureResult.selected;
    const outerMetrics = computeThresholdStabilityMetrics(outerHoldout, threshold);
    const baselineMetrics = computeThresholdStabilityMetrics(outerHoldout, baselineThreshold);

    // ±10 stability swing, measured on the SAME outer holdout — this
    // is evaluation, not selection: the chosen threshold is never
    // adjusted based on what this shows.
    const lowT = Math.max(0, threshold - 10);
    const highT = Math.min(100, threshold + 10);
    const lowMetrics = computeThresholdStabilityMetrics(outerHoldout, lowT);
    const highMetrics = computeThresholdStabilityMetrics(outerHoldout, highT);
    const precisions = [lowMetrics, outerMetrics, highMetrics].map(m => m && m.precision !== null ? m.precision : null).filter(v => v !== null);
    const recalls = [lowMetrics, outerMetrics, highMetrics].map(m => m && m.recall !== null ? m.recall : null).filter(v => v !== null);
    const precisionSwing = precisions.length ? (Math.max(...precisions) - Math.min(...precisions)) * 100 : null;
    const recallSwing = recalls.length ? (Math.max(...recalls) - Math.min(...recalls)) * 100 : null;

    // Frozen acceptance table, checked mechanically:
    const checks = {};
    checks.degenerateFPR = outerMetrics && outerMetrics.falsePositiveRate !== null && outerMetrics.falsePositiveRate < DEGENERACY_FPR_CEILING;
    checks.precisionPositive = outerMetrics && outerMetrics.precision !== null && outerMetrics.precision > 0;
    checks.recallPositive = outerMetrics && outerMetrics.recall !== null && outerMetrics.recall > 0;
    checks.precisionSwingOk = precisionSwing !== null && precisionSwing < 25;
    checks.recallSwingOk = recallSwing !== null && recallSwing < 25;

    // Baseline improvement: at least one primary metric improves
    // without materially worsening the other. "Materially" = more
    // than 5pp, consistent with the tolerance already established for
    // D1's own promotion rule.
    let baselineImproved = false;
    if (outerMetrics && baselineMetrics && outerMetrics.precision !== null && outerMetrics.recall !== null
        && baselineMetrics.precision !== null && baselineMetrics.recall !== null) {
        const precisionGain = outerMetrics.precision - baselineMetrics.precision;
        const recallGain = outerMetrics.recall - baselineMetrics.recall;
        const precisionOk = precisionGain > 0 && recallGain >= -0.05;
        const recallOk = recallGain > 0 && precisionGain >= -0.05;
        baselineImproved = precisionOk || recallOk;
    }
    checks.baselineImproved = baselineImproved;

    const failureReasons = [];
    if (!checks.degenerateFPR) failureReasons.push(`FPR degeneracy gate failed (${outerMetrics ? Math.round(outerMetrics.falsePositiveRate * 1000) / 10 : "n/a"}% ≥ 50%).`);
    if (!checks.precisionPositive) failureReasons.push("Precision is 0% or not computable on the outer holdout.");
    if (!checks.recallPositive) failureReasons.push("Recall is 0% or not computable on the outer holdout.");
    if (!checks.precisionSwingOk) failureReasons.push(`±10 precision swing too large (${precisionSwing !== null ? Math.round(precisionSwing * 10) / 10 : "n/a"}pp ≥ 25pp).`);
    if (!checks.recallSwingOk) failureReasons.push(`±10 recall swing too large (${recallSwing !== null ? Math.round(recallSwing * 10) / 10 : "n/a"}pp ≥ 25pp).`);
    if (!checks.baselineImproved) failureReasons.push("Does not demonstrate improvement over the existing fixed-threshold baseline without materially worsening the other primary metric.");

    const passed = Object.values(checks).every(Boolean);

    return {
        procedure: procedureResult.procedure, selected: threshold, passed, checks, failureReasons,
        outerMetrics, baselineMetrics, precisionSwing, recallSwing
    };
}

function runThresholdStabilityExperiment(country) {
    const backtest = backtestCache[country] || computeBacktest(country);
    if (backtest.insufficientData) return { insufficientData: true };

    const splits = computeNestedSplits(backtest.results, 0.25, 4);
    if (!splits) return { insufficientData: true };

    const procA = runProcedureA(splits.outerTrain);
    const procB = runProcedureB(splits.innerSplits);
    const procC = runProcedureC(splits.outerTrain);

    const baselineThreshold = EXISTING_BASELINE_THRESHOLD[country] ?? 60; // honest fallback for any country without an established reference
    const evalA = evaluateProcedureOnOuterHoldout(procA, splits.outerHoldout, baselineThreshold);
    const evalB = evaluateProcedureOnOuterHoldout(procB, splits.outerHoldout, baselineThreshold);
    const evalC = evaluateProcedureOnOuterHoldout(procC, splits.outerHoldout, baselineThreshold);

    const evaluations = [evalA, evalB, evalC];
    const passing = evaluations.filter(e => e.passed);

    // Per the frozen stopping rule: SUPPORTED if at least one
    // procedure clears every criterion on the untouched outer
    // holdout. NOT SUPPORTED if none do — and no fourth attempt.
    const supported = passing.length > 0;

    return {
        insufficientData: false,
        country, supported,
        outerTrainYears: splits.outerTrainYears, outerHoldoutYears: splits.outerHoldoutYears,
        procedures: { A: procA, B: procB, C: procC },
        evaluations, passing,
        conclusion: supported
            ? `SUPPORTED — ${passing.map(p => p.procedure).join(", ")} cleared every frozen criterion on the untouched outer holdout.`
            : "NOT SUPPORTED — no candidate procedure cleared every frozen criterion. Model C's current US formulation/data does not support a stable, demonstrably-improving classification threshold with these three methods."
    };
}

// =====================================================================
// CONTINUOUS PROBABILITY CALIBRATION EXPERIMENT
//
// Frozen spec: does Model C's raw, UNMODIFIED riskScoreValue/100
// carry genuine calibrated probabilistic information about elevated
// years — independent of whether any binary threshold on it works?
// The raw score is never recalibrated, rescaled, or clipped before
// primary evaluation; slope/intercept are fit and reported as
// diagnostics only, never applied back to the tested score.
// =====================================================================

function computeQuantileBinEdges(trainingScores, numBins) {
    const sorted = [...trainingScores].sort((a, b) => a - b);
    const edges = [];
    for (let i = 1; i < numBins; i++) {
        const idx = (i / numBins) * (sorted.length - 1);
        const lo = Math.floor(idx), hi = Math.ceil(idx);
        const val = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
        edges.push(val);
    }
    return edges;
}

function assignCalibrationBin(score, edges) {
    for (let i = 0; i < edges.length; i++) if (score <= edges[i]) return i;
    return edges.length;
}

function computeNumCalibrationBins(trainingSampleSize) {
    return Math.max(2, Math.min(5, Math.floor(trainingSampleSize / 8)));
}

function computeCalibrationBrier(scores, actuals) {
    let sum = 0;
    for (let i = 0; i < scores.length; i++) sum += (scores[i] - actuals[i]) ** 2;
    return sum / scores.length;
}

function calibrationLogit(p) {
    const c = Math.max(0.01, Math.min(0.99, p));
    return Math.log(c / (1 - c));
}
function calibrationSigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function calibrationLogLoss(predictions, actuals) {
    let sum = 0;
    for (let i = 0; i < predictions.length; i++) {
        const p = Math.max(0.001, Math.min(0.999, predictions[i]));
        sum += actuals[i] === 1 ? -Math.log(p) : -Math.log(1 - p);
    }
    return sum / predictions.length;
}

const CALIBRATION_SLOPE_CANDIDATES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const CALIBRATION_INTERCEPT_CANDIDATES = [-0.15, -0.10, -0.05, 0, 0.05, 0.10, 0.15];

// Fit is diagnostic-only, reported but never used to transform the
// score under test — per the frozen safeguard against silently
// testing a modified Model C.
function fitCalibrationSlopeIntercept(trainScores, trainActuals) {
    let best = { slope: 1, intercept: 0, loss: Infinity };
    for (const slope of CALIBRATION_SLOPE_CANDIDATES) {
        for (const intercept of CALIBRATION_INTERCEPT_CANDIDATES) {
            const preds = trainScores.map(s => calibrationSigmoid(intercept + slope * calibrationLogit(s)));
            const loss = calibrationLogLoss(preds, trainActuals);
            if (loss < best.loss) best = { slope, intercept, loss };
        }
    }
    return best;
}

// Secondary, descriptive-only diagnostics (never pass/fail) —
// distinguishes "well-calibrated but uninformative" from
// "well-calibrated and meaningfully ordered."
function computeCalibrationROCAUC(scores, actuals) {
    const positives = scores.filter((s, i) => actuals[i] === 1);
    const negatives = scores.filter((s, i) => actuals[i] === 0);
    if (!positives.length || !negatives.length) return null;
    let concordant = 0, tied = 0, total = 0;
    for (const p of positives) for (const n of negatives) {
        total++;
        if (p > n) concordant++; else if (p === n) tied++;
    }
    return (concordant + 0.5 * tied) / total;
}

function calibrationRankArray(arr) {
    const indexed = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(arr.length);
    let i = 0;
    while (i < indexed.length) {
        let j = i;
        while (j < indexed.length && indexed[j][0] === indexed[i][0]) j++;
        const avgRank = (i + j - 1) / 2 + 1;
        for (let k = i; k < j; k++) ranks[indexed[k][1]] = avgRank;
        i = j;
    }
    return ranks;
}

function computeCalibrationSpearman(scores, actuals) {
    const n = scores.length;
    if (n < 2) return null;
    const rs = calibrationRankArray(scores), ra = calibrationRankArray(actuals);
    const meanRS = rs.reduce((a, b) => a + b, 0) / n, meanRA = ra.reduce((a, b) => a + b, 0) / n;
    let num = 0, denS = 0, denA = 0;
    for (let i = 0; i < n; i++) {
        num += (rs[i] - meanRS) * (ra[i] - meanRA);
        denS += (rs[i] - meanRS) ** 2; denA += (ra[i] - meanRA) ** 2;
    }
    const den = Math.sqrt(denS * denA);
    return den > 0 ? num / den : null;
}

const CALIBRATION_MIN_TRAIN_SIZE = 16; // needs floor(N/8) >= 2 for at least 2 bins
const CALIBRATION_MIN_BUCKET_N = 5;
const CALIBRATION_NUM_WINDOWS = 4;

function computeCalibrationWindows(backtestResults, numWindows) {
    const n = backtestResults.length;
    const evalBlockSize = Math.floor((n - CALIBRATION_MIN_TRAIN_SIZE) / numWindows);
    if (evalBlockSize < 2) return [];
    const windows = [];
    for (let w = 0; w < numWindows; w++) {
        const trainEnd = CALIBRATION_MIN_TRAIN_SIZE + w * evalBlockSize;
        const evalEnd = (w === numWindows - 1) ? n : trainEnd + evalBlockSize;
        if (trainEnd >= n || evalEnd <= trainEnd) continue;
        windows.push({ train: backtestResults.slice(0, trainEnd), evaluation: backtestResults.slice(trainEnd, evalEnd) });
    }
    return windows;
}

function evaluateCalibrationWindow(window) {
    const trainRows = window.train.filter(r => r.riskScoreValue !== null);
    const trainScores = trainRows.map(r => r.riskScoreValue / 100);
    const trainActuals = trainRows.map(r => r.actualElevated ? 1 : 0);
    const evalRows = window.evaluation.filter(r => r.riskScoreValue !== null);
    const evalScores = evalRows.map(r => r.riskScoreValue / 100);
    const evalActuals = evalRows.map(r => r.actualElevated ? 1 : 0);

    if (trainScores.length < CALIBRATION_MIN_TRAIN_SIZE || !evalScores.length) {
        return { evaluable: false, reason: "Insufficient training or evaluation data." };
    }

    const numBins = computeNumCalibrationBins(trainScores.length);
    const edges = computeQuantileBinEdges(trainScores, numBins);

    const buckets = [];
    for (let b = 0; b < numBins; b++) {
        const idxs = evalScores.map((s, i) => (assignCalibrationBin(s, edges) === b ? i : -1)).filter(i => i >= 0);
        const bn = idxs.length;
        const predicted = bn ? idxs.reduce((s, i) => s + evalScores[i], 0) / bn : null;
        const observed = bn ? idxs.reduce((s, i) => s + evalActuals[i], 0) / bn : null;
        buckets.push({ bucket: b, n: bn, predicted, observed, adequatelySampled: bn >= CALIBRATION_MIN_BUCKET_N });
    }

    const adequateBuckets = buckets.filter(b => b.adequatelySampled);
    if (adequateBuckets.length < 2) {
        return { evaluable: false, reason: `Only ${adequateBuckets.length} adequately-sampled bucket(s) — need at least 2.`, buckets };
    }

    const baseRate = trainActuals.reduce((a, b) => a + b, 0) / trainActuals.length;
    const baselinePredictions = evalScores.map(() => baseRate);
    const baselineBrier = computeCalibrationBrier(baselinePredictions, evalActuals);
    const modelBrier = computeCalibrationBrier(evalScores, evalActuals);
    const brierImprovement = baselineBrier - modelBrier;

    const totalAdequateN = adequateBuckets.reduce((s, b) => s + b.n, 0);
    const calibrationError = adequateBuckets.reduce((s, b) => s + Math.abs(b.predicted - b.observed) * b.n, 0) / totalAdequateN;

    const fit = fitCalibrationSlopeIntercept(trainScores, trainActuals); // training only, never applied to evalScores

    const rocAuc = computeCalibrationROCAUC(evalScores, evalActuals);
    const spearman = computeCalibrationSpearman(evalScores, evalActuals);

    const checks = {
        brierImprovement: brierImprovement >= 0.02,
        calibrationError: calibrationError < 0.15,
        slope: fit.slope >= 0.5 && fit.slope <= 1.5,
        intercept: fit.intercept >= -0.15 && fit.intercept <= 0.15
    };
    const passed = Object.values(checks).every(Boolean);

    return {
        evaluable: true, passed, checks,
        trainYears: trainScores.length, evalYears: evalScores.length,
        numBins, buckets, adequateBucketCount: adequateBuckets.length,
        baseRate, baselineBrier: Math.round(baselineBrier * 1000) / 1000, modelBrier: Math.round(modelBrier * 1000) / 1000,
        brierImprovement: Math.round(brierImprovement * 1000) / 1000,
        calibrationError: Math.round(calibrationError * 1000) / 1000,
        slope: fit.slope, intercept: fit.intercept,
        rocAuc: rocAuc !== null ? Math.round(rocAuc * 1000) / 1000 : null,
        spearman: spearman !== null ? Math.round(spearman * 1000) / 1000 : null
    };
}

function runContinuousCalibrationExperiment(country) {
    const backtest = backtestCache[country] || computeBacktest(country);
    if (backtest.insufficientData) return { insufficientData: true };

    const windows = computeCalibrationWindows(backtest.results, CALIBRATION_NUM_WINDOWS);
    if (!windows.length) return { insufficientData: true };

    const results = windows.map(evaluateCalibrationWindow);
    const evaluableResults = results.filter(r => r.evaluable);
    const passingResults = evaluableResults.filter(r => r.passed);

    const totalWindows = results.length;
    const evaluableCount = evaluableResults.length;
    const passingCount = passingResults.length;

    let verdict;
    if (evaluableCount / totalWindows <= 0.5) {
        verdict = "INCONCLUSIVE";
    } else if (passingCount / evaluableCount > 0.5) {
        verdict = "SUPPORTED";
    } else {
        verdict = "NOT SUPPORTED";
    }

    function avgOf(key) {
        const vals = evaluableResults.map(r => r[key]).filter(v => v !== null && v !== undefined);
        return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000 : null;
    }

    return {
        insufficientData: false, country, verdict,
        totalWindows, evaluableCount, passingCount,
        avgBrierImprovement: avgOf('brierImprovement'),
        avgCalibrationError: avgOf('calibrationError'),
        avgSlope: avgOf('slope'),
        avgIntercept: avgOf('intercept'),
        avgRocAuc: avgOf('rocAuc'),
        avgSpearman: avgOf('spearman'),
        windowResults: results
    };
}

// =====================================================================
// FORECAST CLOCK / SHF-1 — foundational layer
//
// Frozen spec: "Given the information available at forecast time, what
// is the probability that at least one qualifying NHIRA incident will
// occur during the subsequent 7, 10, or 15 calendar days?"
//
// Interval definition (frozen): EXCLUSIVE of forecast date — days +1
// through +N. A forecast made using data through day D predicts a
// window that begins D+1 and runs N full calendar days. This matches
// the non-overlapping block structure used in the real base-rate
// diagnostic that justified the "elevated = >=1 incident" definition.
//
// Builds directly on production Model C. Read-only against
// history.json and the production Risk Score — never modifies either.
// =====================================================================

// Build a per-country daily incident-count map from the real
// dataset. Keys are ISO date strings; only days with at least one
// incident get an entry (sparse map, not a dense array — the
// historical span is ~124 years, a dense per-day array would be
// wasteful and isn't needed for block-sum lookups).
function buildDailyIncidentMap(country) {
    const map = {};
    let minDate = null, maxDate = null;
    for (const e of events) {
        if (e.country !== country || !e.date) continue;
        map[e.date] = (map[e.date] || 0) + 1;
        const d = new Date(e.date + 'T00:00:00Z');
        if (!minDate || d < minDate) minDate = d;
        if (!maxDate || d > maxDate) maxDate = d;
    }
    return { map, minDate, maxDate };
}

function addDaysISO(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

// Sum incidents across a window of `windowLen` calendar days starting
// at `startDateISO` (inclusive of start, i.e. startDateISO is the
// first day counted).
function sumIncidentsInWindow(dailyMap, startDateISO, windowLen) {
    let sum = 0;
    for (let i = 0; i < windowLen; i++) {
        const d = addDaysISO(startDateISO, i);
        sum += dailyMap[d] || 0;
    }
    return sum;
}

// Genuinely non-overlapping blocks of `windowLen` days across the
// full historical span, per the frozen interval definition. Each
// block's forecastOrigin is the day BEFORE the block starts (day D,
// with the block itself being D+1 through D+windowLen) — this is what
// "exclusive of forecast date" means concretely.
function buildNonOverlappingBlocks(country, windowLen) {
    const { map, minDate, maxDate } = buildDailyIncidentMap(country);
    if (!minDate || !maxDate) return [];

    const blocks = [];
    let cur = minDate.toISOString().slice(0, 10);
    const maxISO = maxDate.toISOString().slice(0, 10);
    while (cur <= maxISO) {
        const incidentCount = sumIncidentsInWindow(map, cur, windowLen);
        blocks.push({
            blockStart: cur,
            blockEnd: addDaysISO(cur, windowLen - 1),
            forecastOrigin: addDaysISO(cur, -1), // the day BEFORE the block — exclusive boundary
            incidentCount,
            elevated: incidentCount >= 1
        });
        cur = addDaysISO(cur, windowLen);
    }
    return blocks;
}

// =====================================================================
// BASELINE MODEL — the control every later layer (EWMA, CUSUM, spatial
// signal) must beat by the pre-registered margin or be rejected.
//
// Deliberately simple: historical rate of elevated blocks among
// TRAINING blocks starting in the same calendar month as the block
// being forecast. Falls back to the flat training-wide rate when
// there isn't enough month-matched history — disclosed explicitly in
// the output, never silently blended. No threshold optimization, no
// tuning — a rate estimate, nothing more.
// =====================================================================

const FC_MIN_INITIAL_TRAINING_BLOCKS = 20; // some history required before the first prediction is attempted
const FC_MIN_MONTH_MATCHED_BLOCKS = 8;     // below this, fall back to the flat rate rather than trust a thin month-specific estimate

function getCalendarMonth(dateISO) {
    return parseInt(dateISO.slice(5, 7), 10); // 1-12
}

// Computed from `trainingBlocks` ONLY — the caller is responsible for
// ensuring these are strictly prior to the block being forecast.
function computeBaselineForBlock(trainingBlocks, targetBlock) {
    if (!trainingBlocks.length) return null;

    const targetMonth = getCalendarMonth(targetBlock.blockStart);
    const monthMatched = trainingBlocks.filter(b => getCalendarMonth(b.blockStart) === targetMonth);

    if (monthMatched.length >= FC_MIN_MONTH_MATCHED_BLOCKS) {
        const rate = monthMatched.filter(b => b.elevated).length / monthMatched.length;
        return { predictedProbability: rate, method: "calendar-month-matched", trainingN: monthMatched.length };
    }

    const flatRate = trainingBlocks.filter(b => b.elevated).length / trainingBlocks.length;
    return { predictedProbability: flatRate, method: "flat-fallback", trainingN: trainingBlocks.length };
}

// Full walk-forward run for one country/horizon: at each step, the
// baseline is computed from blocks STRICTLY BEFORE the target block
// (frozen prediction), then the target block's actual outcome is
// revealed for scoring — never the reverse.
function runBaselineWalkForward(country, windowLen) {
    const allBlocks = buildNonOverlappingBlocks(country, windowLen);
    if (allBlocks.length <= FC_MIN_INITIAL_TRAINING_BLOCKS) return { insufficientData: true };

    const results = [];
    for (let i = FC_MIN_INITIAL_TRAINING_BLOCKS; i < allBlocks.length; i++) {
        const trainingBlocks = allBlocks.slice(0, i);
        const targetBlock = allBlocks[i];
        const baseline = computeBaselineForBlock(trainingBlocks, targetBlock);
        if (!baseline) continue;
        results.push({
            blockStart: targetBlock.blockStart,
            forecastOrigin: targetBlock.forecastOrigin,
            predictedProbability: Math.round(baseline.predictedProbability * 1000) / 1000,
            method: baseline.method,
            trainingN: baseline.trainingN,
            actualElevated: targetBlock.elevated
        });
    }

    if (!results.length) return { insufficientData: true };

    const n = results.length;
    const brier = results.reduce((s, r) => s + (r.predictedProbability - (r.actualElevated ? 1 : 0)) ** 2, 0) / n;
    const monthMatchedCount = results.filter(r => r.method === "calendar-month-matched").length;

    return {
        insufficientData: false,
        country, windowLen, n,
        brier: Math.round(brier * 1000) / 1000,
        monthMatchedPct: Math.round((monthMatchedCount / n) * 1000) / 10,
        results
    };
}

// =====================================================================
// EWMA — does recent activity contain predictive information beyond
// the calendar-position baseline?
//
// Nested structure required here (unlike the baseline) because there
// is a parameter to select: outer train/test split, decay chosen via
// its own inner walk-forward using ONLY the outer-train blocks, then
// evaluated exactly once on the outer-test blocks the selection never
// saw. Baseline is recomputed restricted to the SAME outer-test
// blocks for a fair, matched comparison — comparing against the
// baseline's full-series Brier would not be apples-to-apples.
// =====================================================================

const FC_EWMA_DECAY_CANDIDATES = [0.1, 0.2, 0.3, 0.4, 0.5]; // frozen, exactly as specified
const FC_OUTER_TRAIN_FRACTION = 0.7;
const FC_BRIER_IMPROVEMENT_MARGIN = 0.02; // same margin used throughout this project

// Walk an EWMA of the elevated indicator forward across `blocks`,
// seeded from the flat rate of the first FC_MIN_INITIAL_TRAINING_BLOCKS
// of those blocks. Returns predictions for every block AFTER the seed
// window — each prediction uses only blocks strictly before it.
function walkEWMA(blocks, decay) {
    if (blocks.length <= FC_MIN_INITIAL_TRAINING_BLOCKS) return null;
    const seed = blocks.slice(0, FC_MIN_INITIAL_TRAINING_BLOCKS);
    let ewma = seed.filter(b => b.elevated).length / seed.length;

    const results = [];
    for (let i = FC_MIN_INITIAL_TRAINING_BLOCKS; i < blocks.length; i++) {
        const block = blocks[i];
        results.push({
            blockStart: block.blockStart,
            predictedProbability: ewma,
            actualElevated: block.elevated
        });
        const outcome = block.elevated ? 1 : 0;
        ewma = decay * outcome + (1 - decay) * ewma; // update AFTER prediction, using this block's own outcome
    }
    return { results, finalEwma: ewma };
}

function brierOf(results) {
    if (!results.length) return null;
    return results.reduce((s, r) => s + (r.predictedProbability - (r.actualElevated ? 1 : 0)) ** 2, 0) / results.length;
}

function runEWMAExperiment(country, windowLen) {
    const allBlocks = buildNonOverlappingBlocks(country, windowLen);
    const splitIdx = Math.floor(allBlocks.length * FC_OUTER_TRAIN_FRACTION);
    const outerTrain = allBlocks.slice(0, splitIdx);
    const outerTest = allBlocks.slice(splitIdx);
    if (outerTrain.length <= FC_MIN_INITIAL_TRAINING_BLOCKS || !outerTest.length) return { insufficientData: true };

    // Selection: for each candidate decay, walk EWMA WITHIN outerTrain
    // only, score its own walk-forward Brier — never touches outerTest.
    const candidateScores = FC_EWMA_DECAY_CANDIDATES.map(decay => {
        const walk = walkEWMA(outerTrain, decay);
        return { decay, trainBrier: walk ? brierOf(walk.results) : null };
    });
    const withScore = candidateScores.filter(c => c.trainBrier !== null);
    if (!withScore.length) return { insufficientData: true };
    const chosen = withScore.reduce((best, c) => (c.trainBrier < best.trainBrier ? c : best), withScore[0]);

    // Evaluation: walk EWMA across the FULL series (outerTrain then
    // outerTest) using the chosen decay, so the EWMA's internal state
    // entering outerTest reflects genuine accumulated history — but
    // only outerTest's own predictions are scored.
    const fullWalk = walkEWMA(allBlocks, chosen.decay);
    const testResults = fullWalk.results.filter(r => outerTest.some(b => b.blockStart === r.blockStart));

    const ewmaBrier = brierOf(testResults);

    // Baseline restricted to the SAME outerTest blocks for a fair comparison.
    const fullBaseline = runBaselineWalkForward(country, windowLen);
    const baselineTestResults = fullBaseline.insufficientData ? [] :
        fullBaseline.results.filter(r => outerTest.some(b => b.blockStart === r.blockStart));
    const baselineBrierOnTest = brierOf(baselineTestResults);

    const improvement = baselineBrierOnTest !== null ? baselineBrierOnTest - ewmaBrier : null;
    const passed = improvement !== null && improvement >= FC_BRIER_IMPROVEMENT_MARGIN;

    return {
        insufficientData: false,
        country, windowLen,
        outerTrainN: outerTrain.length, outerTestN: outerTest.length,
        candidateScores,
        chosenDecay: chosen.decay,
        ewmaBrierOnTest: Math.round(ewmaBrier * 1000) / 1000,
        baselineBrierOnTest: Math.round(baselineBrierOnTest * 1000) / 1000,
        improvement: Math.round(improvement * 1000) / 1000,
        passed,
        conclusion: passed
            ? `EWMA beats baseline by ${Math.round(improvement * 1000) / 1000} (>= ${FC_BRIER_IMPROVEMENT_MARGIN} margin) — recent activity adds information beyond calendar position.`
            : `EWMA does not clear the ${FC_BRIER_IMPROVEMENT_MARGIN} margin over baseline (actual: ${Math.round(improvement * 1000) / 1000}) — stop here, do not tune further.`
    };
}

// =====================================================================
// CUSUM — does a SUSTAINED shift signal add anything EWMA doesn't?
//
// A genuinely different mechanism from EWMA: tracks the cumulative
// deviation of outcomes from the training baseline rate, only firing
// once that deviation has persisted past a slack allowance — designed
// to catch sustained regime change rather than smooth recency
// weighting. Run independently for every country/horizon per the
// frozen pipeline, regardless of how EWMA performed there — a failure
// at one pipeline stage is not grounds to skip a structurally
// different next one, per the standard already set by the
// threshold-stability experiment.
//
// Parameters disclosed and fixed here (the frozen spec named the
// selection METHOD — training-only walk-forward, same as EWMA — but
// left the exact candidate values to be set at implementation, same
// as it did for the baseline's own internal constants).
// =====================================================================

const FC_CUSUM_SLACK_CANDIDATES = [0.01, 0.02, 0.03];      // k: allowance before a deviation starts accumulating
const FC_CUSUM_THRESHOLD_CANDIDATES = [0.05, 0.10, 0.15];  // h: cumulative deviation required to enter "alarm" state

// Walks a one-sided CUSUM (detecting increases) across `blocks`,
// seeded the same way as EWMA. While in "alarm" state, the predicted
// probability is the empirically observed elevated-rate during past
// alarm periods within the blocks walked so far (data-derived, not an
// arbitrary constant) — falls back to the flat training rate if no
// alarm has fired yet, exactly like the baseline's own fallback logic.
function walkCUSUM(blocks, slack, threshold) {
    if (blocks.length <= FC_MIN_INITIAL_TRAINING_BLOCKS) return null;
    const seed = blocks.slice(0, FC_MIN_INITIAL_TRAINING_BLOCKS);
    const mu = seed.filter(b => b.elevated).length / seed.length;

    let S = 0;
    let alarmOutcomes = []; // outcomes observed while in alarm state so far, for the data-derived alarm-rate
    const results = [];

    for (let i = FC_MIN_INITIAL_TRAINING_BLOCKS; i < blocks.length; i++) {
        const block = blocks[i];
        const inAlarm = S >= threshold;
        const predictedProbability = inAlarm && alarmOutcomes.length > 0
            ? alarmOutcomes.reduce((s, o) => s + o, 0) / alarmOutcomes.length
            : mu;

        results.push({
            blockStart: block.blockStart,
            predictedProbability,
            inAlarm,
            actualElevated: block.elevated
        });

        const outcome = block.elevated ? 1 : 0;
        if (inAlarm) alarmOutcomes.push(outcome);
        S = Math.max(0, S + (outcome - mu - slack));
    }
    return { results };
}

function runCUSUMExperiment(country, windowLen) {
    const allBlocks = buildNonOverlappingBlocks(country, windowLen);
    const splitIdx = Math.floor(allBlocks.length * FC_OUTER_TRAIN_FRACTION);
    const outerTrain = allBlocks.slice(0, splitIdx);
    const outerTest = allBlocks.slice(splitIdx);
    if (outerTrain.length <= FC_MIN_INITIAL_TRAINING_BLOCKS || !outerTest.length) return { insufficientData: true };

    // Selection: sweep the (slack, threshold) grid using ONLY
    // outerTrain's own walk-forward — never touches outerTest.
    const candidateScores = [];
    for (const slack of FC_CUSUM_SLACK_CANDIDATES) {
        for (const threshold of FC_CUSUM_THRESHOLD_CANDIDATES) {
            const walk = walkCUSUM(outerTrain, slack, threshold);
            candidateScores.push({ slack, threshold, trainBrier: walk ? brierOf(walk.results) : null });
        }
    }
    const withScore = candidateScores.filter(c => c.trainBrier !== null);
    if (!withScore.length) return { insufficientData: true };
    const chosen = withScore.reduce((best, c) => (c.trainBrier < best.trainBrier ? c : best), withScore[0]);

    // Evaluation: walk CUSUM across the full series with the chosen
    // parameters so its state entering outerTest reflects genuine
    // accumulated history, scoring only outerTest's own predictions.
    const fullWalk = walkCUSUM(allBlocks, chosen.slack, chosen.threshold);
    const testResults = fullWalk.results.filter(r => outerTest.some(b => b.blockStart === r.blockStart));
    const cusumBrier = brierOf(testResults);
    const alarmBlockCount = testResults.filter(r => r.inAlarm).length;

    const fullBaseline = runBaselineWalkForward(country, windowLen);
    const baselineTestResults = fullBaseline.insufficientData ? [] :
        fullBaseline.results.filter(r => outerTest.some(b => b.blockStart === r.blockStart));
    const baselineBrierOnTest = brierOf(baselineTestResults);

    const improvement = baselineBrierOnTest !== null ? baselineBrierOnTest - cusumBrier : null;
    const passed = improvement !== null && improvement >= FC_BRIER_IMPROVEMENT_MARGIN;

    return {
        insufficientData: false,
        country, windowLen,
        outerTrainN: outerTrain.length, outerTestN: outerTest.length,
        chosenSlack: chosen.slack, chosenThreshold: chosen.threshold,
        alarmBlockCount, alarmPct: Math.round((alarmBlockCount / testResults.length) * 1000) / 10,
        cusumBrierOnTest: Math.round(cusumBrier * 1000) / 1000,
        baselineBrierOnTest: Math.round(baselineBrierOnTest * 1000) / 1000,
        improvement: Math.round(improvement * 1000) / 1000,
        passed,
        conclusion: passed
            ? `CUSUM beats baseline by ${Math.round(improvement * 1000) / 1000} (>= ${FC_BRIER_IMPROVEMENT_MARGIN} margin) — sustained-shift detection adds information beyond calendar position.`
            : `CUSUM does not clear the ${FC_BRIER_IMPROVEMENT_MARGIN} margin over baseline (actual: ${Math.round(improvement * 1000) / 1000}) — stop here, do not tune further.`
    };
}

// =====================================================================
// SIMPLE SPATIAL SIGNAL — two distinct questions, kept separate:
//   (A) Does geographic concentration predict elevation BY ITSELF
//       (vs. the calendar baseline)?
//   (B) Does COMBINING it with EWMA (the best validated temporal
//       signal) beat EWMA ALONE — i.e. does it add information EWMA
//       didn't already capture?
// (B) is the scientifically important question per the frozen spec.
// Deliberately simple: a fixed lookback window, one selected
// threshold splitting "concentrated" vs "spread out" recent activity,
// predicting the training-derived elevated rate for whichever bucket
// applies — no Hawkes process, no spatial ML.
// =====================================================================

const FC_SPATIAL_LOOKBACK_DAYS = 60; // fixed and disclosed, not swept — keeps this genuinely simple
const FC_SPATIAL_THRESHOLD_CANDIDATES = [0.34, 0.5, 0.67, 1.0];
const FC_SPATIAL_EWMA_BLEND_CANDIDATES = [0, 0.25, 0.5, 0.75, 1.0]; // 0 = pure EWMA, 1 = pure spatial

function buildDailyStateMap(country) {
    const map = {};
    for (const e of events) {
        if (e.country !== country || !e.date || !e.state) continue;
        if (!map[e.date]) map[e.date] = [];
        map[e.date].push(e.state);
    }
    return map;
}

// Concentration ratio for the lookbackDays-day window ENDING ON AND
// INCLUDING forecastOrigin (i.e. "information available at forecast
// time," matching the frozen research question's exact wording). 1.0
// = all recent incidents in a single state; lower = spread out.
// Returns null if there was no recent activity to measure.
function computeConcentrationRatio(dailyStateMap, forecastOrigin, lookbackDays) {
    const stateCounts = {};
    let total = 0;
    for (let i = 0; i < lookbackDays; i++) {
        const d = addDaysISO(forecastOrigin, -i);
        const states = dailyStateMap[d];
        if (states) for (const s of states) { stateCounts[s] = (stateCounts[s] || 0) + 1; total++; }
    }
    if (total === 0) return null;
    return Math.max(...Object.values(stateCounts)) / total;
}

// Walks the spatial-alone predictor across `blocks`. Seeded the same
// way as the other models. While concentration is unmeasurable (no
// recent activity), falls back to the flat training rate — same
// discipline as everywhere else.
function walkSpatial(blocks, dailyStateMap, threshold) {
    if (blocks.length <= FC_MIN_INITIAL_TRAINING_BLOCKS) return null;
    const seed = blocks.slice(0, FC_MIN_INITIAL_TRAINING_BLOCKS);
    const mu = seed.filter(b => b.elevated).length / seed.length;

    let highOutcomes = [], lowOutcomes = [];
    // Seed the bucket-rate estimators using the seed window itself so
    // there's *some* bucket-specific history before real predictions start.
    for (const b of seed) {
        const ratio = computeConcentrationRatio(dailyStateMap, b.forecastOrigin, FC_SPATIAL_LOOKBACK_DAYS);
        if (ratio === null) continue;
        (ratio >= threshold ? highOutcomes : lowOutcomes).push(b.elevated ? 1 : 0);
    }

    const results = [];
    for (let i = FC_MIN_INITIAL_TRAINING_BLOCKS; i < blocks.length; i++) {
        const block = blocks[i];
        const ratio = computeConcentrationRatio(dailyStateMap, block.forecastOrigin, FC_SPATIAL_LOOKBACK_DAYS);
        let predictedProbability, bucket;
        if (ratio === null) {
            predictedProbability = mu; bucket = "no-recent-activity";
        } else if (ratio >= threshold) {
            predictedProbability = highOutcomes.length ? highOutcomes.reduce((s, o) => s + o, 0) / highOutcomes.length : mu;
            bucket = "high-concentration";
        } else {
            predictedProbability = lowOutcomes.length ? lowOutcomes.reduce((s, o) => s + o, 0) / lowOutcomes.length : mu;
            bucket = "low-concentration";
        }
        results.push({ blockStart: block.blockStart, predictedProbability, bucket, ratio, actualElevated: block.elevated });

        const outcome = block.elevated ? 1 : 0;
        if (ratio !== null) (ratio >= threshold ? highOutcomes : lowOutcomes).push(outcome);
    }
    return { results };
}

// Question A: does spatial concentration predict elevation BY ITSELF,
// vs. the calendar baseline? Same nested structure as EWMA/CUSUM.
function runSpatialAloneExperiment(country, windowLen) {
    const allBlocks = buildNonOverlappingBlocks(country, windowLen);
    const dailyStateMap = buildDailyStateMap(country);
    const splitIdx = Math.floor(allBlocks.length * FC_OUTER_TRAIN_FRACTION);
    const outerTrain = allBlocks.slice(0, splitIdx);
    const outerTest = allBlocks.slice(splitIdx);
    if (outerTrain.length <= FC_MIN_INITIAL_TRAINING_BLOCKS || !outerTest.length) return { insufficientData: true };

    const candidateScores = FC_SPATIAL_THRESHOLD_CANDIDATES.map(threshold => {
        const walk = walkSpatial(outerTrain, dailyStateMap, threshold);
        return { threshold, trainBrier: walk ? brierOf(walk.results) : null };
    });
    const withScore = candidateScores.filter(c => c.trainBrier !== null);
    if (!withScore.length) return { insufficientData: true };
    const chosen = withScore.reduce((best, c) => (c.trainBrier < best.trainBrier ? c : best), withScore[0]);

    const fullWalk = walkSpatial(allBlocks, dailyStateMap, chosen.threshold);
    const testResults = fullWalk.results.filter(r => outerTest.some(b => b.blockStart === r.blockStart));
    const spatialBrier = brierOf(testResults);

    const fullBaseline = runBaselineWalkForward(country, windowLen);
    const baselineTestResults = fullBaseline.insufficientData ? [] :
        fullBaseline.results.filter(r => outerTest.some(b => b.blockStart === r.blockStart));
    const baselineBrierOnTest = brierOf(baselineTestResults);

    const improvement = baselineBrierOnTest !== null ? baselineBrierOnTest - spatialBrier : null;
    const passed = improvement !== null && improvement >= FC_BRIER_IMPROVEMENT_MARGIN;

    return {
        insufficientData: false, country, windowLen,
        chosenThreshold: chosen.threshold,
        spatialBrierOnTest: Math.round(spatialBrier * 1000) / 1000,
        baselineBrierOnTest: Math.round(baselineBrierOnTest * 1000) / 1000,
        improvement: Math.round(improvement * 1000) / 1000,
        passed,
        question: "Does spatial concentration predict elevation by itself (vs. baseline)?"
    };
}

// Question B — the scientifically important one: does COMBINING
// spatial with EWMA beat EWMA ALONE? Blend weight selected using only
// outerTrain's own walk-forward, evaluated once on outerTest.
function runSpatialPlusEWMAExperiment(country, windowLen) {
    const allBlocks = buildNonOverlappingBlocks(country, windowLen);
    const dailyStateMap = buildDailyStateMap(country);
    const splitIdx = Math.floor(allBlocks.length * FC_OUTER_TRAIN_FRACTION);
    const outerTrain = allBlocks.slice(0, splitIdx);
    const outerTest = allBlocks.slice(splitIdx);
    if (outerTrain.length <= FC_MIN_INITIAL_TRAINING_BLOCKS || !outerTest.length) return { insufficientData: true };

    // Reuse EWMA's own already-selected decay (the frozen, already-
    // validated temporal signal) rather than re-selecting it here —
    // this experiment is specifically about whether spatial adds
    // anything to THAT signal, not about re-tuning EWMA.
    const ewmaExp = runEWMAExperiment(country, windowLen);
    if (ewmaExp.insufficientData) return { insufficientData: true };
    const ewmaDecay = ewmaExp.chosenDecay;

    // Spatial threshold is selected the same way as Question A, using
    // only outerTrain.
    const spatialCandidateScores = FC_SPATIAL_THRESHOLD_CANDIDATES.map(threshold => {
        const walk = walkSpatial(outerTrain, dailyStateMap, threshold);
        return { threshold, trainBrier: walk ? brierOf(walk.results) : null };
    });
    const spatialWithScore = spatialCandidateScores.filter(c => c.trainBrier !== null);
    if (!spatialWithScore.length) return { insufficientData: true };
    const chosenSpatialThreshold = spatialWithScore.reduce((best, c) => (c.trainBrier < best.trainBrier ? c : best), spatialWithScore[0]).threshold;

    // Build full-series EWMA and spatial predictions once, keyed by blockStart.
    const ewmaFullWalk = walkEWMA(allBlocks, ewmaDecay);
    const spatialFullWalk = walkSpatial(allBlocks, dailyStateMap, chosenSpatialThreshold);
    const ewmaByBlock = {}; for (const r of ewmaFullWalk.results) ewmaByBlock[r.blockStart] = r.predictedProbability;
    const spatialByBlock = {}; for (const r of spatialFullWalk.results) spatialByBlock[r.blockStart] = r.predictedProbability;

    function blendedResultsFor(blockList, weight) {
        return blockList
            .filter(b => ewmaByBlock[b.blockStart] !== undefined && spatialByBlock[b.blockStart] !== undefined)
            .map(b => ({
                blockStart: b.blockStart,
                predictedProbability: weight * spatialByBlock[b.blockStart] + (1 - weight) * ewmaByBlock[b.blockStart],
                actualElevated: b.elevated
            }));
    }

    // Select blend weight using ONLY outerTrain's own walk-forward Brier.
    const blendCandidateScores = FC_SPATIAL_EWMA_BLEND_CANDIDATES.map(weight => {
        const res = blendedResultsFor(outerTrain, weight);
        return { weight, trainBrier: res.length ? brierOf(res) : null };
    });
    const blendWithScore = blendCandidateScores.filter(c => c.trainBrier !== null);
    if (!blendWithScore.length) return { insufficientData: true };
    const chosenWeight = blendWithScore.reduce((best, c) => (c.trainBrier < best.trainBrier ? c : best), blendWithScore[0]).weight;

    // Evaluate on outerTest only.
    const blendedTestResults = blendedResultsFor(outerTest, chosenWeight);
    const combinedBrier = brierOf(blendedTestResults);

    // Compare against EWMA ALONE on the SAME outerTest blocks (not baseline).
    const ewmaTestResults = outerTest
        .filter(b => ewmaByBlock[b.blockStart] !== undefined)
        .map(b => ({ blockStart: b.blockStart, predictedProbability: ewmaByBlock[b.blockStart], actualElevated: b.elevated }));
    const ewmaAloneBrierOnTest = brierOf(ewmaTestResults);

    const improvement = ewmaAloneBrierOnTest !== null ? ewmaAloneBrierOnTest - combinedBrier : null;
    const passed = improvement !== null && improvement >= FC_BRIER_IMPROVEMENT_MARGIN;

    return {
        insufficientData: false, country, windowLen,
        ewmaDecayUsed: ewmaDecay, chosenSpatialThreshold, chosenBlendWeight: chosenWeight,
        combinedBrierOnTest: Math.round(combinedBrier * 1000) / 1000,
        ewmaAloneBrierOnTest: Math.round(ewmaAloneBrierOnTest * 1000) / 1000,
        improvement: Math.round(improvement * 1000) / 1000,
        passed,
        question: "Does spatial concentration add information beyond what EWMA already captured?",
        conclusion: passed
            ? `Combined beats EWMA alone by ${Math.round(improvement * 1000) / 1000} (>= ${FC_BRIER_IMPROVEMENT_MARGIN}) — spatial adds genuine new information.`
            : `Combined does not clear the margin over EWMA alone (actual: ${Math.round(improvement * 1000) / 1000}) — spatial adds nothing EWMA didn't already capture. Stop here.`
    };
}

// =====================================================================
// EWMA PROBABILITY CALIBRATION — the final pipeline stage.
//
// Reuses the exact calibration machinery already proven for Model C's
// annual continuous-calibration experiment (bin edges, calibration
// error, slope/intercept, ROC-AUC, Spearman, adequate-sample rules) —
// those functions are generic and were never specific to the annual
// context. Applied here to EWMA's raw block-level probabilities using
// EWMA's already-frozen decay parameter (re-selecting it now would be
// exactly the post-hoc tuning this discipline exists to prevent).
//
// This is a genuinely separate, undetermined question from "does EWMA
// beat baseline" — a model can win on Brier improvement while still
// being poorly calibrated, and the reverse. The verdict here is not
// constrained by EWMA's earlier pass/fail result.
// =====================================================================

const FC_CALIBRATION_NUM_WINDOWS = 4; // same as the annual Model C calibration experiment

function buildEWMACalibrationWindows(ewmaResults, numWindows) {
    const n = ewmaResults.length;
    const evalBlockSize = Math.floor((n - CALIBRATION_MIN_TRAIN_SIZE) / numWindows);
    if (evalBlockSize < 2) return [];
    const windows = [];
    for (let w = 0; w < numWindows; w++) {
        const trainEnd = CALIBRATION_MIN_TRAIN_SIZE + w * evalBlockSize;
        const evalEnd = (w === numWindows - 1) ? n : trainEnd + evalBlockSize;
        if (trainEnd >= n || evalEnd <= trainEnd) continue;
        windows.push({ train: ewmaResults.slice(0, trainEnd), evaluation: ewmaResults.slice(trainEnd, evalEnd) });
    }
    return windows;
}

function evaluateEWMACalibrationWindow(window) {
    const trainScores = window.train.map(r => r.predictedProbability);
    const trainActuals = window.train.map(r => r.actualElevated ? 1 : 0);
    const evalScores = window.evaluation.map(r => r.predictedProbability);
    const evalActuals = window.evaluation.map(r => r.actualElevated ? 1 : 0);

    if (trainScores.length < CALIBRATION_MIN_TRAIN_SIZE || !evalScores.length) {
        return { evaluable: false, reason: "Insufficient training or evaluation data." };
    }

    const numBins = computeNumCalibrationBins(trainScores.length);
    const edges = computeQuantileBinEdges(trainScores, numBins);

    const buckets = [];
    for (let b = 0; b < numBins; b++) {
        const idxs = evalScores.map((s, i) => (assignCalibrationBin(s, edges) === b ? i : -1)).filter(i => i >= 0);
        const bn = idxs.length;
        const predicted = bn ? idxs.reduce((s, i) => s + evalScores[i], 0) / bn : null;
        const observed = bn ? idxs.reduce((s, i) => s + evalActuals[i], 0) / bn : null;
        buckets.push({ bucket: b, n: bn, predicted, observed, adequatelySampled: bn >= CALIBRATION_MIN_BUCKET_N });
    }

    const adequateBuckets = buckets.filter(b => b.adequatelySampled);
    if (adequateBuckets.length < 2) {
        return { evaluable: false, reason: `Only ${adequateBuckets.length} adequately-sampled bucket(s) — need at least 2.`, buckets };
    }

    const baseRate = trainActuals.reduce((a, b) => a + b, 0) / trainActuals.length;
    const baselinePredictions = evalScores.map(() => baseRate);
    const baselineBrier = computeCalibrationBrier(baselinePredictions, evalActuals);
    const modelBrier = computeCalibrationBrier(evalScores, evalActuals);
    const brierImprovement = baselineBrier - modelBrier;

    const totalAdequateN = adequateBuckets.reduce((s, b) => s + b.n, 0);
    const calibrationError = adequateBuckets.reduce((s, b) => s + Math.abs(b.predicted - b.observed) * b.n, 0) / totalAdequateN;

    const fit = fitCalibrationSlopeIntercept(trainScores, trainActuals); // training only, diagnostic, never applied to evalScores

    const rocAuc = computeCalibrationROCAUC(evalScores, evalActuals);
    const spearman = computeCalibrationSpearman(evalScores, evalActuals);

    const checks = {
        brierImprovement: brierImprovement >= FC_BRIER_IMPROVEMENT_MARGIN,
        calibrationError: calibrationError < 0.15,
        slope: fit.slope >= 0.5 && fit.slope <= 1.5,
        intercept: fit.intercept >= -0.15 && fit.intercept <= 0.15
    };
    const passed = Object.values(checks).every(Boolean);

    return {
        evaluable: true, passed, checks,
        trainN: trainScores.length, evalN: evalScores.length,
        numBins, buckets, adequateBucketCount: adequateBuckets.length,
        baseRate, baselineBrier: Math.round(baselineBrier * 1000) / 1000, modelBrier: Math.round(modelBrier * 1000) / 1000,
        brierImprovement: Math.round(brierImprovement * 1000) / 1000,
        calibrationError: Math.round(calibrationError * 1000) / 1000,
        slope: fit.slope, intercept: fit.intercept,
        rocAuc: rocAuc !== null ? Math.round(rocAuc * 1000) / 1000 : null,
        spearman: spearman !== null ? Math.round(spearman * 1000) / 1000 : null
    };
}

function runEWMACalibrationExperiment(country, windowLen) {
    const ewmaExp = runEWMAExperiment(country, windowLen);
    if (ewmaExp.insufficientData) return { insufficientData: true };

    const allBlocks = buildNonOverlappingBlocks(country, windowLen);
    const fullWalk = walkEWMA(allBlocks, ewmaExp.chosenDecay); // reuses the already-frozen decay, never re-selected here
    if (!fullWalk) return { insufficientData: true };

    const windows = buildEWMACalibrationWindows(fullWalk.results, FC_CALIBRATION_NUM_WINDOWS);
    if (!windows.length) return { insufficientData: true };

    const results = windows.map(evaluateEWMACalibrationWindow);
    const evaluableResults = results.filter(r => r.evaluable);
    const passingResults = evaluableResults.filter(r => r.passed);

    const totalWindows = results.length;
    const evaluableCount = evaluableResults.length;
    const passingCount = passingResults.length;

    let verdict;
    if (evaluableCount / totalWindows <= 0.5) {
        verdict = "INCONCLUSIVE";
    } else if (passingCount / evaluableCount > 0.5) {
        verdict = "SUPPORTED";
    } else {
        verdict = "NOT SUPPORTED";
    }

    function avgOf(key) {
        const vals = evaluableResults.map(r => r[key]).filter(v => v !== null && v !== undefined);
        return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000 : null;
    }

    return {
        insufficientData: false, country, windowLen, verdict,
        ewmaDecayUsed: ewmaExp.chosenDecay,
        totalWindows, evaluableCount, passingCount,
        avgBrierImprovement: avgOf('brierImprovement'),
        avgCalibrationError: avgOf('calibrationError'),
        avgSlope: avgOf('slope'),
        avgIntercept: avgOf('intercept'),
        avgRocAuc: avgOf('rocAuc'),
        avgSpearman: avgOf('spearman'),
        windowResults: results
    };
}

// =====================================================================
// EWMA CALIBRATION — RECENT-ERA RESTRICTION EXPERIMENT
//
// A genuinely new question, not a rescue of the closed NOT SUPPORTED
// experiment above (which stays exactly as concluded): is EWMA
// calibrated specifically within the dense, modern era — where the
// original full-history experiment's one dense-era window passed
// cleanly, but that was a sample of one, not evidence.
//
// Critical discipline point: the "dense era" boundary is NOT chosen
// now, after already seeing which era passed. It reuses the EXACT
// outer-train/outer-test split the ORIGINAL EWMA-vs-baseline
// experiment already fixed (FC_OUTER_TRAIN_FRACTION on the full
// block series) — a boundary that existed for an unrelated reason
// before this experiment was conceived. Picking a new cutoff now
// would be exactly the after-the-fact goalpost move this project's
// discipline exists to prevent.
// =====================================================================

function runEWMARecentEraCalibrationExperiment(country, windowLen) {
    const ewmaExp = runEWMAExperiment(country, windowLen);
    if (ewmaExp.insufficientData) return { insufficientData: true };

    const allBlocks = buildNonOverlappingBlocks(country, windowLen);
    const splitIdx = Math.floor(allBlocks.length * FC_OUTER_TRAIN_FRACTION); // the SAME pre-existing boundary
    const denseEraStartBlockStart = allBlocks[splitIdx].blockStart;

    const fullWalk = walkEWMA(allBlocks, ewmaExp.chosenDecay);
    if (!fullWalk) return { insufficientData: true };

    // Restrict to predictions from the pre-existing dense-era boundary
    // onward. Pure filtering of already-leakage-safe walk-forward
    // output — introduces no new leakage risk of its own.
    const denseEraResults = fullWalk.results.filter(r => r.blockStart >= denseEraStartBlockStart);

    const windows = buildEWMACalibrationWindows(denseEraResults, FC_CALIBRATION_NUM_WINDOWS);
    if (!windows.length) return { insufficientData: true };

    const results = windows.map(evaluateEWMACalibrationWindow);
    const evaluableResults = results.filter(r => r.evaluable);
    const passingResults = evaluableResults.filter(r => r.passed);

    const totalWindows2 = results.length;
    const evaluableCount2 = evaluableResults.length;
    const passingCount2 = passingResults.length;

    let verdict2;
    if (evaluableCount2 / totalWindows2 <= 0.5) {
        verdict2 = "INCONCLUSIVE";
    } else if (passingCount2 / evaluableCount2 > 0.5) {
        verdict2 = "SUPPORTED";
    } else {
        verdict2 = "NOT SUPPORTED";
    }

    function avgOf2(key) {
        const vals = evaluableResults.map(r => r[key]).filter(v => v !== null && v !== undefined);
        return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000 : null;
    }

    return {
        insufficientData: false, country, windowLen, verdict: verdict2,
        ewmaDecayUsed: ewmaExp.chosenDecay,
        denseEraStartBlockStart, denseEraN: denseEraResults.length,
        totalWindows: totalWindows2, evaluableCount: evaluableCount2, passingCount: passingCount2,
        avgBrierImprovement: avgOf2('brierImprovement'),
        avgCalibrationError: avgOf2('calibrationError'),
        avgSlope: avgOf2('slope'),
        avgIntercept: avgOf2('intercept'),
        avgRocAuc: avgOf2('rocAuc'),
        avgSpearman: avgOf2('spearman'),
        windowResults: results
    };
}

// =====================================================================
// CROSS-COUNTRY VALIDATION — C.1 (US) vs. C.2 (Canada) vs. C.3 (pooled)
//
// A genuine hierarchical/mixed-effects model (a shared component that
// learns common patterns while still letting each country keep its
// own baseline) needs real partial-pooling statistics — that's
// server-side work with a proper stats library, not something to
// approximate client-side and call "the model." What IS honestly
// buildable here: the model's weights (25/20/20/15/10/10) are ALREADY
// fixed constants applied identically regardless of country — so
// "C.3, combined" is the same shared formula, evaluated against the
// POOLED walk-forward years from both countries at once. If it holds
// up on the pooled set as well as it does on each country
// individually, that's real evidence the pattern generalizes rather
// than being tuned to one country's quirks.
// =====================================================================

function aggregateResultsMetrics(results, riskScoreThreshold) {
    if (!results || !results.length) return null;

    const modelMAE = results.reduce((s, r) => s + r.modelError, 0) / results.length;
    const naiveMAE = results.reduce((s, r) => s + r.naiveError, 0) / results.length;
    const modelRMSE = Math.sqrt(results.reduce((s, r) => s + r.modelError ** 2, 0) / results.length);
    const naiveRMSE = Math.sqrt(results.reduce((s, r) => s + r.naiveError ** 2, 0) / results.length);

    const tp = results.filter(r => r.predictedElevated && r.actualElevated).length;
    const fp = results.filter(r => r.predictedElevated && !r.actualElevated).length;
    const fn = results.filter(r => !r.predictedElevated && r.actualElevated).length;
    const modelBPrecision = (tp + fp) > 0 ? Math.round((tp / (tp + fp)) * 1000) / 10 : null;
    const modelBRecall = (tp + fn) > 0 ? Math.round((tp / (tp + fn)) * 1000) / 10 : null;

    const scored = results.filter(r => r.riskScoreValue !== null);
    let modelCPrecision = null, modelCRecall = null;
    if (scored.length) {
        const cTp = scored.filter(r => r.riskScoreValue >= riskScoreThreshold && r.actualElevated).length;
        const cFp = scored.filter(r => r.riskScoreValue >= riskScoreThreshold && !r.actualElevated).length;
        const cFn = scored.filter(r => r.riskScoreValue < riskScoreThreshold && r.actualElevated).length;
        modelCPrecision = (cTp + cFp) > 0 ? Math.round((cTp / (cTp + cFp)) * 1000) / 10 : null;
        modelCRecall = (cTp + cFn) > 0 ? Math.round((cTp / (cTp + cFn)) * 1000) / 10 : null;
    }

    return {
        n: results.length,
        modelMAE: Math.round(modelMAE * 100) / 100, naiveMAE: Math.round(naiveMAE * 100) / 100,
        modelRMSE: Math.round(modelRMSE * 100) / 100, naiveRMSE: Math.round(naiveRMSE * 100) / 100,
        beatsNaive: modelMAE < naiveMAE,
        modelBPrecision, modelBRecall, modelCPrecision, modelCRecall,
        modelCCoverage: Math.round((scored.length / results.length) * 1000) / 10
    };
}

function computeCrossCountryValidation() {
    const usBacktest = computeBacktest("United States");
    const caBacktest = computeBacktest("Canada");

    if (usBacktest.insufficientData || caBacktest.insufficientData) {
        return { insufficientData: true, usAvailable: !usBacktest.insufficientData, caAvailable: !caBacktest.insufficientData };
    }

    const usThreshold = usBacktest.thresholdSweep ? usBacktest.thresholdSweep.recommendedThreshold : 60;
    const caThreshold = caBacktest.thresholdSweep ? caBacktest.thresholdSweep.recommendedThreshold : 60;

    // C.3's threshold is walk-forward-tuned on the POOLED data, not
    // borrowed from either country and not left at an arbitrary
    // untuned default. Forcing the pooled model to use a fixed 60 while
    // the individual countries tune to 55 and 40 was the actual bug —
    // it wasn't testing whether the pooled MODEL works, it was testing
    // whether the pooled model works AT A THRESHOLD NEITHER COUNTRY'S
    // OWN DATA SUPPORTS. This reuses the exact same walk-forward
    // sweep already proven for the single-country case, just given the
    // pooled results array as its input.
    const pooledResults = [...usBacktest.results, ...caBacktest.results];
    const pooledSweep = computeRiskScoreThresholdSweep(pooledResults);
    const sharedThreshold = pooledSweep ? pooledSweep.recommendedThreshold : 60;

    const c1 = aggregateResultsMetrics(usBacktest.results, usThreshold);
    const c2 = aggregateResultsMetrics(caBacktest.results, caThreshold);
    const c3 = aggregateResultsMetrics(pooledResults, sharedThreshold);

    return {
        insufficientData: false,
        c1, c2, c3,
        usThreshold, caThreshold, sharedThreshold,
        pooledSweep,
        usYears: usBacktest.results.length, caYears: caBacktest.results.length
    };
}

// Does population adjustment change which country looks more elevated?
// With only two countries carrying real population data, a ranked
// percentile comparison isn't meaningful — but a direct raw-vs-adjusted
// comparison between exactly these two countries is, and it's the
// honest version of "does population adjustment change the picture"
// given the data that actually exists right now.
function computePopulationRankingTest() {
    const usForecast = computeForecast("United States");
    const caForecast = computeForecast("Canada");
    if (!usForecast || !caForecast || !usForecast.populationAdjustedRate || !caForecast.populationAdjustedRate) return null;

    const rawWinner = usForecast.historicalAnnualRate >= caForecast.historicalAnnualRate ? "United States" : "Canada";
    const adjustedWinner = usForecast.populationAdjustedRate.per100k >= caForecast.populationAdjustedRate.per100k ? "United States" : "Canada";

    return {
        us: { raw: usForecast.historicalAnnualRate, per100k: usForecast.populationAdjustedRate.per100k },
        ca: { raw: caForecast.historicalAnnualRate, per100k: caForecast.populationAdjustedRate.per100k },
        rawWinner, adjustedWinner,
        rankingChanges: rawWinner !== adjustedWinner
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

    // Aligned to the SAME final test window computeRecalibratedInterval
    // uses (last 25% of years, via calEnd = floor(n*0.75)) — not its own
    // separate 70/30 split. A "before vs. after" comparison is only
    // valid if both sides are evaluated on identical held-out years;
    // this function previously used a different split (last 30%),
    // which meant "before" and "after" weren't actually comparable.
    const calEnd = Math.floor(backtestResults.length * 0.75);
    const trainWindow = backtestResults.slice(0, calEnd);
    const testWindow = backtestResults.slice(calEnd);
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

// =====================================================================
// C.5.1 — PREDICTION INTERVAL RECALIBRATION
//
// The diagnostic above (computeIntervalCalibration) exposed the real
// problem: the interval actually shown on the live forecast
// (computeEmpiricalPredictionInterval, built from ALL residuals with
// no held-out check) was NEVER validated against data it hadn't seen
// — so a stated "80%"/"90%" wasn't a tested claim, just an assumption.
//
// This fixes it with a proper THREE-WAY split, not two:
//   1. Training years  -> shape of the residual distribution
//   2. Calibration years -> search for a width MULTIPLIER that makes
//      empirical coverage match the stated target on THIS set only
//   3. Test years -> NEVER used to choose anything. Only used to
//      report the final, honest, out-of-sample coverage number.
//
// This is what "no tuning on the final test years" actually means in
// code: the multiplier search loop never touches testSet. If it did,
// the reported coverage would be circular — of course a number tuned
// to match its own evaluation set will match it.
// =====================================================================

const MIN_YEARS_FOR_INTERVAL_RECALIBRATION = 9; // needs enough for a meaningful 3-way split
const RECALIBRATION_MULTIPLIER_CANDIDATES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10, 13, 16, 20];

function computeRecalibratedInterval(backtestResults, centralEstimate, coverage) {
    if (!backtestResults || backtestResults.length < MIN_YEARS_FOR_INTERVAL_RECALIBRATION) return null;

    const n = backtestResults.length;
    const trainEnd = Math.floor(n * 0.5);
    const calEnd = Math.floor(n * 0.75);

    const trainSet = backtestResults.slice(0, trainEnd);
    const calSet = backtestResults.slice(trainEnd, calEnd);
    const testSet = backtestResults.slice(calEnd);
    if (trainSet.length < 3 || calSet.length < 2 || testSet.length < 2) return null;

    const trainResiduals = trainSet.map(r => r.actual - r.predictedCentral).sort((a, b) => a - b);
    const tail = (1 - coverage) / 2;
    const baseLower = quantile(trainResiduals, tail);
    const baseUpper = quantile(trainResiduals, 1 - tail);

    function coverageAtMultiplier(window, mult) {
        const covered = window.filter(r => {
            const low = r.predictedCentral + baseLower * mult;
            const high = r.predictedCentral + baseUpper * mult;
            return r.actual >= low && r.actual <= high;
        }).length;
        return covered / window.length;
    }

    // Search for the multiplier whose CALIBRATION-set coverage lands
    // closest to the stated target. testSet is not referenced anywhere
    // in this loop.
    let chosenMultiplier = RECALIBRATION_MULTIPLIER_CANDIDATES[0];
    let bestGap = Infinity;
    for (const m of RECALIBRATION_MULTIPLIER_CANDIDATES) {
        const gap = Math.abs(coverageAtMultiplier(calSet, m) - coverage);
        if (gap < bestGap) { bestGap = gap; chosenMultiplier = m; }
    }

    // Only NOW, after the multiplier is fixed, do we touch testSet —
    // purely to report how it did, never to change the choice.
    const testCoveragePct = Math.round(coverageAtMultiplier(testSet, chosenMultiplier) * 1000) / 10;
    const calCoveragePct = Math.round(coverageAtMultiplier(calSet, chosenMultiplier) * 1000) / 10;

    const low = Math.max(0, Math.round(centralEstimate + baseLower * chosenMultiplier));
    const high = Math.round(centralEstimate + baseUpper * chosenMultiplier);

    return {
        low, high,
        coveragePct: Math.round(coverage * 100),
        testCoveragePct, calCoveragePct,
        chosenMultiplier,
        baseLower, baseUpper, // pre-multiplier residual bounds — the "before" width
        baseWidth: Math.round((baseUpper - baseLower) * 100) / 100,
        finalWidth: Math.round((baseUpper - baseLower) * chosenMultiplier * 100) / 100,
        trainSet, calSet, testSet, // exposed for downstream diagnostics (outlier sensitivity, dispersion stability)
        trainYears: trainSet.length, calYears: calSet.length, testYears: testSet.length,
        wellCalibrated: Math.abs(testCoveragePct / 100 - coverage) <= 0.15
    };
}

// =====================================================================
// C.5.1 AUDIT — dispersion stability + outlier sensitivity
//
// Distinguishes "the interval construction is wrong" from "the
// underlying forecast distribution is fundamentally misspecified"
// (a non-stationary/regime-shifting process no fixed multiplier could
// ever fix). Both diagnostics are read-only reporting — neither
// changes what interval gets shown or how the multiplier is chosen.
// =====================================================================

// Dispersion (variance/mean of the RESIDUALS, not raw counts — this
// isolates "how wrong the forecast tends to be" from the underlying
// trend level itself) computed separately per period. If it's wildly
// different across periods, that's non-stationarity: no single global
// multiplier can be correct for all of them at once.
function computeDispersionStability(backtestResults) {
    if (!backtestResults || backtestResults.length < MIN_YEARS_FOR_INTERVAL_RECALIBRATION) return null;

    const n = backtestResults.length;
    const trainEnd = Math.floor(n * 0.5);
    const calEnd = Math.floor(n * 0.75);
    const periods = {
        training: backtestResults.slice(0, trainEnd),
        calibration: backtestResults.slice(trainEnd, calEnd),
        test: backtestResults.slice(calEnd)
    };

    function dispersionOf(window) {
        if (window.length < 2) return null;
        const residuals = window.map(r => r.actual - r.predictedCentral);
        const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
        const variance = residuals.reduce((a, b) => a + (b - mean) ** 2, 0) / residuals.length;
        // Residuals can be negative, so "dispersion ratio" here is
        // variance relative to the SPREAD, not a mean-based Poisson
        // ratio (which needs a positive mean) — reported as the
        // residual standard deviation, a directly comparable width unit.
        return { variance: Math.round(variance * 100) / 100, std: Math.round(Math.sqrt(variance) * 100) / 100, n: window.length };
    }

    const result = {
        training: dispersionOf(periods.training),
        calibration: dispersionOf(periods.calibration),
        test: dispersionOf(periods.test)
    };

    // Flag instability: if the test period's residual spread is more
    // than 2x (or less than 0.5x) the training period's, the process
    // isn't behaving consistently over time — a genuine regime issue,
    // not just an under-tuned multiplier.
    let stabilityVerdict = "insufficient data";
    if (result.training && result.test && result.training.std > 0) {
        const ratio = result.test.std / result.training.std;
        stabilityVerdict = ratio > 2 ? "unstable — test period far more volatile than training"
            : ratio < 0.5 ? "unstable — test period far calmer than training"
            : "reasonably stable";
    }

    return { ...result, stabilityVerdict };
}

// Removes the single worst-missed test-set year and reports whether
// coverage would look fundamentally different without it — the
// distinction between "broadly under-covering" and "one outlier year
// is driving the whole result."
function computeOutlierSensitivity(recalResult) {
    if (!recalResult || !recalResult.testSet || recalResult.testSet.length < 3) return null;

    const { baseLower, baseUpper, chosenMultiplier, testSet } = recalResult;
    const rows = testSet.map(r => {
        const low = r.predictedCentral + baseLower * chosenMultiplier;
        const high = r.predictedCentral + baseUpper * chosenMultiplier;
        const hit = r.actual >= low && r.actual <= high;
        const missDistance = hit ? 0 : Math.min(Math.abs(r.actual - low), Math.abs(r.actual - high));
        return { ...r, hit, missDistance };
    });

    const totalCoveragePct = Math.round((rows.filter(r => r.hit).length / rows.length) * 1000) / 10;

    const worstMiss = rows.reduce((worst, r) => (r.missDistance > (worst ? worst.missDistance : -1) ? r : worst), null);
    if (!worstMiss || worstMiss.missDistance === 0) {
        return { totalCoveragePct, worstMissExists: false };
    }

    const withoutWorst = rows.filter(r => r !== worstMiss);
    const coverageWithoutWorstPct = Math.round((withoutWorst.filter(r => r.hit).length / withoutWorst.length) * 1000) / 10;

    return {
        totalCoveragePct,
        worstMissExists: true,
        worstMissDistance: Math.round(worstMiss.missDistance * 10) / 10,
        coverageWithoutWorstPct,
        driftIsOutlierDriven: (coverageWithoutWorstPct - totalCoveragePct) > 20 // one year moving coverage >20pp signals outlier-driven, not systematic
    };
}

// =====================================================================
// C.5.1 FORMAL COMPARISON — Empirical multiplier vs. Negative Binomial
//
// Six dimensions, requested explicitly, evaluated on the SAME
// walk-forward test years for both methods:
//   coverage, interval width, an accuracy score, calibration,
//   stability across regimes, minimum sample requirements.
//
// "MAE/RMSE" needs a specific honest translation here: both methods
// share the exact same POINT forecast (Model A's central estimate) —
// only the interval WIDTH differs between them — so a point-forecast
// MAE/RMSE would be identical for both and wouldn't distinguish
// anything. The standard proper scoring rule for comparing interval
// CONSTRUCTIONS is the Winkler (interval) score: width, plus a
// penalty for falling outside on either side, scaled by how severely
// it missed. Lower is better. This IS the legitimate "which interval
// is more accurate" answer, not the raw point-forecast error.
//
// "Stability across historical regimes" is checked by splitting the
// test set into its own first and second half and reporting coverage
// in each separately — a method scoring well in aggregate while
// swinging wildly between the two halves is a real red flag the
// aggregate number alone would hide.
// =====================================================================

function winklerScore(actual, low, high, alpha) {
    const width = high - low;
    if (actual < low) return width + (2 / alpha) * (low - actual);
    if (actual > high) return width + (2 / alpha) * (actual - high);
    return width;
}

function splitHalfCoverage(scoredRows) {
    const mid = Math.floor(scoredRows.length / 2);
    const firstHalf = scoredRows.slice(0, mid);
    const secondHalf = scoredRows.slice(mid);
    return {
        firstHalfCoveragePct: firstHalf.length ? Math.round((firstHalf.filter(r => r.hit).length / firstHalf.length) * 1000) / 10 : null,
        secondHalfCoveragePct: secondHalf.length ? Math.round((secondHalf.filter(r => r.hit).length / secondHalf.length) * 1000) / 10 : null,
        firstHalfN: firstHalf.length, secondHalfN: secondHalf.length
    };
}

function evaluateEmpiricalMethod(backtestResults, coverage) {
    const recal = computeRecalibratedInterval(backtestResults, 0, coverage);
    if (!recal) return null;
    const alpha = 1 - coverage;
    const scored = recal.testSet.map(r => {
        const low = Math.max(0, r.predictedCentral + recal.baseLower * recal.chosenMultiplier);
        const high = r.predictedCentral + recal.baseUpper * recal.chosenMultiplier;
        return { hit: r.actual >= low && r.actual <= high, width: high - low, score: winklerScore(r.actual, low, high, alpha) };
    });
    const avgWidth = scored.reduce((s, x) => s + x.width, 0) / scored.length;
    const avgScore = scored.reduce((s, x) => s + x.score, 0) / scored.length;
    const stability = splitHalfCoverage(scored);
    // Calibration error: how far observed coverage sits from the
    // stated target, in percentage points — the single number that
    // answers "how uncalibrated is this," independent of the ±15pp
    // pass/fail threshold used elsewhere.
    const calibrationErrorPct = Math.round(Math.abs(recal.testCoveragePct - coverage * 100) * 10) / 10;

    return {
        method: "Empirical multiplier",
        coveragePct: recal.testCoveragePct,
        calibrationErrorPct,
        avgWidth: Math.round(avgWidth * 100) / 100,
        avgWinklerScore: Math.round(avgScore * 100) / 100,
        wellCalibrated: recal.wellCalibrated,
        ...stability,
        trainYears: recal.trainYears, calYears: recal.calYears, testYears: recal.testYears,
        usesCalibrationSet: true
    };
}

function evaluateNBMethod(backtestResults, coverage) {
    const nb = computeNBInterval(backtestResults, coverage);
    if (!nb) return null;
    const alpha = 1 - coverage;
    const tail = alpha / 2;
    const scored = nb.testSet.map(r => {
        const low = negBinomialQuantile(tail, Math.max(0.01, r.predictedCentral), nb.rParameter);
        const high = negBinomialQuantile(1 - tail, Math.max(0.01, r.predictedCentral), nb.rParameter);
        return { hit: r.actual >= low && r.actual <= high, width: high - low, score: winklerScore(r.actual, low, high, alpha) };
    });
    const avgWidth = scored.reduce((s, x) => s + x.width, 0) / scored.length;
    const avgScore = scored.reduce((s, x) => s + x.score, 0) / scored.length;
    const stability = splitHalfCoverage(scored);
    const calibrationErrorPct = Math.round(Math.abs(nb.testCoveragePct - coverage * 100) * 10) / 10;

    return {
        method: "Negative Binomial",
        coveragePct: nb.testCoveragePct,
        calibrationErrorPct,
        avgWidth: Math.round(avgWidth * 100) / 100,
        avgWinklerScore: Math.round(avgScore * 100) / 100,
        wellCalibrated: nb.wellCalibrated,
        ...stability,
        trainYears: nb.trainYears, calYears: nb.calYears, testYears: nb.testYears,
        usesCalibrationSet: false,
        rParameter: nb.rParameter, dispersionRatio: nb.dispersionRatio
    };
}

function computeC512FormalComparison(backtest) {
    if (!backtest || backtest.insufficientData || !backtest.results.length) return null;
    const results = backtest.results;

    const comparison80 = { empirical: evaluateEmpiricalMethod(results, 0.8), nb: evaluateNBMethod(results, 0.8) };
    const comparison90 = { empirical: evaluateEmpiricalMethod(results, 0.9), nb: evaluateNBMethod(results, 0.9) };
    // Volatility is a property of the DATA, not of either interval
    // construction — computed once and shared, not per-method.
    const volatility = computeDispersionStability(results);

    if (!comparison80.empirical || !comparison80.nb || !comparison90.empirical || !comparison90.nb) {
        return { comparison80, comparison90, volatility, decision: { verdict: "insufficient", text: "Not enough backtested years to run the full formal comparison yet." } };
    }

    // Documented decision, mechanically derived — never a coin flip
    // between two similarly-bad options. A method only gets
    // recommended if it's actually well-calibrated at BOTH stated
    // coverage levels; if neither clears that bar, the honest verdict
    // is to say so and document the limitation, not to pick a "winner."
    const empGood = comparison80.empirical.wellCalibrated && comparison90.empirical.wellCalibrated;
    const nbGood = comparison80.nb.wellCalibrated && comparison90.nb.wellCalibrated;

    let decision;
    if (!empGood && !nbGood) {
        decision = { verdict: "neither", text: "Neither method achieves reasonable calibration at both the 80% and 90% targets on this data. Document this as a known limitation of the current historical-count formulation rather than locking either method or continuing to widen intervals until a number looks acceptable." };
    } else if (empGood && !nbGood) {
        decision = { verdict: "empirical", text: "Empirical multiplier method recommended — the only one of the two achieving reasonable calibration at both coverage levels on this data." };
    } else if (nbGood && !empGood) {
        decision = { verdict: "nb", text: "Negative Binomial method recommended — the only one of the two achieving reasonable calibration at both coverage levels on this data." };
    } else {
        const empScore = (comparison80.empirical.avgWinklerScore + comparison90.empirical.avgWinklerScore) / 2;
        const nbScore = (comparison80.nb.avgWinklerScore + comparison90.nb.avgWinklerScore) / 2;
        decision = empScore <= nbScore
            ? { verdict: "empirical", text: `Both methods are reasonably calibrated at both levels — empirical multiplier recommended on interval score (avg Winkler ${Math.round(empScore * 100) / 100} vs. NB's ${Math.round(nbScore * 100) / 100}, lower is better).` }
            : { verdict: "nb", text: `Both methods are reasonably calibrated at both levels — Negative Binomial recommended on interval score (avg Winkler ${Math.round(nbScore * 100) / 100} vs. empirical's ${Math.round(empScore * 100) / 100}, lower is better).` };
    }

    return { comparison80, comparison90, volatility, decision };
}


// =====================================================================
// POISSON PROBABILITY MATH
//
// Lanczos approximation for the log-gamma function — standard,
// well-known numerical method, accurate to ~15 significant digits.
// Needed to compute Poisson PMF/CDF in log-space so factorials of
// larger counts don't overflow a double.
// =====================================================================

function lgamma(x) {
    const g = 7;
    const c = [
        0.99999999999980993, 676.5203681218851, -1259.1392167224028,
        771.32342877765313, -176.61502916214059, 12.507343278686905,
        -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
    ];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    x -= 1;
    let a = c[0];
    const t = x + g + 0.5;
    for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logPoissonPMF(k, lambda) {
    if (lambda <= 0) return k === 0 ? 0 : -Infinity;
    if (k < 0) return -Infinity;
    return -lambda + k * Math.log(lambda) - lgamma(k + 1);
}

function poissonCDF(k, lambda) {
    if (k < 0) return 0;
    let sum = 0;
    for (let i = 0; i <= Math.floor(k); i++) sum += Math.exp(logPoissonPMF(i, lambda));
    return Math.min(1, sum);
}

// P(X > threshold) — used for "probability this period is elevated."
function poissonProbabilityAbove(lambda, threshold) {
    return Math.max(0, 1 - poissonCDF(Math.floor(threshold), lambda));
}

// =====================================================================
// NEGATIVE BINOMIAL QUANTILE INTERVAL — an alternative, statistically
// principled candidate for C.5.1's interval construction, requested
// specifically to test whether a different legitimate method closes
// the coverage gap without just widening the empirical-quantile
// approach until it looks acceptable.
//
// Reuses lgamma (already built and tested for the Poisson math) to
// compute the NB PMF/CDF in log-space, then finds quantiles by
// direct summation — the same numerically stable approach already
// proven for Poisson, extended to NB's extra dispersion parameter.
//
// Parameterization: mean = the row's own predictedCentral, r (the NB
// "size" parameter) estimated ONLY from training-set residual
// dispersion relative to the training mean forecast — never from
// calibration or test years. r → ∞ recovers the Poisson case.
// =====================================================================

function logNegBinomialPMF(k, mean, r) {
    if (r <= 0 || mean <= 0) return k === 0 ? 0 : -Infinity;
    if (k < 0) return -Infinity;
    return lgamma(k + r) - lgamma(k + 1) - lgamma(r) + r * Math.log(r / (r + mean)) + k * Math.log(mean / (r + mean));
}

function negBinomialQuantile(p, mean, r) {
    if (mean <= 0) return 0;
    let cumProb = 0;
    const maxK = Math.max(300, Math.ceil(mean * 15));
    for (let k = 0; k <= maxK; k++) {
        cumProb += Math.exp(logNegBinomialPMF(k, mean, r));
        if (cumProb >= p) return k;
    }
    return maxK;
}

function computeNBInterval(backtestResults, coverage) {
    if (!backtestResults || backtestResults.length < MIN_YEARS_FOR_INTERVAL_RECALIBRATION) return null;

    const n = backtestResults.length;
    const trainEnd = Math.floor(n * 0.5);
    const calEnd = Math.floor(n * 0.75);
    const trainSet = backtestResults.slice(0, trainEnd);
    const calSet = backtestResults.slice(trainEnd, calEnd);
    const testSet = backtestResults.slice(calEnd);
    if (trainSet.length < 3 || calSet.length < 2 || testSet.length < 2) return null;

    // Fit dispersion ONLY from training years: variance of training
    // residuals relative to the training mean forecast level.
    const trainMeanForecast = trainSet.reduce((s, r) => s + r.predictedCentral, 0) / trainSet.length;
    const trainResiduals = trainSet.map(r => r.actual - r.predictedCentral);
    const residMean = trainResiduals.reduce((a, b) => a + b, 0) / trainResiduals.length;
    const residVariance = trainResiduals.reduce((a, b) => a + (b - residMean) ** 2, 0) / trainResiduals.length;
    const dispersionRatio = trainMeanForecast > 0 ? residVariance / trainMeanForecast : 1;

    // r = mean / (dispersion ratio - 1); guard against dispersionRatio
    // <= 1 (would imply UNDER-dispersion, i.e., Poisson or tighter) by
    // falling back to a very large r, which makes NB collapse toward
    // Poisson rather than producing an invalid/negative r.
    const r = dispersionRatio > 1.01 ? trainMeanForecast / (dispersionRatio - 1) : 10000;

    const tail = (1 - coverage) / 2;

    function coverageOn(window) {
        const covered = window.filter(row => {
            const low = negBinomialQuantile(tail, Math.max(0.01, row.predictedCentral), r);
            const high = negBinomialQuantile(1 - tail, Math.max(0.01, row.predictedCentral), r);
            return row.actual >= low && row.actual <= high;
        }).length;
        return Math.round((covered / window.length) * 1000) / 10;
    }

    return {
        dispersionRatio: Math.round(dispersionRatio * 100) / 100,
        rParameter: Math.round(r * 100) / 100,
        calCoveragePct: coverageOn(calSet),
        testCoveragePct: coverageOn(testSet),
        coveragePct: Math.round(coverage * 100),
        trainSet, calSet, testSet,
        trainYears: trainSet.length, calYears: calSet.length, testYears: testSet.length,
        wellCalibrated: Math.abs(coverageOn(testSet) / 100 - coverage) <= 0.15
    };
}

// =====================================================================
// OVERDISPERSION TEST — Poisson vs. quasi-Poisson interval
//
// Real fitted Negative Binomial regression needs MLE dispersion-
// parameter estimation, which is server-side work (statsmodels/
// scikit-learn territory), not something to approximate client-side
// and call "Negative Binomial." What IS honestly buildable here: a
// quasi-Poisson interval that widens the Poisson margin by
// sqrt(dispersion ratio) when the data is overdispersed (variance >
// mean) — a standard, disclosed correction, tested walk-forward
// against the plain Poisson-style heuristic margin already in use.
// Whichever calibrates closer to its stated coverage on HELD-OUT
// years wins; NHIRA doesn't just assume the fancier option is better.
// =====================================================================

function computeOverdispersionTest(backtestResults, dispersionRatio, coverage) {
    if (!backtestResults || backtestResults.length < MIN_YEARS_FOR_BLEND_TUNING) return null;

    const splitIndex = Math.max(3, Math.floor(backtestResults.length * 0.7));
    const trainWindow = backtestResults.slice(0, splitIndex);
    const testWindow = backtestResults.slice(splitIndex);
    if (trainWindow.length < 3 || testWindow.length < 2) return null;

    const scaleFactor = dispersionRatio > 1 ? Math.sqrt(dispersionRatio) : 1;

    function coverageOf(window, widthMultiplier) {
        const covered = window.filter(r => {
            const baseMargin = Math.max(1, Math.abs(r.predictedHigh - r.predictedCentral));
            const margin = baseMargin * widthMultiplier;
            return r.actual >= r.predictedCentral - margin && r.actual <= r.predictedCentral + margin;
        }).length;
        return covered / window.length;
    }

    // Fit the multiplier that best matches the STATED coverage on
    // TRAINING years only, for each approach — Poisson (multiplier
    // fixed at 1, i.e. the existing heuristic margin) vs. quasi-Poisson
    // (multiplier = sqrt(dispersion ratio)).
    const poissonTestCoverage = coverageOf(testWindow, 1);
    const quasiPoissonTestCoverage = coverageOf(testWindow, scaleFactor);

    const poissonGap = Math.abs(poissonTestCoverage - coverage);
    const quasiPoissonGap = Math.abs(quasiPoissonTestCoverage - coverage);
    const preferred = quasiPoissonGap < poissonGap ? "quasi-Poisson" : "Poisson";

    return {
        dispersionRatio,
        scaleFactor: Math.round(scaleFactor * 100) / 100,
        poissonTestCoveragePct: Math.round(poissonTestCoverage * 1000) / 10,
        quasiPoissonTestCoveragePct: Math.round(quasiPoissonTestCoverage * 1000) / 10,
        statedCoveragePct: Math.round(coverage * 100),
        preferred,
        testYears: testWindow.length
    };
}

// =====================================================================
// PROBABILITY CALIBRATION DASHBOARD
//
// For each backtested year, compute a genuine probability that the
// year would be "elevated" (Poisson P(X > threshold), using ONLY
// that year's walk-forward central estimate and threshold — nothing
// from later years). Bucket those probabilities into 10-point bands
// and check the ACTUAL elevated-rate within each band. This is what
// makes "70% probability" a checkable claim instead of a number that
// merely looks plausible.
// =====================================================================

// A bucket with only 1-2 years can show something like "100% actual
// elevated rate" that sounds decisive but is really just one
// coin-flip's outcome. Below this sample size, the bucket reports
// "Insufficient sample" instead of a percentage that would overstate
// how much is actually known.
const MIN_CALIBRATION_BUCKET_SAMPLE = 4;

function computeCalibrationDashboard(backtestResults) {
    if (!backtestResults || backtestResults.length < 6) return null;

    // Probability that this year would exceed its own elevated
    // threshold, computed from ONLY that year's walk-forward central
    // estimate and threshold — no information from later years.
    const withProb = backtestResults.map(r => ({
        ...r,
        probability: poissonProbabilityAbove(r.predictedCentral, r.elevatedThreshold)
    }));

    const buckets = [
        { label: "50–60%", min: 0.5, max: 0.6 },
        { label: "60–70%", min: 0.6, max: 0.7 },
        { label: "70–80%", min: 0.7, max: 0.8 },
        { label: "80–90%", min: 0.8, max: 0.9 },
        { label: "90–100%", min: 0.9, max: 1.001 }
    ];

    const bucketResults = buckets.map(b => {
        const inBucket = withProb.filter(r => r.probability >= b.min && r.probability < b.max);
        if (!inBucket.length) return { ...b, n: 0, actualElevatedPct: null, insufficientSample: false };
        if (inBucket.length < MIN_CALIBRATION_BUCKET_SAMPLE) {
            return { ...b, n: inBucket.length, actualElevatedPct: null, insufficientSample: true };
        }
        const actualElevatedCount = inBucket.filter(r => r.actualElevated).length;
        return {
            ...b,
            n: inBucket.length,
            actualElevatedPct: Math.round((actualElevatedCount / inBucket.length) * 1000) / 10,
            insufficientSample: false
        };
    });

    return { bucketResults, totalYears: backtestResults.length };
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

function renderBacktestTable(backtest, dispersionRatio, country) {
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

        <p class="chart-title">Prediction interval calibration (out-of-sample) — BEFORE recalibration</p>
        <p class="meta">
            The naive two-way split: interval built from the earliest ~75% of backtested years, checked against the
            most recent ~25% it never saw. Aligned to the SAME held-out years the "AFTER" section below uses, so the
            two are a genuine before/after comparison rather than two different test windows dressed up as one.
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

        <p class="chart-title">C.5.1 — recalibrated (AFTER)</p>
        <p class="meta">
            Proper three-way split: training years shape the raw interval, a width MULTIPLIER is searched for using
            ONLY a separate calibration set, and the final test years — never touched during that search — report the
            honest result. This is what "no tuning on the final test years" means concretely: the multiplier search
            loop has no access to the test set at all, so its reported coverage can't be circular.
        </p>
        <dl class="forecast-fields">
            ${[0.8, 0.9].map(cov => {
                const recal = computeRecalibratedInterval(backtest.results, 0, cov); // centralEstimate irrelevant here — only multiplier/coverage are shown, not low/high
                const label = `${Math.round(cov * 100)}% prediction interval`;
                if (!recal) return `<dt>${label}</dt><dd>Not enough backtested years for a three-way split yet (need at least ${MIN_YEARS_FOR_INTERVAL_RECALIBRATION}).</dd>`;
                return `
                    <dt>${label}</dt>
                    <dd>Width multiplier ×${recal.chosenMultiplier} (chosen using ${recal.calYears} calibration years only) → tested coverage
                    <b>${recal.testCoveragePct}%</b> on ${recal.testYears} final test year${recal.testYears === 1 ? "" : "s"}, never used to pick the multiplier —
                    <b>${recal.wellCalibrated ? "reasonably calibrated" : "still off target"}</b>. Width: ${recal.baseWidth} before multiplier → ${recal.finalWidth} after
                    (${Math.round((recal.finalWidth / recal.baseWidth) * 10) / 10}× wider).</dd>
                `;
            }).join("")}
        </dl>
        <p class="review-criteria-note">
            The live forecast above now uses this recalibrated interval (90% target), not the old one. If the "before"
            numbers here still show something like 2.8%/30.6%, that confirms the ORIGINAL heuristic/naive interval was
            genuinely overconfident — the "after" numbers are the actual fix, tested the same rigorous way.
        </p>

        <p class="chart-title">C.5.1 audit — is this interval construction, or a fundamentally misspecified distribution?</p>
        <p class="meta">
            Separating two different possible explanations for low coverage: (1) the interval-widening mechanism itself
            isn't working, or (2) the underlying process genuinely behaves differently across time periods, which no
            fixed multiplier could fix. All diagnostics below are read-only — none of them change what interval is shown.
        </p>
        ${(() => {
            const stability = computeDispersionStability(backtest.results);
            if (!stability) return `<p class="dq-empty">Not enough backtested years for a dispersion-stability check yet.</p>`;
            return `
                <table class="backtest-table">
                    <thead><tr><th>Period</th><th>Years</th><th>Residual std. dev.</th></tr></thead>
                    <tbody>
                        <tr><td>Training</td><td>${stability.training ? stability.training.n : "—"}</td><td>${stability.training ? stability.training.std : "—"}</td></tr>
                        <tr><td>Calibration</td><td>${stability.calibration ? stability.calibration.n : "—"}</td><td>${stability.calibration ? stability.calibration.std : "—"}</td></tr>
                        <tr><td>Test (final holdout)</td><td>${stability.test ? stability.test.n : "—"}</td><td>${stability.test ? stability.test.std : "—"}</td></tr>
                    </tbody>
                </table>
                <p class="backtest-summary">Verdict: <b>${stability.stabilityVerdict}</b>. If the test period's spread is far wider than training's, that's evidence of a genuinely shifting process, not just an under-tuned multiplier — a regime-change issue, not purely a C.5.1 construction issue.</p>
            `;
        })()}

        <p class="chart-title">Outlier sensitivity (90% interval)</p>
        ${(() => {
            const recal90 = computeRecalibratedInterval(backtest.results, 0, 0.9);
            const outlier = recal90 ? computeOutlierSensitivity(recal90) : null;
            if (!outlier) return `<p class="dq-empty">Not enough test years for an outlier-sensitivity check yet.</p>`;
            if (!outlier.worstMissExists) return `<p class="review-criteria-note">No misses in the test set at the 90% interval — coverage is ${outlier.totalCoveragePct}% with nothing to attribute to an outlier.</p>`;
            return `
                <p class="review-criteria-note">
                    Full test-set coverage: <b>${outlier.totalCoveragePct}%</b>. Removing only the single WORST-missed year
                    (which missed the interval by ${outlier.worstMissDistance} incidents): coverage becomes
                    <b>${outlier.coverageWithoutWorstPct}%</b>.
                    ${outlier.driftIsOutlierDriven
                        ? "That's a large swing from one year — worth checking whether that specific year has a data-quality issue or a genuinely unusual event, rather than assuming the whole method is broken."
                        : "That's not a large swing — the shortfall looks broadly systematic across the test years, not driven by one extreme outlier."}
                </p>
            `;
        })()}

        <p class="chart-title">C.5.1 formal comparison — Empirical multiplier vs. Negative Binomial</p>
        <p class="meta">
            Both methods share the exact same point forecast — only the interval width differs — so a point-forecast
            MAE/RMSE would be identical for both and wouldn't distinguish anything. The Winkler (interval) score below
            is the honest translation: interval width, plus a penalty for missing on either side, scaled by how badly
            it missed. Lower is better, and it's the standard proper scoring rule for comparing interval constructions.
        </p>
        ${(() => {
            const formal = computeC512FormalComparison(backtest);
            if (!formal) return `<p class="dq-empty">Not enough backtested years for the formal comparison yet.</p>`;
            if (formal.decision.verdict === "insufficient") return `<p class="dq-empty">${formal.decision.text}</p>`;

            function methodRows(m) {
                if (!m) return `<tr><td colspan="8">Not computable</td></tr>`;
                return `
                    <tr>
                        <td>${m.method}</td>
                        <td>${m.coveragePct}%</td>
                        <td>${m.calibrationErrorPct}pp</td>
                        <td>${m.avgWidth}</td>
                        <td>${m.avgWinklerScore}</td>
                        <td>${m.wellCalibrated ? "Yes" : "No"}</td>
                        <td>${m.firstHalfCoveragePct ?? "—"}% / ${m.secondHalfCoveragePct ?? "—"}%</td>
                        <td>train ${m.trainYears}${m.usesCalibrationSet ? `, cal ${m.calYears}` : " (cal unused)"}, test ${m.testYears}</td>
                    </tr>
                `;
            }

            const vol = formal.volatility;
            const volatilityHtml = vol ? `
                <p class="chart-title">Training / calibration / test volatility (shared — a property of the data, not either method)</p>
                <table class="backtest-table">
                    <thead><tr><th>Period</th><th>Years</th><th>Residual std. dev.</th></tr></thead>
                    <tbody>
                        <tr><td>Training</td><td>${vol.training ? vol.training.n : "—"}</td><td>${vol.training ? vol.training.std : "—"}</td></tr>
                        <tr><td>Calibration</td><td>${vol.calibration ? vol.calibration.n : "—"}</td><td>${vol.calibration ? vol.calibration.std : "—"}</td></tr>
                        <tr><td>Test (final holdout)</td><td>${vol.test ? vol.test.n : "—"}</td><td>${vol.test ? vol.test.std : "—"}</td></tr>
                    </tbody>
                </table>
                <p class="backtest-summary">Verdict: <b>${vol.stabilityVerdict}</b></p>
            ` : "";

            return `
                <p class="backtest-summary">80% target</p>
                <table class="backtest-table ablation-table">
                    <thead><tr><th>Method</th><th>Coverage</th><th>Calib. error</th><th>Avg. width</th><th>Winkler score</th><th>Calibrated?</th><th>1st/2nd half coverage</th><th>Sample requirement</th></tr></thead>
                    <tbody>${methodRows(formal.comparison80.empirical)}${methodRows(formal.comparison80.nb)}</tbody>
                </table>

                <p class="backtest-summary">90% target</p>
                <table class="backtest-table ablation-table">
                    <thead><tr><th>Method</th><th>Coverage</th><th>Calib. error</th><th>Avg. width</th><th>Winkler score</th><th>Calibrated?</th><th>1st/2nd half coverage</th><th>Sample requirement</th></tr></thead>
                    <tbody>${methodRows(formal.comparison90.empirical)}${methodRows(formal.comparison90.nb)}</tbody>
                </table>

                ${volatilityHtml}

                <div class="model-status-badge model-status-${formal.decision.verdict === "neither" ? "yellow" : "gray"}">
                    <span class="model-status-label">DOCUMENTED DECISION</span>
                    <p>${formal.decision.text}</p>
                </div>
                <p class="review-criteria-note">
                    "1st/2nd half coverage" splits the test set itself in two and reports coverage separately in each —
                    a method that looks fine in aggregate while swinging wildly between the two halves is unstable
                    across regimes, which the single aggregate number would otherwise hide. "Sample requirement" shows
                    that the empirical method needs a genuine calibration set to search its multiplier, while the NB
                    method as built only fits from training years — a real difference in minimum data needs, not just
                    a modeling preference.
                </p>
            `;
        })()}

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

        <h3 class="analysis-heading">Overdispersion test</h3>
        <p class="meta">
            Real fitted Negative Binomial regression needs server-side MLE dispersion estimation. What's tested here
            instead is honest and disclosed: a quasi-Poisson interval (widened by √dispersion ratio when the data is
            overdispersed) compared against the plain heuristic margin — walk-forward, on held-out years only.
        </p>
        ${(() => {
            const od = computeOverdispersionTest(backtest.results, dispersionRatio, 0.8);
            if (!od) return `<p class="dq-empty">Not enough backtested years to run this test yet.</p>`;
            return `
                <dl class="forecast-fields">
                    <dt>Dispersion ratio (variance/mean)</dt>
                    <dd>${od.dispersionRatio} — ${od.dispersionRatio > 1.5 ? "meaningfully overdispersed" : od.dispersionRatio > 1 ? "mildly overdispersed" : "not overdispersed"} relative to a Poisson assumption (ratio = 1)</dd>

                    <dt>Poisson-style interval, held-out coverage</dt>
                    <dd>${od.poissonTestCoveragePct}% (stated target: ${od.statedCoveragePct}%)</dd>

                    <dt>Quasi-Poisson interval, held-out coverage</dt>
                    <dd>${od.quasiPoissonTestCoveragePct}% (width ×${od.scaleFactor}, stated target: ${od.statedCoveragePct}%)</dd>

                    <dt>Preferred</dt>
                    <dd><b>${od.preferred}</b> — chosen because it lands closer to the stated ${od.statedCoveragePct}% target on ${od.testYears} held-out year(s) this comparison was never fit to.</dd>
                </dl>
            `;
        })()}

        <h3 class="analysis-heading">Probability calibration</h3>
        <p class="meta">
            If NHIRA says "70% probability," roughly 70% of comparably-scored forecasts should actually turn out
            elevated. Each bucket below uses only that year's own walk-forward probability — never information from
            later years.
        </p>
        ${(() => {
            const cal = computeCalibrationDashboard(backtest.results);
            if (!cal) return `<p class="dq-empty">Not enough backtested years to build a calibration table yet.</p>`;
            const rows = cal.bucketResults.map(b => `
                <tr>
                    <td>${b.label}</td>
                    <td>${b.n}</td>
                    <td>${b.n === 0 ? "No years in this bucket" : b.insufficientSample ? `Insufficient sample (n=${b.n})` : `${b.actualElevatedPct}%`}</td>
                </tr>
            `).join("");
            return `
                <table class="backtest-table">
                    <thead><tr><th>Stated probability</th><th>Years in bucket</th><th>Actual elevated rate</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
                <p class="review-criteria-note">
                    Buckets marked "Insufficient sample" (fewer than ${MIN_CALIBRATION_BUCKET_SAMPLE} years) show no
                    percentage on purpose — a rate computed from 1-2 years can look decisive (e.g. "100%") while really
                    just reflecting a single outcome. Only buckets with a real sample size are reported as a rate.
                </p>
            `;
        })()}

        <h3 class="analysis-heading">Model C threshold optimization</h3>
        <p class="meta">
            The 60-point tier boundary is a fixed, human-readable convention — not necessarily the best cutoff for the
            binary "elevated year" call. This sweeps candidate thresholds, picks the best-balanced one using training
            years only, then reports its real performance on held-out years it was never chosen using.
        </p>
        ${!backtest.thresholdSweep ? `<p class="dq-empty">Not enough backtested years with a Risk Score to run a threshold sweep yet.</p>` : `
            <table class="backtest-table">
                <thead><tr><th>Threshold</th><th>Training recall</th><th>Training precision</th></tr></thead>
                <tbody>
                    ${backtest.thresholdSweep.sweep.map(s => `
                        <tr class="${s.threshold === backtest.thresholdSweep.recommendedThreshold ? "blend-chosen" : ""}">
                            <td>${s.threshold}</td>
                            <td>${s.trainRecallPct === null ? "n/a" : s.trainRecallPct + "%"}</td>
                            <td>${s.trainPrecisionPct === null ? "n/a" : s.trainPrecisionPct + "%"}</td>
                        </tr>
                    `).join("")}
                </tbody>
            </table>
            <p class="backtest-summary">
                <b>Recommended threshold: ${backtest.thresholdSweep.recommendedThreshold}</b>, chosen strictly from
                ${backtest.thresholdSweep.trainYears} training years' precision/recall balance. Applied to the
                ${backtest.thresholdSweep.testYears} held-out year(s) it was never fit to: recall
                <b>${backtest.thresholdSweep.testRecallPct === null ? "n/a" : backtest.thresholdSweep.testRecallPct + "%"}</b>,
                precision <b>${backtest.thresholdSweep.testPrecisionPct === null ? "n/a" : backtest.thresholdSweep.testPrecisionPct + "%"}</b>.
            </p>
        `}

        <h3 class="analysis-heading">Model comparison</h3>
        <p class="meta">Does Model C provide incremental information beyond A/B, or is it just more sophisticated without being more useful?</p>
        <table class="backtest-table">
            <thead><tr><th>Model</th><th>MAE</th><th>RMSE</th><th>Recall</th><th>Precision</th><th>Calibration</th></tr></thead>
            <tbody>
                <tr><td>Naive</td><td>${backtest.naiveMAE}</td><td>${backtest.naiveRMSE}</td><td>—</td><td>—</td><td>—</td></tr>
                <tr><td>Model A</td><td>${backtest.modelMAE}</td><td>${backtest.modelRMSE}</td><td>—</td><td>—</td><td>${backtest.hitRate}%</td></tr>
                <tr><td>Model B</td><td>${backtest.modelMAE}</td><td>${backtest.modelRMSE}</td><td>${backtest.recall === null ? "—" : backtest.recall + "%"}</td><td>${backtest.precision === null ? "—" : backtest.precision + "%"}</td><td>—</td></tr>
                <tr><td>Model C</td><td>—</td><td>—</td><td>${!backtest.riskScoreMetrics || backtest.riskScoreMetrics.recall === null ? "—" : backtest.riskScoreMetrics.recall + "%"}</td><td>${!backtest.riskScoreMetrics || backtest.riskScoreMetrics.precision === null ? "—" : backtest.riskScoreMetrics.precision + "%"}</td><td>—</td></tr>
            </tbody>
        </table>
        <p class="review-criteria-note">Model B and C don't produce their own incident count, so MAE/RMSE shown for them is Model A's (the count forecast the elevated-year call is built on). Model A is a regression, not a classifier, so it has no recall/precision of its own.</p>

        ${!backtest.incrementalValue ? "" : `
            <div class="model-status-badge model-status-${backtest.incrementalValue.cAddsValue ? "green" : "yellow"}">
                <span class="model-status-label">${backtest.incrementalValue.cAddsValue ? "MODEL C ADDS INCREMENTAL VALUE" : "MODEL C NOT YET SHOWING INCREMENTAL VALUE"}</span>
                <p>
                    Across ${backtest.incrementalValue.n} backtested year(s): both models right in ${backtest.incrementalValue.bothRight},
                    both wrong in ${backtest.incrementalValue.bothWrong}, B right but C wrong in ${backtest.incrementalValue.bRightCWrong},
                    <b>C right but B wrong in ${backtest.incrementalValue.bWrongCRight}</b> (the years that actually
                    matter for this question — where C caught something B missed).
                    ${backtest.incrementalValue.cAddsValue
                        ? "C caught more years B missed than it missed that B caught — genuine incremental signal on this data."
                        : "C is not yet catching more than it's missing relative to B — on current evidence, B alone does at least as well."}
                </p>
            </div>
        `}

        <h3 class="analysis-heading">Brier score — probability quality</h3>
        <p class="meta">Lower is better: 0 = perfect, 0.25 = no better than a coin flip, 1 = perfectly wrong every time.</p>
        ${!backtest.brierScores ? `<p class="dq-empty">Not enough data to compute Brier scores yet.</p>` : `
            <dl class="forecast-fields">
                <dt>Model B probability</dt>
                <dd>${backtest.brierScores.modelB ? `${backtest.brierScores.modelB.score} (n=${backtest.brierScores.modelB.n})` : "Not computable"}</dd>
                <dt>Model C probability</dt>
                <dd>${backtest.brierScores.modelC ? `${backtest.brierScores.modelC.score} (n=${backtest.brierScores.modelC.n}) — Risk Score ÷ 100 treated as a probability` : "Not computable"}</dd>
                <dt>Baseline probability</dt>
                <dd>${backtest.brierScores.baseline ? `${backtest.brierScores.baseline.score} (n=${backtest.brierScores.baseline.n}) — constant historical elevated-rate, the same "no-skill" reference used in weather forecasting` : "Not computable"}</dd>
            </dl>
        `}

        <h3 class="analysis-heading">Model C ablation testing</h3>
        <p class="meta">
            Before adding a 7th factor (population), this checks whether the existing six deserve the weight they have.
            Same walk-forward years, same shared threshold, one factor removed at a time — isolating the effect of each.
        </p>
        ${(() => {
            const ablation = computeAblationTest(country, backtest);
            if (!ablation) return `<p class="dq-empty">Not enough backtested years with Risk Score coverage to run ablation testing yet.</p>`;

            const rows = ablation.variants.map(v => {
                const m = v.metrics;
                if (!m.n) return `<tr><td>${escapeHtml(v.label)}</td><td colspan="7">No coverage for this variant</td></tr>`;
                return `
                    <tr class="${v.key === null ? "blend-chosen" : ""}">
                        <td>${escapeHtml(v.label)}</td>
                        <td>${m.probMAE}${v.deltas?.probMAE != null ? ` <span class="backtest-range">(${v.deltas.probMAE > 0 ? "+" : ""}${v.deltas.probMAE})</span>` : ""}</td>
                        <td>${m.probRMSE}</td>
                        <td>${m.recall === null ? "—" : m.recall + "%"}${v.deltas?.recall != null ? ` <span class="backtest-range">(${v.deltas.recall > 0 ? "+" : ""}${v.deltas.recall}pp)</span>` : ""}</td>
                        <td>${m.precision === null ? "—" : m.precision + "%"}${v.deltas?.precision != null ? ` <span class="backtest-range">(${v.deltas.precision > 0 ? "+" : ""}${v.deltas.precision}pp)</span>` : ""}</td>
                        <td>${m.falsePositiveRate === null ? "—" : m.falsePositiveRate + "%"}</td>
                        <td>${m.falseNegativeRate === null ? "—" : m.falseNegativeRate + "%"}</td>
                        <td>${m.calibrationGap === null ? "—" : m.calibrationGap + "pp"}</td>
                        <td>${m.coverage}%</td>
                    </tr>
                `;
            }).join("");

            return `
                <table class="backtest-table ablation-table">
                    <thead>
                        <tr>
                            <th>Variant</th><th>Prob. MAE</th><th>Prob. RMSE</th><th>Recall</th><th>Precision</th>
                            <th>FPR</th><th>FNR</th><th>Calib. gap</th><th>Coverage</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
                <p class="review-criteria-note">
                    Deltas (in parentheses) show the change vs. the full model — e.g. "+3.2" on Prob. MAE means removing
                    that factor made the model WORSE (higher error is worse); a negative delta on Prob. MAE means removing
                    that factor actually IMPROVED it, which is the signal that a factor may not deserve its current weight.
                    "Prob. MAE/RMSE" are mean absolute/squared error between the score-as-probability and the actual
                    outcome — not incident-count units, since Model C doesn't forecast a count. "Calib. gap" is
                    calibration-in-the-large (|mean predicted probability − mean actual rate|), a single honest number
                    rather than a full bucket table, since splitting ${ablation.sharedYears} years seven ways would leave
                    each bucket too thin to trust. All variants use the SAME shared threshold (${ablation.threshold},
                    the full model's own walk-forward-recommended cutoff) so only the excluded factor differs between rows.
                </p>
            `;
        })()}

        <h3 class="analysis-heading">C.3 → C.4 → C.5 — does population adjustment help, and does using real historical population improve on today's snapshot?</h3>
        <p class="meta">
            C.3 is the no-population baseline. C.4 adds population using today's static snapshot for every year (the
            same limitation flagged earlier). C.5 adds population using the population that actually existed AROUND
            each backtest year — so a forecast made "as of" 2010 uses ~2010 population, never 2025's, which would leak
            information from outside the historical prediction window into the calculation.
        </p>
        ${(() => {
            if (!POPULATION_DATA[country] || !HISTORICAL_POPULATION_SERIES[country]) return `<p class="dq-empty">No population data on file for ${escapeHtml(country)} — this test only runs for countries with both a current figure and a historical series.</p>`;
            const popTest = computePopulationFactorTest(country, backtest);
            if (!popTest) return `<p class="dq-empty">Not enough backtested years to run this test yet.</p>`;
            if (!popTest.deltasC5) return `<p class="dq-empty">Population factor produced no coverage in this backtest window.</p>`;

            function metricRow(label, key, suffix, lowerIsBetter) {
                const c3v = popTest.c3[key], c4v = popTest.c4[key], c5v = popTest.c5[key];
                const c5delta = popTest.deltasC5[key];
                const improved = c5delta !== null && (lowerIsBetter ? c5delta < 0 : c5delta > 0);
                const fmt = v => v === null ? "—" : `${v}${suffix || ""}`;
                return `<tr><td>${label}</td><td>${fmt(c3v)}</td><td>${fmt(c4v)}</td><td>${fmt(c5v)}</td><td class="${improved ? "backtest-hit" : ""}">${c5delta == null ? "—" : (c5delta > 0 ? "+" : "") + c5delta}</td></tr>`;
            }

            return `
                <table class="backtest-table">
                    <thead><tr><th>Metric</th><th>C.3 (no pop.)</th><th>C.4 (static pop.)</th><th>C.5 (historical pop.)</th><th>C.5 vs. C.3</th></tr></thead>
                    <tbody>
                        ${metricRow("Prob. MAE", "probMAE", "", true)}
                        ${metricRow("Prob. RMSE", "probRMSE", "", true)}
                        ${metricRow("Recall", "recall", "%", false)}
                        ${metricRow("Precision", "precision", "%", false)}
                    </tbody>
                </table>

                <div class="model-status-badge model-status-${popTest.validated ? "green" : "yellow"}">
                    <span class="model-status-label">${popTest.validated ? "MODEL C — VALIDATED VERSION (C.5)" : "NOT YET VALIDATED"}</span>
                    <p>
                        ${popTest.validated
                            ? `C.5 (historical population) does not make error or recall meaningfully worse than the no-population baseline for ${escapeHtml(country)} — on this evidence, the historical-population version is the one to treat as "final Model C" for this country, per the locked development sequence.`
                            : `C.5 either makes Prob. MAE/RMSE worse, or drops recall by more than 2 percentage points, relative to the no-population baseline for ${escapeHtml(country)}. On this evidence, population adjustment — even with real year-specific data — is not yet earning its place in the model for this country.`}
                    </p>
                </div>

                <p class="review-criteria-note">
                    Green-highlighted deltas mean C.5 improved that metric relative to C.3. Interpolated Canada population
                    years are disclosed in the factor detail text (hover/inspect individual years); this comparison still
                    runs on whatever data exists, it just isn't fabricating precision the underlying series doesn't have.
                </p>
            `;
        })()}

        <h3 class="analysis-heading">D2 — does the violent-crime environment improve Model C?</h3>
        <div class="model-status-badge model-status-red">
            <span class="model-status-label">GATE DECISION: REJECTED (current data)</span>
            <p>${escapeHtml(D2_GATE_DECISION.reason)}</p>
            <p class="review-criteria-note"><b>Scope:</b> ${escapeHtml(D2_GATE_DECISION.scope)} Decided ${escapeHtml(D2_GATE_DECISION.decidedDate)}.
            Real FBI-sourced data, but only 6 of 51 US states/DC are covered (Alaska, Alabama, Arkansas, Arizona,
            California, Colorado) — ${D2_GATE_DECISION.evidence.stateCoveragePct}% of US incidents (${D2_GATE_DECISION.evidence.incidentsCovered} of ${D2_GATE_DECISION.evidence.incidentsTotal}).
            Never folded into the live Risk Score or production forecast.</p>
        </div>
        <p class="meta">
            This tests whether the surrounding crime-rate environment (a signal genuinely distinct from NHIRA's own
            incident-count trend) adds anything, using only incidents in covered states — never guessed or extrapolated
            to uncovered ones.
        </p>
        ${(() => {
            if (country !== "United States") return `<p class="dq-empty">D2 coverage is US-only (state-level FBI data) — not applicable to ${escapeHtml(country)}.</p>`;
            const d2 = computeD2Test(country, backtest);
            if (!d2) return `<p class="dq-empty">Not enough backtested years to run this test yet.</p>`;
            if (!d2.deltas) return `<p class="dq-empty">D2 produced no coverage in this backtest window — none of the backtested years had incidents in the 6 covered states.</p>`;

            const d = d2.deltas;
            const improved = k => d[k] !== null && d[k] < 0;
            const improvedRecall = d.recall !== null && d.recall > 0;

            return `
                <table class="backtest-table">
                    <thead><tr><th>Metric</th><th>Without D2</th><th>With D2</th><th>Delta</th></tr></thead>
                    <tbody>
                        <tr><td>Prob. MAE</td><td>${d2.withoutD2.probMAE}</td><td>${d2.withD2.probMAE}</td><td class="${improved("probMAE") ? "backtest-hit" : ""}">${d.probMAE == null ? "—" : (d.probMAE > 0 ? "+" : "") + d.probMAE}</td></tr>
                        <tr><td>Prob. RMSE</td><td>${d2.withoutD2.probRMSE}</td><td>${d2.withD2.probRMSE}</td><td class="${improved("probRMSE") ? "backtest-hit" : ""}">${d.probRMSE == null ? "—" : (d.probRMSE > 0 ? "+" : "") + d.probRMSE}</td></tr>
                        <tr><td>Recall</td><td>${d2.withoutD2.recall ?? "—"}%</td><td>${d2.withD2.recall ?? "—"}%</td><td class="${improvedRecall ? "backtest-hit" : ""}">${d.recall == null ? "—" : (d.recall > 0 ? "+" : "") + d.recall + "pp"}</td></tr>
                        <tr><td>Precision</td><td>${d2.withoutD2.precision ?? "—"}%</td><td>${d2.withD2.precision ?? "—"}%</td><td>${d.precision == null ? "—" : (d.precision > 0 ? "+" : "") + d.precision + "pp"}</td></tr>
                        <tr><td>Coverage</td><td>${d2.withoutD2.coverage}%</td><td>${d2.withD2.coverage}%</td><td>—</td></tr>
                    </tbody>
                </table>
                <p class="review-criteria-note">
                    ${VIOLENT_CRIME_COVERAGE.note} Source: <a href="${escapeHtml(VIOLENT_CRIME_COVERAGE.citationUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(VIOLENT_CRIME_COVERAGE.citation)}</a>.
                    With only 6 states covered, expect thin evidence — this is a first, honestly-scoped look, not a final
                    verdict on whether crime-environment data belongs in Model C. Extending to the remaining 45 states
                    needs the complete source file.
                </p>
            `;
        })()}

        <h3 class="analysis-heading">C.1/C.2 robustness audit</h3>
        <p class="meta">
            An AUDIT, not optimization — examines whether ${escapeHtml(country)}'s model holds up under reasonable
            alternative configurations. Nothing here changes what threshold, window, or weight the live forecast
            actually uses; that would turn an audit into another form of overfitting.
        </p>
        ${(() => {
            const audit = computeC1C2RobustnessAudit(country);
            if (audit.insufficientData) return `<p class="dq-empty">Not enough backtested years for a robustness audit yet.</p>`;

            const winRows = audit.windowSensitivity.map(w => w.insufficientData
                ? `<tr><td>${w.window} years</td><td colspan="4">Insufficient data at this window</td></tr>`
                : `<tr><td>${w.window} years${w.window === 10 ? " (production)" : ""}</td><td>${w.modelMAE}</td><td>${w.naiveMAE}</td><td>${w.beatsNaive ? "Yes" : "No"}</td><td>${w.recall ?? "—"}% / ${w.precision ?? "—"}%</td></tr>`
            ).join("");

            const threshRows = audit.thresholdSensitivity ? audit.thresholdSensitivity.rows.map(r =>
                `<tr class="${r.offset === 0 ? "blend-chosen" : ""}"><td>${r.threshold}${r.offset === 0 ? " (chosen)" : ` (${r.offset > 0 ? "+" : ""}${r.offset})`}</td><td>${r.recall ?? "—"}%</td><td>${r.precision ?? "—"}%</td></tr>`
            ).join("") : "";

            return `
                <p class="chart-title">1. Training-window sensitivity</p>
                <table class="backtest-table">
                    <thead><tr><th>Window</th><th>Model MAE</th><th>Naive MAE</th><th>Beats naive?</th><th>Recall / Precision</th></tr></thead>
                    <tbody>${winRows}</tbody>
                </table>

                <p class="chart-title">2. Threshold sensitivity</p>
                ${audit.thresholdSensitivity ? `
                    <table class="backtest-table">
                        <thead><tr><th>Threshold</th><th>Recall</th><th>Precision</th></tr></thead>
                        <tbody>${threshRows}</tbody>
                    </table>
                    <p class="review-criteria-note">Recall swing: ${audit.thresholdSensitivity.recallSwing ?? "n/a"}pp · Precision swing: ${audit.thresholdSensitivity.precisionSwing ?? "n/a"}pp across ±10 points from the chosen threshold. Collapse threshold: >25pp swing.</p>
                ` : `<p class="dq-empty">Not enough data for threshold sensitivity.</p>`}

                <p class="chart-title">3. Recent-history sensitivity</p>
                ${audit.recentHistorySensitivity ? `
                    <p class="review-criteria-note">
                        First half of backtested years (n=${audit.recentHistorySensitivity.first?.n ?? "—"}): recall ${audit.recentHistorySensitivity.first?.recall ?? "—"}%, MAE ${audit.recentHistorySensitivity.first?.mae ?? "—"}.
                        Second half (n=${audit.recentHistorySensitivity.second?.n ?? "—"}): recall ${audit.recentHistorySensitivity.second?.recall ?? "—"}%, MAE ${audit.recentHistorySensitivity.second?.mae ?? "—"}.
                        Recall gap: ${audit.recentHistorySensitivity.recallGap ?? "n/a"}pp.
                    </p>
                ` : `<p class="dq-empty">Not enough data for recent-history sensitivity.</p>`}

                <p class="chart-title">4. Outlier sensitivity</p>
                ${audit.outlierSensitivity ? `
                    <p class="review-criteria-note">
                        Highest-incident year: ${audit.outlierSensitivity.outlierYear} (${audit.outlierSensitivity.outlierActual} incidents).
                        MAE with it: ${audit.outlierSensitivity.withOutlier.mae}, without it: ${audit.outlierSensitivity.withoutOutlier.mae}
                        (${audit.outlierSensitivity.maeSwingPct}% swing). Recall with/without: ${audit.outlierSensitivity.withOutlier.recall ?? "—"}% / ${audit.outlierSensitivity.withoutOutlier.recall ?? "—"}%.
                    </p>
                ` : `<p class="dq-empty">Not enough data for outlier sensitivity.</p>`}

                <div class="model-status-badge model-status-${audit.robust ? "green" : "yellow"}">
                    <span class="model-status-label">${escapeHtml(country)} — ${audit.robust ? "ROBUST" : "NOT ROBUST"}</span>
                    <ul class="review-criteria">
                        ${audit.reasons.map(r => `<li>${escapeHtml(r)}</li>`).join("")}
                    </ul>
                </div>
            `;
        })()}

        <h3 class="analysis-heading">Model D1 — candidate ensemble (pre-registered spec, built against real data)</h3>
        <p class="meta">
            D1 = Model C + only inputs with a completed evidence gate. D2 is excluded (rejected). Model B is excluded
            (no formal gate exists for it yet). Given those constraints, D1 is a walk-forward-LEARNED blend of Model
            C's own Risk Score probability and its count-model (Poisson) probability — not a new variable, a different
            combination of two already-gated signals. Model C alone remains the production baseline throughout this
            entire evaluation.
        </p>
        ${(() => {
            const d1 = computeD1Test(country);
            if (d1.insufficientData) return `<p class="dq-empty">Not enough backtested years to build and test D1 yet.</p>`;

            const winRows = d1.windowRobustness.map(w => w.insufficientData
                ? `<tr><td>${w.window} years</td><td colspan="3">Insufficient data</td></tr>`
                : `<tr><td>${w.window} years</td><td>${w.d1ProbMAE ?? "—"}</td><td>${w.cProbMAE ?? "—"}</td><td>${w.d1BeatsC === null ? "—" : (w.d1BeatsC ? "D1" : "C")}</td></tr>`
            ).join("");

            return `
                <p class="chart-title">D1 vs. Model C — held-out comparison (blend weight ${d1.chosenWeight}, chosen from ${d1.trainYears} training years, tested on ${d1.testYears} held-out years)</p>
                <table class="backtest-table">
                    <thead><tr><th>Metric</th><th>D1</th><th>Model C alone</th></tr></thead>
                    <tbody>
                        <tr><td>Probability MAE</td><td>${d1.d1Metrics.probMAE}</td><td>${d1.modelCMetrics.probMAE}</td></tr>
                        <tr><td>Probability RMSE</td><td>${d1.d1Metrics.probRMSE}</td><td>${d1.modelCMetrics.probRMSE}</td></tr>
                        <tr><td>Brier score</td><td>${d1.d1Metrics.brier}</td><td>${d1.modelCMetrics.brier}</td></tr>
                        <tr><td>Recall</td><td>${d1.d1Metrics.recall ?? "—"}%</td><td>${d1.modelCMetrics.recall ?? "—"}%</td></tr>
                        <tr><td>Precision</td><td>${d1.d1Metrics.precision ?? "—"}%</td><td>${d1.modelCMetrics.precision ?? "—"}%</td></tr>
                        <tr><td>False positive rate</td><td>${d1.d1Metrics.falsePositiveRate ?? "—"}%</td><td>${d1.modelCMetrics.falsePositiveRate ?? "—"}%</td></tr>
                        <tr><td>False negative rate</td><td>${d1.d1Metrics.falseNegativeRate ?? "—"}%</td><td>${d1.modelCMetrics.falseNegativeRate ?? "—"}%</td></tr>
                    </tbody>
                </table>

                <p class="chart-title">Robustness across training windows (the safeguard against winning on one lucky split)</p>
                <table class="backtest-table">
                    <thead><tr><th>Window</th><th>D1 Prob. MAE</th><th>C Prob. MAE</th><th>Winner</th></tr></thead>
                    <tbody>${winRows}</tbody>
                </table>

                <div class="model-status-badge model-status-${d1.promoted ? "green" : "yellow"}">
                    <span class="model-status-label">${escapeHtml(country)} D1 — ${d1.promoted ? "PROMOTED TO TOURNAMENT CANDIDATE" : "REJECTED"}</span>
                    <ul class="review-criteria">
                        ${d1.reasons.map(r => `<li>${escapeHtml(r)}</li>`).join("")}
                    </ul>
                </div>
                <p class="review-criteria-note">
                    Pre-registered rule: D1 must beat Model C on held-out probability MAE, not lose more than 5pp of
                    recall or precision, AND win at a majority of tested training windows — a single good split does
                    not count as "beats C." Even if promoted here, D1 does not become production; it becomes eligible
                    for the model tournament (Naive → A → B → C → D1), which has not been built yet.
                </p>
            `;
        })()}

        <p class="review-criteria-note">
            Every row above was trained ONLY on data available before that forecast year — the model was never shown
            the year it was predicting. "Here is how NHIRA performed when it was not allowed to see the future."
        </p>
    `;
}

function renderCrossCountryValidation() {
    const v = computeCrossCountryValidation();

    if (v.insufficientData) {
        return `<p class="dq-empty">Not enough backtested history yet in ${v.usAvailable ? "" : "the United States"}${!v.usAvailable && !v.caAvailable ? " or " : ""}${v.caAvailable ? "" : "Canada"} to run cross-country validation.</p>`;
    }

    function row(label, key, suffix) {
        const fmt = x => x === null ? "—" : (typeof x === "boolean" ? (x ? "Yes" : "No") : `${x}${suffix || ""}`);
        return `<tr><td>${label}</td><td>${fmt(v.c1[key])}</td><td>${fmt(v.c2[key])}</td><td>${fmt(v.c3[key])}</td></tr>`;
    }

    const popTest = computePopulationRankingTest();

    // Mechanical status check, not a judgment call: if C.3's recall
    // trails BOTH individual countries by more than 15 points, pooling
    // is doing real damage, not just showing mild generalization noise
    // — that's the threshold for flagging it research-only rather than
    // production-grade here.
    const c3Recall = v.c3.modelCRecall;
    const c1Recall = v.c1.modelCRecall;
    const c2Recall = v.c2.modelCRecall;
    const pooledUnderperforms = c3Recall !== null && c1Recall !== null && c2Recall !== null
        && c3Recall < Math.min(c1Recall, c2Recall) - 15;

    return `
        <div class="model-status-badge model-status-${pooledUnderperforms ? "yellow" : "gray"}">
            <span class="model-status-label">C.3 IS RESEARCH-ONLY — NOT THE PRIMARY FORECAST</span>
            <p>
                The public NHIRA forecast for a given country always comes from that country's own model (C.1 for the
                US, C.2 for Canada) — never from the pooled C.3. C.3 exists to test whether the shared formula
                generalizes across countries, nothing more.
                ${pooledUnderperforms
                    ? `Right now it's earning that "research-only" label: pooled recall (${c3Recall}%) trails both individual
                       countries by more than 15 points (US: ${c1Recall}%, Canada: ${c2Recall}%) — forcing one formula onto
                       both countries at once is currently losing real information, not just showing mild generalization
                       noise. Keep C.1 and C.2 as fully separate, independently-thresholded models rather than trying to
                       replace them with a combined one.`
                    : `Its numbers are currently reasonably close to both individual countries — a mildly encouraging
                       generalization signal, though still not a reason to route the primary forecast through it.`}
            </p>
        </div>
        <table class="backtest-table">
            <thead><tr><th>Metric</th><th>C.1 — United States (n=${v.usYears})</th><th>C.2 — Canada (n=${v.caYears})</th><th>C.3 — Pooled, research-only (n=${v.c1.n + v.c2.n})</th></tr></thead>
            <tbody>
                ${row("Model MAE", "modelMAE")}
                ${row("Naive MAE", "naiveMAE")}
                ${row("Model RMSE", "modelRMSE")}
                ${row("Beats naive?", "beatsNaive")}
                ${row("Model B recall", "modelBRecall", "%")}
                ${row("Model B precision", "modelBPrecision", "%")}
                ${row("Model C recall", "modelCRecall", "%")}
                ${row("Model C precision", "modelCPrecision", "%")}
                ${row("Model C coverage", "modelCCoverage", "%")}
            </tbody>
        </table>
        <p class="review-criteria-note">
            C.1 and C.2 use each country's OWN walk-forward-recommended Model C threshold (US: ${v.usThreshold}, Canada:
            ${v.caThreshold}). C.3's threshold (${v.sharedThreshold}) is ALSO walk-forward-tuned — on the pooled data,
            not borrowed from either country and not left at an arbitrary untuned default. Forcing a pooled model to use
            a threshold neither country's own data actually supports would test whether the model works at the wrong
            operating point, not whether pooling itself works. If C.3's numbers hold up reasonably close to C.1 and C.2
            individually, that's evidence the pattern generalizes rather than being fit to one country's quirks. If C.3
            is notably worse than both, the two countries may need to stay modeled separately rather than combined.
        </p>
        ${v.pooledSweep ? `
            <p class="chart-title">C.3 pooled threshold sweep</p>
            <table class="backtest-table">
                <thead><tr><th>Threshold</th><th>Training recall</th><th>Training precision</th></tr></thead>
                <tbody>
                    ${v.pooledSweep.sweep.map(s => `
                        <tr class="${s.threshold === v.pooledSweep.recommendedThreshold ? "blend-chosen" : ""}">
                            <td>${s.threshold}</td>
                            <td>${s.trainRecallPct === null ? "n/a" : s.trainRecallPct + "%"}</td>
                            <td>${s.trainPrecisionPct === null ? "n/a" : s.trainPrecisionPct + "%"}</td>
                        </tr>
                    `).join("")}
                </tbody>
            </table>
            <p class="review-criteria-note">
                Chosen from ${v.pooledSweep.trainYears} pooled training years; held-out performance on the remaining
                ${v.pooledSweep.testYears} pooled years: recall ${v.pooledSweep.testRecallPct === null ? "n/a" : v.pooledSweep.testRecallPct + "%"},
                precision ${v.pooledSweep.testPrecisionPct === null ? "n/a" : v.pooledSweep.testPrecisionPct + "%"}.
            </p>
        ` : `<p class="dq-empty">Not enough pooled years to walk-forward tune C.3's own threshold yet — using the untuned default (60).</p>`}

        <p class="chart-title">Population adjustment — does it change the picture?</p>
        ${!popTest ? `<p class="dq-empty">Population-adjusted rate not available for one or both countries yet.</p>` : `
            <table class="backtest-table">
                <thead><tr><th></th><th>Raw rate (incidents/year)</th><th>Per 100,000 population</th></tr></thead>
                <tbody>
                    <tr><td>United States</td><td>${popTest.us.raw}</td><td>${popTest.us.per100k}</td></tr>
                    <tr><td>Canada</td><td>${popTest.ca.raw}</td><td>${popTest.ca.per100k}</td></tr>
                </tbody>
            </table>
            <p class="backtest-summary">
                Higher raw rate: <b>${popTest.rawWinner}</b>. Higher per-capita rate: <b>${popTest.adjustedWinner}</b>.
                ${popTest.rankingChanges
                    ? "<b>These disagree</b> — population adjustment changes which country looks more elevated. This is exactly the scenario population adjustment exists to catch."
                    : "These agree — for these two countries, population adjustment doesn't currently change which one looks more elevated, though it still changes the reported magnitude."}
            </p>
        `}
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

    const raw = result.recentActivityWindows;
    const recentActivityHtml = `
        <p class="chart-title">Recent activity — measurement windows</p>
        <dl class="forecast-fields">
            <dt>Latest complete year${raw.latestYearLabel !== undefined ? ` (${raw.latestYearLabel})` : ""}</dt>
            <dd>${raw.latestYearCount === null ? "Not available" : `${raw.latestYearCount} incident${raw.latestYearCount === 1 ? "" : "s"}`}</dd>

            <dt>Prior year${raw.priorYearLabel !== undefined ? ` (${raw.priorYearLabel})` : ""}</dt>
            <dd>${raw.priorYearCount === null ? "Not available — not enough consecutive years" : `${raw.priorYearCount} incident${raw.priorYearCount === 1 ? "" : "s"}`}</dd>

            <dt>YoY change</dt>
            <dd>${result.yoyChangePct === null ? "Not computable" : `${result.yoyChangePct > 0 ? "+" : ""}${result.yoyChangePct}%`}</dd>

            <dt>3-year annualized rate</dt>
            <dd>${raw.threeYearAnnualizedRate === null ? "Not available" : `${raw.threeYearAnnualizedRate}/year`}</dd>

            <dt>Long-run rate (for comparison)</dt>
            <dd>${result.historicalAnnualRate}/year</dd>
        </dl>
        <p class="review-criteria-note">
            A large YoY swing on a small base year (e.g. 2 incidents → 0) can look dramatic as a percentage while
            representing very little real change — these raw counts are shown specifically so that judgment call is
            never hidden behind a single percentage.
        </p>
    `;

    const sign = n => (n >= 0 ? "+" : "") + n;

    // C.5.1 fix: use the properly train->calibrate->test recalibrated
    // interval, which honestly reports out-of-sample coverage, instead
    // of the old computeEmpiricalPredictionInterval (built from ALL
    // residuals with no held-out check — the exact procedure that let
    // an unvalidated "80%"/"90%" claim reach the live forecast while
    // the separate diagnostic correctly showed it was badly
    // overconfident). Falls back to the plain heuristic margin, always
    // labeled as exactly that, when there isn't enough data for a
    // meaningful three-way split.
    //
    // If this country is locked in C51_INTERVAL_LOCK with the NB
    // method (currently: Canada only), the live interval uses the
    // SAME fitted r-parameter the lock documents, applied to today's
    // central estimate — not a separately-maintained calculation that
    // could drift from what was actually audited and locked. The US
    // is not in that registry, so it falls straight through to the
    // existing empirical/heuristic path, completely unchanged.
    const c51Lock = C51_INTERVAL_LOCK[country];
    let recalInterval = null;
    if (c51Lock && c51Lock.method === "Negative Binomial") {
        const tail = (1 - 0.9) / 2;
        const mean = Math.max(0.01, result.modelEstimate);
        recalInterval = {
            low: Math.max(0, negBinomialQuantile(tail, mean, c51Lock.rParameter)),
            high: negBinomialQuantile(1 - tail, mean, c51Lock.rParameter),
            coveragePct: 90,
            testCoveragePct: c51Lock.results.coverage90.actualCoveragePct,
            testYears: c51Lock.testWindow.testYears,
            wellCalibrated: true, // locked specifically because it cleared the bar
            locked: true
        };
    } else if (cachedBacktest && !cachedBacktest.insufficientData) {
        recalInterval = computeRecalibratedInterval(cachedBacktest.results, result.modelEstimate, 0.9);
    }
    const intervalLow = recalInterval ? recalInterval.low : result.estimateLow;
    const intervalHigh = recalInterval ? recalInterval.high : result.estimateHigh;
    const intervalLabel = recalInterval
        ? (recalInterval.locked
            ? `Prediction interval — Negative Binomial, locked for production. Audited coverage: ${recalInterval.testCoveragePct}% on ${recalInterval.testYears} held-out years (target 90%).`
            : `Prediction interval — target ${recalInterval.coveragePct}%, tested out-of-sample coverage ${recalInterval.testCoveragePct}% on ${recalInterval.testYears} held-out year${recalInterval.testYears === 1 ? "" : "s"} (${recalInterval.wellCalibrated ? "reasonably calibrated" : "still recalibrating — treat the width as provisional"})`)
        : "Prediction interval (heuristic — not yet tied to a tested percentage; run a backtest below to establish one)";

    const headerLiveMode = getLivePopulationMode(country);
    const modelVersionLabel = headerLiveMode.status === "locked"
        ? "Model C.5 — validated historical-population version"
        : "Model C — 6-factor version (no population adjustment locked for this country yet)";

    fcOutput.innerHTML = `
        <div class="forecast-header">
            <span class="risk-badge risk-${result.riskTier}">${riskLabel}</span>
            <h3>NHIRA statistical forecast: ${riskLabel.toLowerCase()} historical-activity category</h3>
            <p class="forecast-subhead">${escapeHtml(result.country)} · ${result.periodLabel}</p>
            <p class="forecast-model-version">Model: ${escapeHtml(modelVersionLabel)}</p>
        </div>

        <h3 class="analysis-heading">Model Status</h3>
        <p class="meta">What's active, what's research-only, and what's locked — read directly from the same status checks that gate the forecast itself, not a separately-maintained summary.</p>
        ${renderModelStatusPanel()}

        <h3 class="analysis-heading">NHIRA Research Risk Score</h3>
        <p class="meta">
            Current geographic risk relative to ${escapeHtml(country)}'s own historical baseline — a single explainable
            0–100 composite, back-tested the same way as Models A and B. Uses six weighted factors, or seven when
            historical-population adjustment has validated for this country (see below).
        </p>
        ${renderRiskScore(country)}

        <h3 class="analysis-heading">Model A — Incident Count Forecast</h3>
        <p class="meta">Answers "how many incidents should we expect?"</p>
        <div class="model-status-badge model-status-${modelA.level}">
            <span class="model-status-label">${modelA.label}</span>
            <p>${modelA.text}</p>
        </div>

        ${result.dataConfidence === "Insufficient data" ? `
            <div class="model-status-badge model-status-gray">
                <span class="model-status-label">FORECAST CONFIDENCE: INSUFFICIENT DATA</span>
                <p>${escapeHtml(country)} has too little historical data (${result.yearsOfData} year(s), ${result.totalInWindow} incident(s) in the analysis window) to responsibly show a point estimate. Rather than force a number, NHIRA is declining to display one here.</p>
            </div>
        ` : `
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

        <dl class="forecast-fields">
            <dt>Population-adjusted rate (current snapshot, Model A context)</dt>
            <dd>${result.populationAdjustedRate
                ? `${result.populationAdjustedRate.per100k} per 100,000 people · ${result.populationAdjustedRate.perMillion} per million (population ${result.populationAdjustedRate.population.toLocaleString()}, ${escapeHtml(result.populationAdjustedRate.asOf)}) — <a href="${escapeHtml(result.populationAdjustedRate.citationUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(result.populationAdjustedRate.citation)}</a>. This is today's snapshot shown as context for Model A's count estimate — the Risk Score above uses year-specific historical population instead, once validated (see status noted there).`
                : "Not available — no cited population figure integrated for this country yet"}</dd>

            <dt>Regime</dt>
            <dd><b>${result.regime.regime}</b> — ${escapeHtml(result.regime.detail)}${result.regime.regime === "Structural break" || result.regime.regime === "High-volatility" ? " A model trained across the full history may not reflect the current regime as well as one weighted toward recent years." : ""}</dd>
        </dl>
        `}

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
            <li>${(() => {
                const liveMode = getLivePopulationMode(country);
                if (liveMode.status === "locked") return "Population-adjusted rate — Model C.5 (historical population, integrated using the population available around each forecast year) — locked for production, active in the Risk Score above";
                if (liveMode.status === "validated_unlocked") return "Population-adjusted rate — validated this session, active in the Risk Score above, not yet locked for production";
                if (liveMode.status === "not_validated") return "Population-adjusted rate — data available, but historical-population adjustment did not validate for this country (see backtest below)";
                if (liveMode.status === "no_data") return "Population-adjusted rate — not available (no population dataset integrated for this country)";
                return "Population-adjusted rate — data available; run a backtest below to check whether it validates for live use";
            })()}</li>
        </ul>

        ${explainHtml}
        ${recentActivityHtml}

        <p class="forecast-disclaimer">
            This is a statistical risk category based on historical patterns in NHIRA's current dataset —
            not a prediction that an incident will occur. ${(() => {
                const c51 = getC51Status(country);
                if (c51.status === "not_run") {
                    return `This current forecast classification has not yet been validated in the backtest shown below. Run the backtest to evaluate its historical performance.`;
                }
                if (c51.status === "locked") {
                    return `The count/classification model has been extensively backtested against historical outcomes (see below), and its prediction-interval calibration (C.5.1) is locked for production.`;
                }
                return `The count/classification model HAS been backtested against historical outcomes (see the Model C validation and backtest sections below) — but its prediction-interval calibration (<b>C.5.1 status: UNDER REVIEW</b>) is not yet locked. Treat the prediction interval shown above as provisional until that review is complete.`;
            })()}
        </p>

        ${(() => {
            const c51 = getC51Status(country);
            if (c51.status !== "under_review") return "";
            return `
                <div class="model-status-badge model-status-yellow">
                    <span class="model-status-label">C.5.1 STATUS: UNDER REVIEW</span>
                    <p>
                        Before/after test years: <b>${c51.sameTestYears ? "identical" : "MISMATCHED — comparison not valid"}</b>
                        (${c51.after90.testYears} held-out years, never used to choose anything).<br>
                        80% interval — coverage before: <b>${c51.before80 ? c51.before80.actualCoveragePct + "%" : "n/a"}</b>,
                        after: <b>${c51.after80.testCoveragePct}%</b>
                        (width ${c51.after80.baseWidth} → ${c51.after80.finalWidth}, ×${c51.after80.chosenMultiplier}).<br>
                        90% interval — coverage before: <b>${c51.before90 ? c51.before90.actualCoveragePct + "%" : "n/a"}</b>,
                        after: <b>${c51.after90.testCoveragePct}%</b>
                        (width ${c51.after90.baseWidth} → ${c51.after90.finalWidth}, ×${c51.after90.chosenMultiplier}).<br>
                        ${c51.anyWellCalibrated
                            ? "At least one target is now within a reasonable margin of its stated coverage — worth a formal review to decide whether to lock it."
                            : "Neither target is yet within a reasonable margin of its stated coverage — recalibration has not been accepted. See the C.5.1.2 regime-stability audit below before deciding whether this is fixable by construction alone."}
                        No lock has been applied — this status is not editable by the code, only by adding this country to
                        <code>C51_INTERVAL_LOCK</code> after an actual human review of these numbers.
                    </p>
                </div>
            `;
        })()}

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
        <div id="fcBacktestOutput">${backtestCache[country] ? renderBacktestTable(backtestCache[country], result.dispersionRatio, country) : ""}</div>

        ${(country === "United States" || country === "Canada") ? `
            <h3 class="analysis-heading">Cross-country validation — C.1 (US) vs. C.2 (Canada) vs. C.3 (pooled)</h3>
            <p class="meta">
                Before Model D gets built, this checks whether Model C's fixed-weight formula generalizes across both
                countries or is quietly overfit to one of them. Runs a full backtest for each country independently, plus
                the same formula evaluated on the two countries' walk-forward years pooled together.
            </p>
            <button id="fcCrossCountryBtn" type="button" class="backtest-run-btn">Run cross-country validation</button>
            <div id="fcCrossCountryOutput"></div>
        ` : ""}
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

    const fcCrossCountryBtn = document.getElementById("fcCrossCountryBtn");
    const fcCrossCountryOutput = document.getElementById("fcCrossCountryOutput");
    if (fcCrossCountryBtn && fcCrossCountryOutput) {
        fcCrossCountryBtn.addEventListener("click", () => {
            // Ensure both countries have a cached backtest before comparing.
            if (!backtestCache["United States"]) backtestCache["United States"] = computeBacktest("United States");
            if (!backtestCache["Canada"]) backtestCache["Canada"] = computeBacktest("Canada");
            fcCrossCountryOutput.innerHTML = renderCrossCountryValidation();
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

    // Additive: mirror a condensed version into the new persistent
    // right-panel card, if it exists. Does not alter or depend on
    // anything above — the existing drawer keeps working exactly as
    // it did regardless of whether this element is present.
    const dashDetails = document.getElementById("dashIncidentDetails");
    if (dashDetails) {
        dashDetails.innerHTML = `
            <h3 class="dash-panel-heading">Incident Details</h3>
            <span class="tag" style="--tag:${type.color}">${escapeHtml(type.label)}${projected ? " &middot; projected" : ""}</span>
            <p style="font:700 .92rem var(--font-display);color:var(--dash-text);margin:8px 0 2px;">${escapeHtml(event.title)}</p>
            <p style="font:400 .72rem var(--font-mono);color:var(--dash-text-soft);margin:0 0 10px;">${escapeHtml(event.date || event.year)}</p>
            <p style="font:400 .76rem var(--font-body);color:var(--dash-text-soft);margin:0 0 10px;">📍 ${place}</p>
            <div class="dash-stat-grid" style="margin-bottom:10px;">
                <div><span style="color:var(--dash-red);">${escapeHtml(event.fatalities ?? "—")}</span><label>Fatalities</label></div>
                <div><span style="color:var(--dash-amber);">${escapeHtml(event.injuries ?? "—")}</span><label>Injuries</label></div>
            </div>
            <p style="font:400 .74rem/1.5 var(--font-body);color:var(--dash-text);margin:0;">${escapeHtml(event.description)}</p>
        `;
    }
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

// ---------------------------------------------------------------------
// Dashboard shell — real-data population only. Every number here comes
// directly from `events` (the actual loaded dataset). Nothing here
// touches the forecasting pipeline, the production Risk Score, or
// history.json — this is strictly a display layer over real,
// already-existing data.
// ---------------------------------------------------------------------

function populateDashboardShell() {
    const totalIncidents = events.length;
    const totalFatalities = events.reduce((s, e) => s + (e.fatalities || 0), 0);
    const totalInjuries = events.reduce((s, e) => s + (e.injuries || 0), 0);
    const countries = new Set(events.map(e => e.country).filter(Boolean));
    const categories = new Set(events.map(e => e.category).filter(Boolean));
    const sources = new Set();
    events.forEach(e => (e.sources || []).forEach(s => sources.add(s)));

    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText("dashStatIncidents", totalIncidents.toLocaleString());
    setText("dashStatFatalities", totalFatalities.toLocaleString());
    setText("dashStatInjuries", totalInjuries.toLocaleString());
    setText("dashStatCountries", countries.size);
    setText("dashStatCategories", categories.size);
    setText("dashStatSources", sources.size);

    const lastUpdatedEl = document.getElementById("dashLastUpdated");
    if (lastUpdatedEl) {
        const mostRecent = events.reduce((max, e) => (e.date && e.date > max ? e.date : max), "");
        lastUpdatedEl.textContent = mostRecent ? `Data through: ${mostRecent}` : "Last updated: —";
    }

    // Decade aggregation, real data only
    const byDecadeIncidents = {}, byDecadeFatalities = {};
    events.forEach(e => {
        const decade = Math.floor(e.year / 10) * 10;
        byDecadeIncidents[decade] = (byDecadeIncidents[decade] || 0) + 1;
        byDecadeFatalities[decade] = (byDecadeFatalities[decade] || 0) + (e.fatalities || 0);
    });
    const decades = Object.keys(byDecadeIncidents).map(Number).sort((a, b) => a - b);
    const decadeLabels = decades.map(d => `${d}s`);

    const chartDefaults = {
        plugins: { legend: { display: false } },
        scales: {
            x: { ticks: { color: "#8993A6", font: { size: 10 } }, grid: { color: "#232A38" } },
            y: { ticks: { color: "#8993A6", font: { size: 10 } }, grid: { color: "#232A38" }, beginAtZero: true }
        }
    };

    const incCanvas = document.getElementById("dashChartIncidentsByDecade");
    if (incCanvas && window.Chart) {
        new Chart(incCanvas, {
            type: "bar",
            data: { labels: decadeLabels, datasets: [{ data: decades.map(d => byDecadeIncidents[d]), backgroundColor: "#3B82F6" }] },
            options: chartDefaults
        });
    }
    const fatCanvas = document.getElementById("dashChartFatalitiesByDecade");
    if (fatCanvas && window.Chart) {
        new Chart(fatCanvas, {
            type: "bar",
            data: { labels: decadeLabels, datasets: [{ data: decades.map(d => byDecadeFatalities[d]), backgroundColor: "#EF4444" }] },
            options: chartDefaults
        });
    }

    // Top categories — real category values, grouped: top 5 exact
    // categories shown individually, everything else folded into
    // "Other" so the donut stays readable rather than showing 144 slices.
    const catCounts = {};
    events.forEach(e => { if (e.category) catCounts[e.category] = (catCounts[e.category] || 0) + 1; });
    const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
    const topCats = sortedCats.slice(0, 5);
    const otherCount = sortedCats.slice(5).reduce((s, [, n]) => s + n, 0);
    const catLabels = [...topCats.map(([name]) => name), "Other"];
    const catValues = [...topCats.map(([, n]) => n), otherCount];
    const catColors = ["#3B82F6", "#EF4444", "#22C55E", "#F59E0B", "#A855F7", "#5B6472"];

    const catCanvas = document.getElementById("dashChartTopCategories");
    if (catCanvas && window.Chart) {
        new Chart(catCanvas, {
            type: "doughnut",
            data: { labels: catLabels, datasets: [{ data: catValues, backgroundColor: catColors, borderColor: "#12161F", borderWidth: 2 }] },
            options: {
                plugins: { legend: { position: "right", labels: { color: "#E7EAF0", font: { size: 10 }, boxWidth: 10 } } }
            }
        });
    }

    // Highest-fatality incidents — real top 5 by fatalities
    const topFatalitiesList = document.getElementById("dashTopFatalities");
    if (topFatalitiesList) {
        const top5 = [...events].sort((a, b) => (b.fatalities || 0) - (a.fatalities || 0)).slice(0, 5);
        topFatalitiesList.innerHTML = top5.map(e => `
            <li>
                <span>${escapeHtml(e.title)} <span style="color:var(--dash-text-soft);">(${e.year})</span></span>
                <span class="dash-rank-fatalities">${(e.fatalities || 0).toLocaleString()}+</span>
            </li>
        `).join("");
    }

    // Filters — real country list from the actual dataset. Category
    // uses the existing INCIDENT_TYPES/resolveType system (the same
    // one the Research panel and legend already use), not the raw
    // 144-value event.category field — that's too granular for a
    // usable dropdown and wouldn't match the filtering logic below.
    const countrySelect = document.getElementById("dashFilterCountry");
    if (countrySelect) {
        [...countries].sort().forEach(c => {
            const opt = document.createElement("option");
            opt.value = c; opt.textContent = c;
            countrySelect.appendChild(opt);
        });
    }
    const categorySelect = document.getElementById("dashFilterCategory");
    if (categorySelect) {
        Object.entries(INCIDENT_TYPES).forEach(([key, t]) => {
            const opt = document.createElement("option");
            opt.value = key; opt.textContent = t.label;
            categorySelect.appendChild(opt);
        });
    }
}

// ---------------------------------------------------------------------
// Dashboard sidebar filters — actually wired into the map's central
// filtering pipeline (getMatchedEvents), the same pipeline the
// existing Research panel filters and search box already feed. This
// keeps ONE source of truth for "what's currently shown on the map"
// rather than a second, competing filter system.
// ---------------------------------------------------------------------

const DASH_FILTER_ELEMENTS_PRESENT = document.getElementById("dashFilterCountry") &&
    document.getElementById("dashFilterCategory") && document.getElementById("dashFilterMinFatalities") &&
    document.getElementById("dashStartYear") && document.getElementById("dashEndYear");

function matchesActiveDashFilters(event) {
    if (!DASH_FILTER_ELEMENTS_PRESENT) return true;

    const historicalLayerEl = document.getElementById("dashLayerHistorical");
    if (historicalLayerEl && !historicalLayerEl.checked) return false;

    const countryEl = document.getElementById("dashFilterCountry");
    const categoryEl = document.getElementById("dashFilterCategory");
    const minFatEl = document.getElementById("dashFilterMinFatalities");
    const startEl = document.getElementById("dashStartYear");
    const endEl = document.getElementById("dashEndYear");

    if (countryEl.value && event.country !== countryEl.value) return false;
    if (categoryEl.value && event.resolvedType !== categoryEl.value) return false;
    if ((event.fatalities || 0) < (Number(minFatEl.value) || 0)) return false;

    let dStart = Number(startEl.value);
    let dEnd = Number(endEl.value);
    if (!Number.isFinite(dStart)) dStart = MIN_YEAR;
    if (!Number.isFinite(dEnd)) dEnd = MAX_YEAR;
    if (dStart > dEnd) [dStart, dEnd] = [dEnd, dStart];
    if (event.year < dStart || event.year > dEnd) return false;

    return true;
}

if (DASH_FILTER_ELEMENTS_PRESENT) {
    const dashFilterIds = ["dashFilterCountry", "dashFilterCategory", "dashFilterMinFatalities", "dashStartYear", "dashEndYear"];
    dashFilterIds.forEach(id => {
        const el = document.getElementById(id);
        const evt = el.tagName === "SELECT" ? "change" : "input";
        el.addEventListener(evt, debounce(applyFilters, 150));
    });
}

const dashLayerHistorical = document.getElementById("dashLayerHistorical");
if (dashLayerHistorical) {
    dashLayerHistorical.addEventListener("change", applyFilters);
}


populateDashboardShell();

// Nav tabs: MAP is the default view; STATISTICS/FORECAST/DATA reuse
// the existing toggle buttons and panels unchanged (see the shared
// IDs in index.html). This just keeps the "active" tab highlight in
// sync with which drawer is actually open.
document.querySelectorAll(".dash-nav-tab").forEach(tab => {
    tab.addEventListener("click", () => {
        if (tab.dataset.nav === "map") {
            document.querySelectorAll(".dash-nav-tab").forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
        }
    });
});
