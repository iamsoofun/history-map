// ---------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------

const map = L.map("map").setView([20, 0], 2);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

// ---------------------------------------------------------------------
// Element references
// ---------------------------------------------------------------------

const slider = document.getElementById("timeline");
const yearDisplay = document.getElementById("yearDisplay");
const search = document.getElementById("search");
const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const sidePanel = document.getElementById("sidePanel");
const panelContent = document.getElementById("panelContent");
const closePanel = document.getElementById("closePanel");

const MIN_YEAR = Number(slider.min);
const MAX_YEAR = Number(slider.max);
const PLAY_STEP_MS = 200; // how often the year advances while playing
const PLAY_STEP_YEARS = 1; // how many years advance per tick

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

let events = [];
let markers = [];
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
        events = data;
        applyFilters();
    })
    .catch(error => {
        console.error(error);
        panelContent.innerHTML = `<p>Could not load incident data. Please try again later.</p>`;
    });

// ---------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------

function addMarker(event) {
    const marker = L.marker([event.lat, event.lng])
        .addTo(map)
        .on("click", () => openPanel(event));

    markers.push(marker);
    return marker;
}

function clearMarkers() {
    markers.forEach(marker => map.removeLayer(marker));
    markers = [];
}

// ---------------------------------------------------------------------
// Combined year + search filtering
// ---------------------------------------------------------------------

function getMatchedEvents() {
    const year = Number(slider.value);
    const text = search.value.trim().toLowerCase();

    return events.filter(event => {
        const withinYear = event.year <= year;

        const matchesText =
            !text ||
            event.title.toLowerCase().includes(text) ||
            event.city.toLowerCase().includes(text) ||
            event.state.toLowerCase().includes(text) ||
            event.country.toLowerCase().includes(text);

        return withinYear && matchesText;
    });
}

function applyFilters() {
    const year = Number(slider.value);
    const text = search.value.trim().toLowerCase();

    yearDisplay.textContent = "Year: " + year;

    clearMarkers();

    const matchedEvents = getMatchedEvents();
    matchedEvents.forEach(addMarker);

    if (text && matchedEvents.length > 0) {
        const firstEvent = matchedEvents[0];
        map.setView([firstEvent.lat, firstEvent.lng], 8);
        openPanel(firstEvent);
    }
}

const debouncedApplyFilters = debounce(applyFilters, 150);

slider.addEventListener("input", () => {
    yearDisplay.textContent = "Year: " + slider.value; // instant feedback while dragging
    debouncedApplyFilters();
});

search.addEventListener("input", debounce(applyFilters, 250));

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
    if (playTimer) return; // already playing

    // If already at the end, restart from the beginning
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

// If the user manually drags the slider, treat it as a pause
slider.addEventListener("pointerdown", stopPlayback);

// Start with Pause disabled since nothing is playing yet
pauseBtn.disabled = true;

// ---------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------

function openPanel(event) {
    const sourcesHtml = event.sources
        ? event.sources
              .map(s => `<a href="${escapeHtml(s)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s)}</a>`)
              .join("<br>")
        : "No sources available";

    panelContent.innerHTML = `
        <h2>${escapeHtml(event.title)}</h2>
        <div class="meta">${escapeHtml(event.city)}, ${escapeHtml(event.state)}, ${escapeHtml(event.country)} &middot; ${escapeHtml(event.date)}</div>

        <div class="stat"><b>${escapeHtml(event.fatalities)}</b> Fatalities</div>
        <div class="stat"><b>${escapeHtml(event.injuries)}</b> Injuries</div>

        <hr>

        <p>${escapeHtml(event.description)}</p>

        <hr>

        <b>🏢 Venue:</b> ${escapeHtml(event.venue)}<br><br>
        <b>🔗 Sources:</b><br>
        ${sourcesHtml}
    `;

    sidePanel.classList.add("open");
}

closePanel.addEventListener("click", () => {
    sidePanel.classList.remove("open");

});