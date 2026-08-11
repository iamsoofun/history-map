// =====================================================================
// NHIRA — script.js
// Loads incidents from history.json, draws clustered typed markers,
// drives the timeline, and fills the detail, statistics, and forecast
// panels.
// =====================================================================

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

// Forecast risk overlay — off by default, toggled from the Forecast
// panel. Not added to the map until the user turns it on.
const forecastLayer = L.layerGroup();

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

const datasetCoverage = document.getElementById("datasetCoverage");
const coverageLastUpdated = document.getElementById("coverageLastUpdated");
const coverageNeedsReview = document.getElementById("coverageNeedsReview");
const sourceCoverage = document.getElementById("sourceCoverage");

// Forecast panel
const forecastToggle = document.getElementById("forecastToggle");
const forecastPanel = document.getElementById("forecastPanel");
const closeForecast = document.getElementById("closeForecast");
const fcCountry = document.getElementById("fcCountry");
const fcGenerateBtn = document.getElementById("fcGenerateBtn");
const fcMapToggle = document.getElementById("fcMapToggle");
const fcOutput = document.getElementById("fcOutput");

const FORECAST_ELEMENTS_PRESENT = forecastToggle && forecastPanel && closeForecast &&
    fcCountry && fcGenerateBtn && fcMapToggle && fcOutput;

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

    const last3 = usableYears.slice(-3).map(y => yearlyCounts[y] || 0);
    const movAvg3 = last3.length ? last3.reduce((a, b) => a + b, 0) / last3.length : mean;

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
    const datedEvents = countryEvents.filter(e => /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || "")));
    let seasonalityLabel = "Insufficient dated records";
    if (datedEvents.length >= 20) {
        const byMonth = new Array(12).fill(0);
        datedEvents.forEach(e => { byMonth[new Date(e.date).getMonth()]++; });
        const overallAvg = datedEvents.length / 12;
        const now = new Date();
        const targetMonths = [1, 2, 3].map(offset => (now.getMonth() + offset) % 12);
        const targetAvg = targetMonths.reduce((sum, m) => sum + byMonth[m], 0) / targetMonths.length;
        const seasonalityRatio = overallAvg > 0 ? targetAvg / overallAvg : 1;
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

    const projected = Math.max(0, movAvg3 + slope);
    const margin = Math.max(1, Math.round(Math.sqrt(Math.max(variance, projected))));
    const estimateLow = Math.max(0, Math.round(projected - margin));
    const estimateHigh = Math.round(projected + margin);

    const ratio = longRunRate > 0 ? recentRate / longRunRate : (recentRate > 0 ? 2 : 0);
    let riskTier;
    if (ratio < 0.85) riskTier = "lower";
    else if (ratio < 1.15) riskTier = "elevated";
    else if (ratio < 1.5) riskTier = "high";
    else riskTier = "veryhigh";

    const totalInWindow = counts.reduce((a, b) => a + b, 0);
    let confidence;
    if (usableYears.length >= 8 && totalInWindow >= 15 && dispersionRatio < 3) confidence = "High";
    else if (usableYears.length >= 4 && totalInWindow >= 6) confidence = "Moderate";
    else confidence = "Low";

    const trendLabel = slope > 0.15 ? "Increasing" : slope < -0.15 ? "Decreasing" : "Stable";

    return {
        country, periodLabel, riskTier, estimateLow, estimateHigh,
        baseline: Math.round(longRunRate * 10) / 10,
        trendLabel, seasonalityLabel, confidence, dispersionRatio, yoyChangePct,
        yearsOfData: usableYears.length, totalInWindow
    };
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

    fcOutput.innerHTML = `
        <div class="forecast-header">
            <span class="risk-badge risk-${result.riskTier}">${riskLabel}</span>
            <h3>NHIRA statistical forecast: ${riskLabel.toLowerCase()} expected incident activity</h3>
            <p class="forecast-subhead">${escapeHtml(result.country)} · ${result.periodLabel}</p>
        </div>

        <dl class="forecast-fields">
            <dt>Forecast period</dt><dd>${result.periodLabel}</dd>
            <dt>Expected incident level</dt><dd>${riskLabel}</dd>
            <dt>Estimated incident count</dt><dd>${result.estimateLow}–${result.estimateHigh}</dd>
            <dt>Baseline (long-run avg/year)</dt><dd>${result.baseline}</dd>
            <dt>Trend</dt><dd>${result.trendLabel}</dd>
            <dt>Seasonality</dt><dd>${result.seasonalityLabel}</dd>
            <dt>Confidence</dt><dd>${result.confidence}</dd>
        </dl>

        <p class="chart-title">Primary contributing factors</p>
        <ul class="forecast-factors">
            <li>Long-term incident trend (${result.trendLabel.toLowerCase()} over ${result.yearsOfData} year${result.yearsOfData === 1 ? "" : "s"} of data)</li>
            <li>Recent incident frequency${result.yoyChangePct === null ? "" : ` (${result.yoyChangePct > 0 ? "+" : ""}${result.yoyChangePct}% year-over-year)`}</li>
            <li>Seasonal pattern (${result.seasonalityLabel.toLowerCase()})</li>
            <li>Regional historical rate (${result.baseline} incidents/year long-run average)</li>
            <li>Population-adjusted rate — not available (no population dataset integrated yet)</li>
        </ul>

        <p class="forecast-disclaimer">
            This is a statistical risk category based on historical patterns in NHIRA's current dataset —
            not a prediction that an incident will occur.
        </p>

        <button id="fcMethodologyToggle" class="methodology-toggle" type="button" aria-expanded="false">
            How is this forecast calculated?
        </button>
        <div id="fcMethodologyBody" class="methodology-body" hidden>
            <dl>
                <dt>Model type</dt>
                <dd>V1 is a transparent descriptive-statistics model — long-run average, linear trend, recent-year rate, and month-of-year seasonality (when enough dated records exist) — with an uncertainty band derived from this country's own year-to-year variance in NHIRA. Every number here traces back to visible arithmetic on the current dataset.</dd>

                <dt>Not yet implemented</dt>
                <dd>Formal Poisson or negative-binomial regression, random forest, gradient boosting, and proper backtesting all require a fitted statistical/ML model and a validation harness — real modeling work best done server-side (e.g. Python with statsmodels or scikit-learn), not approximated in client-side JavaScript. This V1 is the "clean dataset → features" stage of that pipeline; "statistical model → backtesting" is the planned next step.</dd>

                <dt>Dispersion</dt>
                <dd>Variance-to-mean ratio for ${escapeHtml(result.country)}'s yearly counts: ${result.dispersionRatio}. A ratio noticeably above 1 indicates overdispersion, which is why negative-binomial (rather than plain Poisson) is the better candidate once real regression is built.</dd>

                <dt>Data used</dt>
                <dd>${result.yearsOfData} year${result.yearsOfData === 1 ? "" : "s"} of data, ${result.totalInWindow} incident${result.totalInWindow === 1 ? "" : "s"} in the window used for this forecast.</dd>

                <dt>Population-adjusted rate</dt>
                <dd>Not available. NHIRA does not yet store a population dataset — this is listed as a planned contributing factor, not a computed one.</dd>
            </dl>
        </div>
    `;

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

function renderForecastMapOverlay() {
    forecastLayer.clearLayers();
    const centroids = countryCentroids();
    Object.keys(centroids).forEach(country => {
        const result = computeForecast(country);
        if (!result) return;
        const c = centroids[country];
        L.circleMarker([c.lat, c.lng], {
            radius: 14,
            color: "#0E1116",
            weight: 1,
            fillColor: RISK_COLORS[result.riskTier],
            fillOpacity: 0.75
        })
            .bindTooltip(`NHIRA statistical forecast for ${country}: ${RISK_LABELS[result.riskTier]} expected incident activity`, { direction: "top" })
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

    fcMapToggle.addEventListener("change", () => {
        if (fcMapToggle.checked) {
            renderForecastMapOverlay();
            map.addLayer(forecastLayer);
        } else {
            map.removeLayer(forecastLayer);
        }
    });
} else {
    console.warn("Forecast controls not found in the DOM — skipping their setup so the rest of the app still loads.");
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
    if (window.innerWidth < 760) scrim.hidden = false;
    setTimeout(() => map.invalidateSize(), 300);
}

function closeSheet() {
    sidePanel.classList.remove("open");
    sidePanel.setAttribute("aria-hidden", "true");
    if (RESEARCH_ELEMENTS_PRESENT && window.innerWidth < DUAL_PANEL_MIN_WIDTH) closeStatsPanel();
    if (FORECAST_ELEMENTS_PRESENT && window.innerWidth < DUAL_PANEL_MIN_WIDTH) closeForecastPanel();
    scrim.hidden = true;
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
        .map(e => ({ event: e, yearDiff: Math.abs(e.year - event.year) }))
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
        ? surrounding.map(({ event: e, yearDiff }) =>
            contextListItem(e, `${yearDiff} year${yearDiff === 1 ? "" : "s"} apart · ${locationText(e)}`)
          ).join("")
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

function openPanel(event) {
    const type = INCIDENT_TYPES[event.resolvedType] || INCIDENT_TYPES.other;
    const projected = event.year > THIS_YEAR;

    const place = [event.city, event.state, event.country]
        .filter(Boolean)
        .map(escapeHtml)
        .join(", ");

    const sourcesHtml = Array.isArray(event.sources) && event.sources.length
        ? event.sources
              .map(s => `<a href="${escapeHtml(s)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s)}</a>`)
              .join("<br>")
        : "No sources on file";

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

        <div class="stats">
            ${statBlock(event.fatalities, event.fatalitiesEstimateRange, "Fatalities")}
            ${statBlock(event.injuries, event.injuriesEstimateRange, "Injuries")}
        </div>

        <p>${escapeHtml(event.description)}</p>

        <hr>

        <p class="field"><b>Venue</b><br>${escapeHtml(event.venue) || "Not recorded"}</p>
        <p class="field"><b>Sources</b><br>${sourcesHtml}</p>

        <div class="dq-section">
            <p class="chart-title">Data quality</p>
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
