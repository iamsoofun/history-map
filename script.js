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
    const open = !legend.classList.toggle("collapsed");
    legendToggle.setAttribute("aria-expanded", String(open));
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

function applyFilters() {
    const year = Number(slider.value);

    updateYearReadout(year);
    clearMarkers();

    const matchedEvents = getMatchedEvents();
    matchedEvents.forEach(addMarker);

    const text = search.value.trim().toLowerCase();
    if (text && matchedEvents.length > 0) {
        const firstEvent = matchedEvents[0];
        map.setView([firstEvent.lat, firstEvent.lng], 8);
        openPanel(firstEvent);
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

// ---------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------

function openSheet() {
    sidePanel.classList.add("open");
    sidePanel.setAttribute("aria-hidden", "false");
    if (window.innerWidth < 760) scrim.hidden = false;

    // Force a solid, readable panel regardless of what the stylesheet says —
    // stopgap until the CSS itself is fixed.
    sidePanel.style.background = "#FFFFFF";
    sidePanel.style.color = "#0E1116";
    sidePanel.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.35)";
    sidePanel.style.zIndex = "1000";

    setTimeout(() => map.invalidateSize(), 300);
}

function closeSheet() {
    sidePanel.classList.remove("open");
    sidePanel.setAttribute("aria-hidden", "true");
    scrim.hidden = true;
    setTimeout(() => map.invalidateSize(), 300);
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

    panelContent.innerHTML = `
        <span class="tag" style="--tag:${type.color}">${escapeHtml(type.label)}${projected ? " &middot; projected" : ""}</span>

        <h2>${escapeHtml(event.title)}</h2>
        <p class="meta">${place} &middot; ${escapeHtml(event.date || event.year)}</p>

        <div class="stats">
            <div class="stat"><b>${escapeHtml(event.fatalities ?? "—")}</b><span>Fatalities</span></div>
            <div class="stat"><b>${escapeHtml(event.injuries ?? "—")}</b><span>Injuries</span></div>
        </div>

        <p>${escapeHtml(event.description)}</p>

        <hr>

        <p class="field"><b>Venue</b><br>${escapeHtml(event.venue) || "Not recorded"}</p>
        <p class="field"><b>Sources</b><br>${sourcesHtml}</p>
    `;

    openSheet();
}

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