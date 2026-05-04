let map;
let markersGroup;
let tempMarker = null;
let pendingLocation = null;

// RAM Cache for Map Routes (prevents spamming the API and saves local storage space)
window.routeCache = window.routeCache || {};

// Load Data and Run Data Migration for existing trips
let trips = JSON.parse(localStorage.getItem('travelPlannerTrips')) || [];
trips.forEach(t => {
    if(t.days) {
        t.days.forEach(d => {
            if (!d.startTime) d.startTime = '09:00'; // Default start time
            if(d.locations) {
                d.locations.forEach(l => {
                    if (l.stayMins === undefined) l.stayMins = 60; // Default stay time
                    if (l.time !== undefined) {
                        l.fixedTime = l.time; // Migrate old manual times to the new "Lock Time"
                        delete l.time;
                    }
                });
            }
        });
    }
});

let currentTripId = null;
let currentDayIndex = 0;
let editingTripId = null;

// Wait for the HTML to fully load before attaching events
document.addEventListener('DOMContentLoaded', () => {
    renderDashboard();
    initMap();
    setupAutocomplete('sidebar-input', 'sidebar-autocomplete', handleSidebarSelect);
    setupAutocomplete('map-search-input', 'map-autocomplete', handleMapSearchSelect);

    // FIX: Safely attach the Enter Key overrides only after the HTML exists
    const sidebarInput = document.getElementById('sidebar-input');
    if (sidebarInput) {
        sidebarInput.addEventListener('keypress', e => { 
            if (e.key === 'Enter') { 
                document.getElementById('sidebar-autocomplete').style.display = 'none'; 
                quickAddLocation(); 
            }
        });
    }

    const mapSearchInput = document.getElementById('map-search-input');
    if (mapSearchInput) {
        mapSearchInput.addEventListener('keypress', e => { 
            if (e.key === 'Enter') { 
                document.getElementById('map-autocomplete').style.display = 'none'; 
                searchMapOnly(); 
            }
        });
    }
});

function saveData() { localStorage.setItem('travelPlannerTrips', JSON.stringify(trips)); }

// --- DASHBOARD FUNCTIONS ---
function openDashboard() {
    document.getElementById('planner-view').classList.remove('active');
    document.getElementById('dashboard-view').classList.add('active');
    currentTripId = null; 
    renderDashboard();
}

function openPlanner(id) {
    document.getElementById('dashboard-view').classList.remove('active');
    document.getElementById('planner-view').classList.add('active');
    setTimeout(() => { map.invalidateSize(); }, 100); 
    selectTrip(id);
}

function renderDashboard() {
    const grid = document.getElementById('trip-grid');
    const emptyState = document.getElementById('empty-state');
    const sortSelect = document.getElementById('sort-select');
    const sortMethod = sortSelect ? sortSelect.value : 'created-desc';
    
    grid.innerHTML = '';

    if (trips.length === 0) {
        grid.style.display = 'none';
        emptyState.style.display = 'block';
        return;
    }

    grid.style.display = 'grid';
    emptyState.style.display = 'none';

    let sortedTrips = [...trips].sort((a, b) => {
        let aCreate = a.createdAt || parseInt(a.id);
        let bCreate = b.createdAt || parseInt(b.id);
        let aStart = new Date(a.startDate || 0).getTime();
        let bStart = new Date(b.startDate || 0).getTime();
        switch(sortMethod) {
            case 'created-desc': return bCreate - aCreate;
            case 'created-asc': return aCreate - bCreate;
            case 'date-asc': return aStart - bStart;
            case 'date-desc': return bStart - aStart;
            default: return bCreate - aCreate;
        }
    });

    sortedTrips.forEach(trip => {
        let totalLocations = trip.days.reduce((sum, day) => sum + day.locations.length, 0);
        let startStr = trip.startDate ? new Date(trip.startDate).toLocaleDateString() : 'N/A';
        let endStr = trip.endDate ? new Date(trip.endDate).toLocaleDateString() : 'N/A';

        const card = document.createElement('div');
        card.className = 'trip-card';
        card.setAttribute('onclick', `openPlanner('${trip.id}')`);

        card.innerHTML = `
            <h3>${trip.name}</h3>
            <p>🗓️ <b>${startStr}</b> to <b>${endStr}</b></p>
            <p>🕒 ${trip.days.length} Days</p>
            <div class="meta">📍 ${totalLocations} planned locations</div>
            <div class="card-actions">
                <button onclick="event.stopPropagation(); openPlanner('${trip.id}')" style="flex: 1;">Open Planner</button>
                <button class="edit-btn" onclick="event.stopPropagation(); openModal('${trip.id}')" style="flex: 1;">Edit</button>
                <button class="danger" onclick="event.stopPropagation(); deleteTrip('${trip.id}')" style="flex: 1;">Delete</button>
            </div>
        `;
        grid.appendChild(card);
    });
}

function openModal(tripId = null) { 
    editingTripId = tripId;
    const title = document.getElementById('modal-title');
    if (tripId) {
        title.innerText = "Edit Trip";
        const tripToEdit = trips.find(t => t.id === tripId);
        document.getElementById('trip-name').value = tripToEdit.name;
        document.getElementById('trip-start').value = tripToEdit.startDate;
        document.getElementById('trip-end').value = tripToEdit.endDate;
    } else {
        title.innerText = "Plan a New Trip";
        document.getElementById('trip-name').value = '';
        document.getElementById('trip-start').value = '';
        document.getElementById('trip-end').value = '';
    }
    document.getElementById('trip-modal').style.display = 'flex'; 
}

function closeModal() { document.getElementById('trip-modal').style.display = 'none'; editingTripId = null; }

function saveTrip() {
    const name = document.getElementById('trip-name').value;
    const start = document.getElementById('trip-start').value;
    const end = document.getElementById('trip-end').value;
    if (!name || !start || !end) return alert("Please fill out all fields.");

    let startDate = new Date(start); let endDate = new Date(end);
    startDate.setMinutes(startDate.getMinutes() + startDate.getTimezoneOffset());
    endDate.setMinutes(endDate.getMinutes() + endDate.getTimezoneOffset());
    if (startDate > endDate) return alert("Start date must be before end date.");

    let days = []; let currentDate = new Date(startDate); let dayNum = 1;
    while (currentDate <= endDate) {
        days.push({ 
            title: `Day ${dayNum} - ${currentDate.toLocaleDateString()}`, 
            startTime: '09:00', // Initialize day with 9AM start
            locations: [] 
        });
        currentDate.setDate(currentDate.getDate() + 1); dayNum++;
    }

    if (editingTripId) {
        const tripIndex = trips.findIndex(t => t.id === editingTripId);
        const oldDays = trips[tripIndex].days;
        days.forEach((newDay, index) => { 
            if (oldDays[index]) {
                newDay.locations = oldDays[index].locations; 
                newDay.startTime = oldDays[index].startTime || '09:00';
            }
        });
        trips[tripIndex].name = name; trips[tripIndex].startDate = start; trips[tripIndex].endDate = end; trips[tripIndex].days = days;
    } else {
        trips.push({ id: Date.now().toString(), name, startDate: start, endDate: end, createdAt: Date.now(), days });
    }
    saveData(); closeModal(); renderDashboard();
}

function deleteTrip(id) {
    if (confirm("Are you sure you want to delete this trip?")) {
        trips = trips.filter(t => t.id !== id);
        saveData(); renderDashboard();
    }
}

function selectTrip(id) {
    currentTripId = id;
    const trip = trips.find(t => t.id === id);
    if(!trip) return;
    document.getElementById('display-trip-name').innerText = trip.name;
    const daySelector = document.getElementById('day-selector');
    daySelector.innerHTML = '';
    trip.days.forEach((day, index) => {
        const option = document.createElement('option');
        option.value = index; option.textContent = day.title; daySelector.appendChild(option);
    });
    currentDayIndex = 0; daySelector.value = 0; renderDay();
}

function changeDay() { currentDayIndex = parseInt(document.getElementById('day-selector').value); renderDay(); }

// --- TIME MATH ENGINE ---
function parseTimeToMins(timeStr) {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return (h * 60) + m;
}

function minsToTime(mins) {
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

// Loops through the day and automatically calculates all arrival/departure times
function calculateCascadingTimes() {
    if (!currentTripId) return; // FIX: Safety check
    const trip = trips.find(t => t.id === currentTripId);
    if (!trip || !trip.days[currentDayIndex]) return; // FIX: Safety check
    
    const day = trip.days[currentDayIndex];
    
    // Set input to match state
    const dayStartInput = document.getElementById('day-start-input');
    if (dayStartInput) dayStartInput.value = day.startTime || '09:00';
    
    let currentMins = parseTimeToMins(day.startTime || '09:00');

    day.locations.forEach((loc, index) => {
        // If user locked a time, override the cascade and start from here
        if (loc.fixedTime) currentMins = parseTimeToMins(loc.fixedTime);
        
        loc.calculatedArrival = minsToTime(currentMins);
        
        // Add the duration spent at the location
        currentMins += parseInt(loc.stayMins || 0);
        loc.calculatedDeparture = minsToTime(currentMins);

        // Add travel time to get to the NEXT location
        if (index < day.locations.length - 1) {
            let travelMins = 0;
            if (loc.travelMode === 'custom') {
                travelMins = parseInt(loc.customMins || 0);
            } else if (loc.travelMinsToNext) {
                travelMins = loc.travelMinsToNext;
            }
            currentMins += travelMins;
        }
    });
}


// --- MAP & AUTOCOMPLETE LOGIC ---
function initMap() {
    const mapElement = document.getElementById('map');
    if (!mapElement) return; // Prevent crashes if HTML is missing

    map = L.map('map').setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
    markersGroup = L.layerGroup().addTo(map);

    map.on('click', async function(e) {
        if (!currentTripId) return;
        const loadingPopup = L.popup().setLatLng(e.latlng).setContent("Identifying location...").openOn(map);
        const locationData = await reverseGeocode(e.latlng.lat, e.latlng.lng);
        map.closePopup(loadingPopup);
        saveLocationToSchedule(locationData);
    });
}

function debounce(func, wait) {
    let timeout;
    return function(...args) { clearTimeout(timeout); timeout = setTimeout(() => func.apply(this, args), wait); };
}

async function fetchSuggestions(query) {
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1`);
        return await res.json();
    } catch (error) { return []; }
}

function setupAutocomplete(inputId, listId, onSelectCallback) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    if (!input || !list) return;

    const handleInput = debounce(async (e) => {
        const query = e.target.value.trim();
        list.innerHTML = '';
        if (query.length < 3) { list.style.display = 'none'; return; }
        const results = await fetchSuggestions(query);
        
        if (results.length > 0) {
            list.style.display = 'block';
            results.forEach(place => {
                const li = document.createElement('li');
                let displayName = place.name || place.display_name.split(',')[0];
                let contextParts = place.display_name.split(',');
                let context = contextParts.length > 1 ? contextParts.slice(1, 3).join(', ') : '';
                li.innerHTML = `<b>${displayName}</b><br><span>${context}</span>`;
                li.onclick = () => {
                    input.value = ''; list.style.display = 'none';
                    onSelectCallback({ name: displayName, lat: parseFloat(place.lat), lon: parseFloat(place.lon) });
                };
                list.appendChild(li);
            });
        } else { list.style.display = 'none'; }
    }, 600);

    input.addEventListener('input', handleInput);
    document.addEventListener('click', (e) => { if(e.target !== input && e.target !== list) list.style.display = 'none'; });
}

function handleSidebarSelect(locationData) {
    document.getElementById('error-msg').style.display = 'none';
    saveLocationToSchedule(locationData);
    map.flyTo([locationData.lat, locationData.lon], 14);
}

function handleMapSearchSelect(locationData) {
    pendingLocation = locationData; 
    if (tempMarker) map.removeLayer(tempMarker);
    map.flyTo([locationData.lat, locationData.lon], 14);

    tempMarker = L.marker([locationData.lat, locationData.lon]).addTo(map);
    tempMarker.bindPopup(`
        <div style="text-align: center;">
            <b style="font-size:1.1rem;">${locationData.name}</b><br><br>
            <button onclick="addPendingToSchedule()" style="padding: 5px 10px; font-size: 0.8rem;">+ Add to Day ${currentDayIndex + 1}</button>
        </div>
    `).openPopup();
}

async function geocodeLocation(query) {
    const results = await fetchSuggestions(query);
    if (results && results.length > 0) return { name: results[0].name || results[0].display_name.split(',')[0], lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
    return null;
}

async function reverseGeocode(lat, lon) {
    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`);
        const data = await response.json();
        if (data && data.display_name) {
            let name = data.name || (data.address && (data.address.road || data.address.pedestrian || data.address.suburb || data.address.city));
            if (!name) name = data.display_name.split(',')[0];
            return { name: name, lat: lat, lon: lon };
        }
    } catch (error) { console.error(error); }
    return { name: "Pinned Location", lat: lat, lon: lon };
}

async function searchMapOnly() {
    const input = document.getElementById('map-search-input');
    const query = input.value.trim();
    if (!query) return;
    const locationData = await geocodeLocation(query);
    if (locationData) handleMapSearchSelect(locationData);
    else alert("Location not found on map.");
    input.value = '';
}

function addPendingToSchedule() {
    if (pendingLocation) { saveLocationToSchedule(pendingLocation); map.closePopup(); if (tempMarker) map.removeLayer(tempMarker); }
}

async function quickAddLocation() {
    const input = document.getElementById('sidebar-input');
    const errorMsg = document.getElementById('error-msg');
    const query = input.value.trim();
    if (!query) return;
    const locationData = await geocodeLocation(query);
    if (locationData) { errorMsg.style.display = 'none'; handleSidebarSelect(locationData); } 
    else { errorMsg.style.display = 'block'; }
    input.value = '';
}

// --- INTERACTIVITY FUNCTIONS ---
function saveLocationToSchedule(locData) {
    const newLocation = { 
        ...locData, 
        id: Date.now().toString(), 
        fixedTime: '', 
        stayMins: 60, 
        travelMode: 'driving', 
        customName: '', 
        customMins: '' 
    };
    const trip = trips.find(t => t.id === currentTripId);
    trip.days[currentDayIndex].locations.push(newLocation);
    saveData(); renderDay();
}

function removeLocation(locationId) {
    const trip = trips.find(t => t.id === currentTripId);
    const day = trip.days[currentDayIndex];
    day.locations = day.locations.filter(loc => loc.id !== locationId);
    saveData(); renderDay();
}

function updateDayStartTime(timeValue) {
    const trip = trips.find(t => t.id === currentTripId);
    trip.days[currentDayIndex].startTime = timeValue;
    saveData(); renderDay();
}

function updateFixedTime(locationId, timeValue) {
    const trip = trips.find(t => t.id === currentTripId);
    const day = trip.days[currentDayIndex];
    const loc = day.locations.find(l => l.id === locationId);
    if (loc) { loc.fixedTime = timeValue; saveData(); renderDay(); }
}

function updateStayTime(locationId, minsValue) {
    const trip = trips.find(t => t.id === currentTripId);
    const day = trip.days[currentDayIndex];
    const loc = day.locations.find(l => l.id === locationId);
    if (loc) { loc.stayMins = parseInt(minsValue) || 0; saveData(); renderDay(); }
}

function updateTravelMode(locationId, modeValue) {
    const trip = trips.find(t => t.id === currentTripId);
    const day = trip.days[currentDayIndex];
    const loc = day.locations.find(l => l.id === locationId);
    if (loc) { loc.travelMode = modeValue; saveData(); renderDay(); }
}

function updateCustomTransit(locationId, field, value) {
    const trip = trips.find(t => t.id === currentTripId);
    const day = trip.days[currentDayIndex];
    const loc = day.locations.find(l => l.id === locationId);
    if (loc) { loc[field] = value; saveData(); renderDay(); }
}

function renameLocation(locationId) {
    const trip = trips.find(t => t.id === currentTripId);
    const day = trip.days[currentDayIndex];
    const loc = day.locations.find(l => l.id === locationId);
    if (loc) {
        const newName = prompt("Rename location:", loc.name);
        if (newName && newName.trim() !== "") { loc.name = newName.trim(); saveData(); renderDay(); }
    }
}

function moveLocation(locationId, direction) {
    const trip = trips.find(t => t.id === currentTripId);
    const day = trip.days[currentDayIndex];
    const index = day.locations.findIndex(l => l.id === locationId);
    if (index < 0) return;
    const newIndex = index + direction;
    
    if (newIndex >= 0 && newIndex < day.locations.length) {
        const temp = day.locations[index];
        day.locations[index] = day.locations[newIndex];
        day.locations[newIndex] = temp;
        saveData(); renderDay();
    }
}

// --- RENDERING & ROUTING ---
function renderDay() {
    if (!currentTripId) return; // FIX: Prevent routing crashes if user leaves map quickly
    const trip = trips.find(t => t.id === currentTripId);
    if (!trip || !trip.days[currentDayIndex]) return;
    
    // 1. Crunch the math for the entire day's times
    calculateCascadingTimes();

    const dayLocations = trip.days[currentDayIndex].locations;
    const ul = document.getElementById('itinerary');
    ul.innerHTML = '';
    markersGroup.clearLayers(); 
    
    // 2. Build UI List
    dayLocations.forEach(loc => {
        const li = document.createElement('li');
        li.className = 'itinerary-item';
        li.dataset.id = loc.id;
        
        let currentMode = loc.travelMode || 'driving';
        if (currentMode === 'walking' || currentMode === 'cycling') currentMode = 'driving';

        li.innerHTML = `
            <div class="item-header">
                <span class="time-badge" title="Auto-calculated Arrival">${loc.calculatedArrival}</span>
                <span title="${loc.name}" style="margin-left: 10px; flex-grow: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">📍 ${loc.name}</span>
            </div>

            <div class="item-settings">
                <div class="setting-group">
                    <span title="Lock this Arrival Time">Lock Time:</span>
                    <input type="time" class="fixed-time-input" value="${loc.fixedTime || ''}" onchange="updateFixedTime('${loc.id}', this.value)">
                </div>
                <div class="setting-group">
                    <span title="Minutes spent at location">Stay (m):</span>
                    <input type="number" class="stay-input" value="${loc.stayMins}" step="15" min="0" onchange="updateStayTime('${loc.id}', this.value)">
                </div>
            </div>

            <div class="item-controls">
                <select class="mode-select" onchange="updateTravelMode('${loc.id}', this.value)" title="Travel to NEXT location">
                    <option value="driving" ${currentMode === 'driving' ? 'selected' : ''}>🚗 Drive</option>
                    <option value="custom" ${currentMode === 'custom' ? 'selected' : ''}>🚆 Custom</option>
                </select>

                <div class="icon-btn-group">
                    <button class="icon-btn move" onclick="moveLocation('${loc.id}', -1)">↑</button>
                    <button class="icon-btn move" onclick="moveLocation('${loc.id}', 1)">↓</button>
                    <button class="icon-btn edit-btn" onclick="renameLocation('${loc.id}')">✏️</button>
                    <button class="icon-btn danger" onclick="removeLocation('${loc.id}')">✖</button>
                </div>
            </div>
            ${currentMode === 'custom' ? `
                <div class="custom-transit-box">
                    <input type="text" placeholder="Method (e.g. JR Train)" value="${loc.customName || ''}" onchange="updateCustomTransit('${loc.id}', 'customName', this.value)" style="flex:2; padding: 4px; font-size: 0.8rem; border:1px solid #bdc3c7;">
                    <input type="number" placeholder="Mins" value="${loc.customMins || ''}" onchange="updateCustomTransit('${loc.id}', 'customMins', this.value)" style="flex:1; padding: 4px; font-size: 0.8rem; border:1px solid #bdc3c7;">
                </div>
            ` : ''}
        `;
        ul.appendChild(li);
    });

    // 3. Map Markers
    if (dayLocations.length > 0) {
        const latLngs = dayLocations.map((loc, index) => {
            let timeStr = `<br>Arrive: <b>${loc.calculatedArrival}</b><br>Depart: <b>${loc.calculatedDeparture}</b>`;
            const marker = L.marker([loc.lat, loc.lon]).bindPopup(`<b>${index + 1}. ${loc.name}</b>${timeStr}`);
            markersGroup.addLayer(marker);
            return [loc.lat, loc.lon];
        });

        map.fitBounds(L.latLngBounds(latLngs), { padding: [50, 50], maxZoom: 15 });

        // 4. Routing (Iterate through legs)
        if(dayLocations.length > 1) {
            const renderId = Date.now();
            ul.dataset.renderId = renderId;

            for (let i = 0; i < dayLocations.length - 1; i++) {
                const start = dayLocations[i];
                const end = dayLocations[i+1];
                let mode = start.travelMode || 'driving';
                if (mode === 'walking' || mode === 'cycling') mode = 'driving';

                const startLi = ul.querySelector(`.itinerary-item[data-id="${start.id}"]`);

                // MANUAL OVERRIDE LOGIC
                if (mode === 'custom') {
                    const distKm = (map.distance([start.lat, start.lon], [end.lat, end.lon]) / 1000).toFixed(1);
                    L.polyline([[start.lat, start.lon], [end.lat, end.lon]], {color: '#9b59b6', weight: 4, opacity: 0.8, dashArray: '8, 12'}).addTo(markersGroup);

                    const travelDiv = document.createElement('div');
                    travelDiv.className = 'travel-info custom';
                    const tName = start.customName || 'Transit';
                    const tMins = start.customMins || '0';
                    travelDiv.innerHTML = `🚆 ${tName} (~${tMins} min / ${distKm} km)`;
                    if(startLi) startLi.after(travelDiv);

                } 
                // AUTOMATIC OSRM LOGIC (DRIVING)
                else {
                    const routeKey = `${start.lat},${start.lon}_${end.lat},${end.lon}_${mode}`;
                    
                    if (window.routeCache[routeKey]) {
                        const cached = window.routeCache[routeKey];
                        
                        if (start.travelMinsToNext !== cached.mins) {
                            start.travelMinsToNext = cached.mins;
                            saveData();
                            setTimeout(renderDay, 10); 
                        }

                        L.geoJSON(cached.geometry, { style: { color: '#3498db', weight: 4, opacity: 0.8 } }).addTo(markersGroup);

                        const travelDiv = document.createElement('div');
                        travelDiv.className = 'travel-info';
                        travelDiv.innerHTML = `🚗 ~${cached.mins} min (${cached.kms} km)`;
                        if(startLi) startLi.after(travelDiv);

                    } else {
                        fetch(`https://router.project-osrm.org/route/v1/${mode}/${start.lon},${start.lat};${end.lon},${end.lat}?overview=full&geometries=geojson`)
                            .then(res => res.json())
                            .then(data => {
                                // Double check if user is still on the same trip!
                                if (!currentTripId || ul.dataset.renderId != renderId) return; 

                                if(data.code === 'Ok') {
                                    const route = data.routes[0];
                                    const mins = Math.round(route.duration / 60);
                                    const kms = (route.distance / 1000).toFixed(1);

                                    window.routeCache[routeKey] = {
                                        geometry: route.geometry,
                                        mins: mins,
                                        kms: kms
                                    };

                                    if (start.travelMinsToNext !== mins) {
                                        start.travelMinsToNext = mins;
                                        saveData();
                                        renderDay(); 
                                    } else {
                                        L.geoJSON(route.geometry, { style: { color: '#3498db', weight: 4, opacity: 0.8 } }).addTo(markersGroup);
                                        const travelDiv = document.createElement('div');
                                        travelDiv.className = 'travel-info';
                                        travelDiv.innerHTML = `🚗 ~${mins} min (${kms} km)`;
                                        if(startLi) startLi.after(travelDiv);
                                    }
                                }
                            })
                            .catch(err => console.log("Routing error: ", err));
                    }
                }
            }
        }
    }
}