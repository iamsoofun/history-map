// =====================================================================
// NHIRA — script.js
// Loads incidents from history.json, draws typed markers, drives the
// timeline, and fills the detail panel.
// =====================================================================

// ---------------------------------------------------------------------
// Type registry — markers, legend, and severity rings all read from here
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

// A hot zone ring is drawn around any incident at or above this fatality count.
const HOTZONE_THRESHOLD = 25;
const HOTZONE_COLOR = "#7A3E9D";

// ---------------------------------------------------------------------
// Country → region lookup, used by the Research & Statistics "Region"
// filter. Anything not listed here falls back to "Other".
// ---------------------------------------------------------------------

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

const markerLayer = L.layerGroup().addTo(map);

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

// Date-range research panel
const startYearInput = document.getElementById("startYear");
const endYearInput = document.getElementById("endYear");
const rangeSearchBtn = document.getElementById("rangeSearchBtn");
const clearRangeBtn = document.getElementById("clearRangeBtn");
const rangeResults = document.getElementById("rangeResults");

// Research & Statistics panel
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
const rsBreakdown = document.getElementById("rsBreakdown");
const rsResultsList = document.getElementById("rsResultsList");
const rsTopFatalities = document.getElementById("rsTopFatalities");
const rsTopCountries = document.getElementById("rsTopCountries");
const rsConcentration = document.getElementById("rsConcentration");
const ANALYSIS_CANVAS_IDS = [
    "chartIncidentsByDecade", "chartIncidentsByCountry", "chartIncidentsByRegion",
    "chartFatalitiesByDecade", "chartInjuriesByDecade",
    "chartFrequencyTrend", "chartFatalityTrend", "chartCategoryTrend"
];
const analysisCanvases = {};
ANALYSIS_CANVAS_IDS.forEach(id => { analysisCanvases[id] = document.getElementById(id); });
const analysisCharts = {}; // holds live Chart.js instances so they can be destroyed/redrawn

const MIN_YEAR = Number(slider.min);
const MAX_YEAR = Number(slider.max);
const THIS_YEAR = new Date().getFullYear();
const PLAY_STEP_MS = 200;
const PLAY_STEP_YEARS = 1;

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

let events = [];
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

// ---------------------------------------------------------------------
// Type resolution
//
// Preferred: add "type": "shooting" to each record in history.json.
// Until then, this guesses from the text so the legend still means something.
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

    const haystack = [event.title, event.description, event.venue]
        .filter(Boolean)
        .join(" ");

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
        if (!response.ok) {
            throw new Error(`Failed to load history.json: ${response.status}`);
        }
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
            console.warn(
                `${outOfRange.length} incident(s) fall outside ${MIN_YEAR}-${MAX_YEAR} and will never appear:`,
                outOfRange.map(e => `${e.year} ${e.title}`)
            );
        }

        const badCoords = events.filter(e => !Number.isFinite(e.lat) || !Number.isFinite(e.lng));
        if (badCoords.length) {
            console.warn("Incident(s) missing usable coordinates:", badCoords.map(e => e.title));
            events = events.filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lng));
        }

        applyFilters();
        populateResearchFilters();
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

    // Hot zone ring for high-casualty incidents
    if (event.fatalityCount >= HOTZONE_THRESHOLD) {
        const radius = Math.min(600000, 40000 + event.fatalityCount * 3000);
        L.circle([event.lat, event.lng], {
            radius,
            color: HOTZONE_COLOR,
            weight: 1,
            dashArray: projected ? "5,5" : null,
            fillColor: HOTZONE_COLOR,
            fillOpacity: projected ? 0.04 : 0.12,
            interactive: false
        }).addTo(markerLayer);
    }

    // Marker scales gently with fatalities so severity reads at a glance
    const radius = 6 + Math.min(8, Math.sqrt(event.fatalityCount));

    L.circleMarker([event.lat, event.lng], {
        radius,
        color: projected ? type.color : "#0E1116",
        weight: 2,
        dashArray: projected ? "3,3" : null,
        fillColor: type.color,
        fillOpacity: projected ? 0 : 0.85
    })
        .addTo(markerLayer)
        .bindTooltip(`${event.title} (${event.year})`, { direction: "top" })
        .on("click", e => {
            L.DomEvent.stop(e);
            openPanel(event);
        });
}

function clearMarkers() {
    markerLayer.clearLayers();
}

// ---------------------------------------------------------------------
// Combined range + search filtering
//
// If startYear/endYear are left blank or invalid, this falls back to the
// old cumulative behavior: everything from MIN_YEAR up through whatever
// year the timeline slider is sitting on.
// ---------------------------------------------------------------------

function getMatchedEvents() {
    const sliderYear = Number(slider.value);
    const text = search.value.trim().toLowerCase();

    let startYear = Number(startYearInput?.value);
    let endYear = Number(endYearInput?.value);

    // If no valid range is entered, use the timeline
    if (!Number.isFinite(startYear)) {
        startYear = MIN_YEAR;
    }

    if (!Number.isFinite(endYear)) {
        endYear = sliderYear;
    }

    // Prevent reversed ranges
    if (startYear > endYear) {
        [startYear, endYear] = [endYear, startYear];
    }

    return events.filter(event => {

        // Event must fall inside selected historical range
        const withinRange =
            event.year >= startYear &&
            event.year <= endYear;

        // Text search across the full record
        const matchesText =
            !text ||
            [
                event.title,
                event.city,
                event.state,
                event.country,
                event.venue,
                event.description,
                event.year,
                event.resolvedType,
                INCIDENT_TYPES[event.resolvedType]?.label
            ]
                .filter(Boolean)
                .some(field =>
                    String(field).toLowerCase().includes(text)
                );

        return withinRange && matchesText;
    });
}

function updateYearReadout(year) {
    yearDisplay.textContent = year;
    const projected = Number(year) > THIS_YEAR;
    eraTag.textContent = projected ? "projected" : "recorded";
    eraTag.classList.toggle("is-projected", projected);
}

// Scores how well an event matches the search text, so the map zooms to
// the most relevant hit instead of just whichever record is first in
// history.json.
function scoreMatch(event, text) {
    const title = String(event.title || "").toLowerCase();

    if (title === text) return 3;
    if (title.startsWith(text)) return 2;
    if (title.includes(text)) return 1;
    return 0; // matched on city/state/country/venue/description/type instead
}

function applyFilters() {
    const year = Number(slider.value);

    updateYearReadout(year);
    clearMarkers();

    const matchedEvents = getMatchedEvents();
    matchedEvents.forEach(addMarker);

    const text = search.value.trim().toLowerCase();
    if (text && matchedEvents.length > 0) {
        const bestMatch = [...matchedEvents].sort(
            (a, b) => scoreMatch(b, text) - scoreMatch(a, text)
        )[0];

        map.setView([bestMatch.lat, bestMatch.lng], 8);
        openPanel(bestMatch);
    } else if (text && matchedEvents.length === 0) {
        // Nothing matched — don't leave a stale record from a previous
        // search sitting in the panel.
        panelContent.innerHTML = `<h2>No incidents found</h2><p>No recorded incidents match "${escapeHtml(search.value.trim())}".</p>`;
        openSheet();
    }
}

const debouncedApplyFilters = debounce(applyFilters, 150);

slider.addEventListener("input", () => {
    updateYearReadout(slider.value); // instant feedback while dragging
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

    // Move the timeline to the end of the research period
    slider.value = Math.min(
        Math.max(endYear, MIN_YEAR),
        MAX_YEAR
    );

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

    // If we found something, zoom to the first result
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
            if (event.key === "Enter") {
                runRangeResearch();
            }
        });
    });
} else {
    console.warn("Date-range research controls not found in the DOM — skipping their setup so the rest of the app still loads.");
}

// ---------------------------------------------------------------------
// Research & Statistics panel
//
// Independent from the map search/filter above — this is a dedicated
// query tool that computes live aggregate stats (and a matching results
// list) from whatever's currently in `events`, so it automatically
// reflects new data added to history.json.
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
        Object.entries(INCIDENT_TYPES)
            .map(([key, t]) => `<option value="${key}">${escapeHtml(t.label)}</option>`)
            .join("");
}

function getResearchMatches() {
    let startYear = Number(rsStartYear.value);
    let endYear = Number(rsEndYear.value);
    if (!Number.isFinite(startYear)) startYear = MIN_YEAR;
    if (!Number.isFinite(endYear)) endYear = MAX_YEAR;
    if (startYear > endYear) [startYear, endYear] = [endYear, startYear];

    const country = rsCountry.value;
    const category = rsCategory.value;
    const region = rsRegion.value;
    const minFatalities = Number(rsMinFatalities.value) || 0;

    return events.filter(event => {
        if (event.year < startYear || event.year > endYear) return false;
        if (country && event.country !== country) return false;
        if (category && event.resolvedType !== category) return false;
        if (region && getRegion(event.country) !== region) return false;
        if (event.fatalityCount < minFatalities) return false;
        return true;
    });
}

// ---------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------

function decadeOf(year) {
    return Math.floor(year / 10) * 10;
}

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

function topEntries(obj, n) {
    return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function sortedDecadeLabels(obj) {
    return Object.keys(obj).map(Number).sort((a, b) => a - b).map(String);
}

// Renders (or re-renders) a Chart.js chart into the given canvas,
// destroying any previous instance on that canvas first.
function drawChart(canvasId, config) {
    const canvas = analysisCanvases[canvasId];
    if (!canvas || typeof Chart === "undefined") return;

    if (analysisCharts[canvasId]) {
        analysisCharts[canvasId].destroy();
    }
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
    if (typeof Chart === "undefined") return; // Chart.js failed to load — skip charts, rest of the panel still works

    // --- Incidents by decade ---
    const byDecade = countBy(matches, e => decadeOf(e.year));
    const decadeLabels = sortedDecadeLabels(byDecade);
    drawChart("chartIncidentsByDecade", {
        type: "bar",
        data: {
            labels: decadeLabels,
            datasets: [{ data: decadeLabels.map(d => byDecade[d]), backgroundColor: "#256B9A" }]
        },
        options: CHART_BASE_OPTIONS
    });

    // --- Incidents by country (top 10) ---
    const byCountry = topEntries(countBy(matches, e => e.country), 10);
    drawChart("chartIncidentsByCountry", {
        type: "bar",
        data: {
            labels: byCountry.map(([c]) => c),
            datasets: [{ data: byCountry.map(([, v]) => v), backgroundColor: "#B3322B" }]
        },
        options: { ...CHART_BASE_OPTIONS, indexAxis: "y" }
    });

    // --- Incidents by region ---
    const byRegion = countBy(matches, e => getRegion(e.country));
    const regionLabels = Object.keys(byRegion).sort();
    drawChart("chartIncidentsByRegion", {
        type: "bar",
        data: {
            labels: regionLabels,
            datasets: [{ data: regionLabels.map(r => byRegion[r]), backgroundColor: "#7A3E9D" }]
        },
        options: CHART_BASE_OPTIONS
    });

    // --- Fatalities / injuries by decade ---
    const fatByDecade = sumBy(matches, e => decadeOf(e.year), e => e.fatalityCount);
    const injByDecade = sumBy(matches, e => decadeOf(e.year), e => toNumber(e.injuries));
    const fatDecadeLabels = sortedDecadeLabels(fatByDecade);
    const injDecadeLabels = sortedDecadeLabels(injByDecade);

    drawChart("chartFatalitiesByDecade", {
        type: "bar",
        data: {
            labels: fatDecadeLabels,
            datasets: [{ data: fatDecadeLabels.map(d => fatByDecade[d]), backgroundColor: "#D97A17" }]
        },
        options: CHART_BASE_OPTIONS
    });

    drawChart("chartInjuriesByDecade", {
        type: "bar",
        data: {
            labels: injDecadeLabels,
            datasets: [{ data: injDecadeLabels.map(d => injByDecade[d]), backgroundColor: "#2E7D5B" }]
        },
        options: CHART_BASE_OPTIONS
    });

    // --- Trend: incident frequency + fatalities over time (line) ---
    drawChart("chartFrequencyTrend", {
        type: "line",
        data: {
            labels: decadeLabels,
            datasets: [{
                data: decadeLabels.map(d => byDecade[d]),
                borderColor: "#256B9A",
                backgroundColor: "rgba(37,107,154,.15)",
                tension: .3,
                fill: true
            }]
        },
        options: CHART_BASE_OPTIONS
    });

    drawChart("chartFatalityTrend", {
        type: "line",
        data: {
            labels: fatDecadeLabels,
            datasets: [{
                data: fatDecadeLabels.map(d => fatByDecade[d]),
                borderColor: "#B3322B",
                backgroundColor: "rgba(179,50,43,.15)",
                tension: .3,
                fill: true
            }]
        },
        options: CHART_BASE_OPTIONS
    });

    // --- Category mix by decade (stacked bar) ---
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

    // --- Highest-fatality incidents ---
    const topFatalities = [...matches].sort((a, b) => b.fatalityCount - a.fatalityCount).slice(0, 8);
    rsTopFatalities.innerHTML = topFatalities.length
        ? topFatalities.map(e => `
            <li>
                ${escapeHtml(e.title)}
                <div class="rank-meta">${escapeHtml(e.year)} · ${escapeHtml(e.country)} · ${e.fatalityCount.toLocaleString()} fatalities</div>
            </li>
        `).join("")
        : "<li>No incidents match these filters.</li>";

    // --- Countries with the most incidents ---
    const topCountries = topEntries(countBy(matches, e => e.country), 8);
    rsTopCountries.innerHTML = topCountries.length
        ? topCountries.map(([country, count]) => `
            <li>${escapeHtml(country)} <div class="rank-meta">${count.toLocaleString()} incident${count === 1 ? "" : "s"}</div></li>
        `).join("")
        : "<li>No incidents match these filters.</li>";

    // --- Geographic concentration ---
    const allCountryEntries = topEntries(countBy(matches, e => e.country), 5);
    const top5Total = allCountryEntries.reduce((sum, [, v]) => sum + v, 0);
    const share = matches.length ? Math.round((top5Total / matches.length) * 100) : 0;
    rsConcentration.textContent = matches.length
        ? `The top ${allCountryEntries.length} countr${allCountryEntries.length === 1 ? "y accounts" : "ies account"} for ${share}% of all matched incidents (${allCountryEntries.map(([c]) => c).join(", ")}).`
        : "No incidents match these filters.";
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

    const counts = {};
    matches.forEach(e => {
        counts[e.resolvedType] = (counts[e.resolvedType] || 0) + 1;
    });

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

    rsBreakdown.innerHTML = breakdownRows.length
        ? breakdownRows.join("")
        : "<li>No incidents match these filters.</li>";

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
    sidePanel.classList.remove("open"); // only one bottom sheet at a time on mobile
    if (window.innerWidth < 760) scrim.hidden = false;
    runResearch();
}

function closeStatsPanel() {
    statsPanel.classList.remove("open");
    statsPanel.setAttribute("aria-hidden", "true");
    statsToggle.setAttribute("aria-expanded", "false");
    scrim.hidden = true;
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
    rsGenerateBtn.addEventListener("click", runResearch);

    // Interactive filters: any change re-runs the analysis automatically.
    const debouncedRunResearch = debounce(runResearch, 200);
    [rsStartYear, rsEndYear, rsMinFatalities].forEach(input => {
        input.addEventListener("input", debouncedRunResearch);
    });
    [rsCountry, rsCategory, rsRegion].forEach(select => {
        select.addEventListener("change", runResearch);
    });

    rsClearBtn.addEventListener("click", () => {
        rsStartYear.value = MIN_YEAR;
        rsEndYear.value = MAX_YEAR;
        rsCountry.value = "";
        rsCategory.value = "";
        rsRegion.value = "";
        rsMinFatalities.value = 0;
        runResearch();
    });
} else {
    console.warn("Research & Statistics controls not found in the DOM — skipping their setup so the rest of the app still loads.");
}// ---------------------------------------------------------------------
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

    if (Number(slider.value) >= MAX_YEAR) {
        slider.value = MIN_YEAR;
    }

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
    if (RESEARCH_ELEMENTS_PRESENT) closeStatsPanel();
    if (window.innerWidth < 760) scrim.hidden = false;

    setTimeout(() => map.invalidateSize(), 300);
}

function closeSheet() {
    sidePanel.classList.remove("open");
    sidePanel.setAttribute("aria-hidden", "true");
    if (RESEARCH_ELEMENTS_PRESENT) closeStatsPanel();
    scrim.hidden = true;
    setTimeout(() => map.invalidateSize(), 300);
}

// ---------------------------------------------------------------------
// Research Context
//
// Computes how a given incident relates to others already in the
// dataset: geographic proximity, chronological proximity, and — for the
// same country — what happened in the years afterward. This needs no
// new data; it's derived from lat/lng and year on existing records.
// "Who was involved" and "What changed afterward" (narrative) are
// optional fields you can add per record when you have that research.
// ---------------------------------------------------------------------

const NEARBY_RADIUS_KM = 750;
const SAME_TIME_WINDOW_YEARS = 5;
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

function buildResearchContext(event) {
    const others = events.filter(e => e.id !== event.id);

    const nearby = others
        .map(e => ({ event: e, distanceKm: haversineKm(event.lat, event.lng, e.lat, e.lng) }))
        .filter(x => x.distanceKm <= NEARBY_RADIUS_KM)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, CONTEXT_LIST_LIMIT);

    const sameTime = others
        .map(e => ({ event: e, yearDiff: Math.abs(e.year - event.year) }))
        .filter(x => x.yearDiff <= SAME_TIME_WINDOW_YEARS)
        .sort((a, b) => a.yearDiff - b.yearDiff)
        .slice(0, CONTEXT_LIST_LIMIT);

    const subsequent = others
        .filter(e =>
            e.country && event.country && e.country === event.country &&
            e.year > event.year && e.year <= event.year + SUBSEQUENT_WINDOW_YEARS
        )
        .sort((a, b) => a.year - b.year)
        .slice(0, CONTEXT_LIST_LIMIT);

    return { nearby, sameTime, subsequent };
}

function contextListItem(e, metaText) {
    return `
        <li class="rc-item" data-goto-id="${e.id}" tabindex="0" role="button">
            <span class="rc-item-title">${escapeHtml(e.title)}</span>
            <span class="rc-item-meta">${metaText}</span>
        </li>
    `;
}

function renderResearchContext(event) {
    const { nearby, sameTime, subsequent } = buildResearchContext(event);

    const nearbyHtml = nearby.length
        ? nearby.map(({ event: e, distanceKm }) =>
            contextListItem(e, `${Math.round(distanceKm).toLocaleString()} km · ${escapeHtml(e.year)}`)
          ).join("")
        : `<li class="rc-empty">No recorded incidents within ${NEARBY_RADIUS_KM.toLocaleString()} km.</li>`;

    const sameTimeHtml = sameTime.length
        ? sameTime.map(({ event: e, yearDiff }) =>
            contextListItem(e, `${escapeHtml(e.year)} · ${escapeHtml([e.city, e.country].filter(Boolean).join(", "))}`)
          ).join("")
        : `<li class="rc-empty">No recorded incidents within ${SAME_TIME_WINDOW_YEARS} years.</li>`;

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
        ? subsequent.map(e =>
            contextListItem(e, `${escapeHtml(e.year)} · ${escapeHtml(e.country)}`)
          ).join("")
        : `<li class="rc-empty">No recorded incidents in ${escapeHtml(event.country || "this country")} in the following ${SUBSEQUENT_WINDOW_YEARS} years.</li>`;

    return `
        <h3 class="analysis-heading rc-heading">Research Context</h3>

        <div class="rc-section">
            <p class="chart-title">What was happening nearby?</p>
            <ul class="rc-list">${nearbyHtml}</ul>
        </div>

        <div class="rc-section">
            <p class="chart-title">What was happening at the same time?</p>
            <ul class="rc-list">${sameTimeHtml}</ul>
        </div>

        <div class="rc-section">
            <p class="chart-title">Who was involved?</p>
            ${involvedHtml}
        </div>

        <div class="rc-section">
            <p class="chart-title">What changed afterward?</p>
            ${consequencesText ? `<p class="rc-consequences">${consequencesText}</p>` : `<p class="rc-empty-text">Consequences not yet documented.</p>`}
            <ul class="rc-list">${subsequentHtml}</ul>
        </div>
    `;
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

    // Optional per-record fields — only rendered when present, so records
    // without this data still display exactly as before.
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

        ${renderResearchContext(event)}
    `;

    openSheet();
}

// Clicking any Research Context item jumps to that incident's own panel —
// one listener handles it for every render since panelContent is rebuilt
// each time.
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