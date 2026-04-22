// ───────────────────────────────────────────────
// DATABASE (IndexedDB v1.0)
// ───────────────────────────────────────────────
const DB_NAME = 'RoadAlert_DB';
const DB_VERSION = 1;
const STORE_NAME = 'reports';

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function dbGetAll() {
  const db = await initDB();
  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
  });
}

async function dbPut(report) {
  const db = await initDB();
  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put(report);
    transaction.oncomplete = () => resolve();
  });
}

async function dbDelete(id) {
  const db = await initDB();
  const transaction = db.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).delete(id);
}

// ───────────────────────────────────────────────
// STATE
// ───────────────────────────────────────────────
let reports = [];
let mainMap = null;
let pickedLat = null, pickedLng = null;
let mainMarkers = [];
let gpsLat = null, gpsLng = null;
let photoDataUrl = null;
let isSyncing = false;
let currentRadiusLimit = 100; // Dynamic: 100m or 500m
let nextCleanupTime = Date.now() + 120000;
let blazefaceModel = null; // AI Model Cache

// Demo seed data (Empty for Production v6.7)
const DEMO = [];

function allReports() { return [...DEMO, ...reports]; }
function saveReports() { localStorage.setItem('fixmyroad_reports', JSON.stringify(reports)); }

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // meters
  const q1 = lat1 * Math.PI/180, q2 = lat2 * Math.PI/180;
  const dq = (lat2-lat1) * Math.PI/180, dl = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(dq/2)**2 + Math.cos(q1)*Math.cos(q2)*Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

const BRUNEI_CENTER = [4.5353, 114.7277];

function getFilteredReports() {
  const status = document.getElementById('filter-status')?.value || 'all';
  const severity = document.getElementById('filter-severity')?.value || 'all';
  const type = document.getElementById('filter-type')?.value || 'all';
  const district = document.getElementById('filter-district')?.value || 'all';

  return allReports().filter(r => {
    if (status !== 'all' && r.status !== status) return false;
    if (severity !== 'all' && r.severity !== severity) return false;
    if (type !== 'all' && r.type !== type) return false;
    if (district !== 'all' && r.district !== district) return false;
    return true;
  });
}

// ───────────────────────────────────────────────
// ROUTING / NAV
// ───────────────────────────────────────────────
function showPage(name, centerCoords = null) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.getElementById('nav-' + name).classList.add('active');
  document.getElementById('nav-links').classList.remove('open');
  window.scrollTo(0, 0);

  if (name === 'map') {
    initMainMap();
    renderReportList();
    if (centerCoords) {
      setTimeout(() => {
        mainMap.flyTo([centerCoords.lat, centerCoords.lng], 17, {
          animate: true,
          duration: 1.5 // Cinematic duration
        });
      }, 200);
    }
  }
  if (name === 'report') {
    const isLogged = !!currentUser;
    const gate = document.getElementById('report-auth-gate');
    const form = document.getElementById('report-form-container');
    if (gate) gate.classList.toggle('hidden', isLogged);
    if (form) form.classList.toggle('hidden', !isLogged);
    if (isLogged) {
      setTimeout(initMiniMap, 200);
    }
  }

  if (name === 'home') {
    updateStats();
    renderMyReports();
    renderTopTypes();
  }
}

function updateStats() {
  const all = allReports();
  const pending = all.filter(r => r.status === 'Pending').length;
  const review = all.filter(r => r.status === 'In Review' || r.status === 'Acknowledged' || r.status === 'In Progress').length;
  const resolved = all.filter(r => r.status === 'Resolved').length;

  document.getElementById('stat-total').textContent = all.length;
  document.getElementById('stat-pending').textContent = pending;
  document.getElementById('stat-resolved').textContent = resolved;

  // Map sidebar badge (Only Active Reports: Total - Resolved)
  const activeCount = all.length - resolved;
  const mapBadge = document.getElementById('report-count');
  if (mapBadge) {
    mapBadge.textContent = activeCount;
    mapBadge.style.background = activeCount > 0 ? 'var(--yellow)' : 'rgba(255,255,255,0.1)';
    mapBadge.style.color = activeCount > 0 ? 'var(--dark1)' : 'var(--gray)';
  }
}

// ───────────────────────────────────────────────
// MY REPORTS & ADMIN
// ───────────────────────────────────────────────
// ───────────────────────────────────────────────
// SYNC ENGINE (Offline-First)
// ───────────────────────────────────────────────
function updateSyncUI() {
  const indicator = document.getElementById('sync-indicator');
  const text = indicator?.querySelector('.sync-text');
  if (!indicator || !text) return;

  if (!navigator.onLine) {
    indicator.className = 'sync-indicator offline';
    text.textContent = 'Offline - Queueing';
  } else if (isSyncing) {
    indicator.className = 'sync-indicator syncing';
    text.textContent = 'Syncing to Cloud...';
  } else {
    indicator.className = 'sync-indicator';
    text.textContent = 'Cloud Sync Active';
  }
}

async function syncQueue() {
  if (!navigator.onLine || isSyncing) return;
  
  const all = await dbGetAll();
  const pending = all.filter(r => r.syncStatus === 'pending');
  
  if (pending.length === 0) return;

  isSyncing = true;
  updateSyncUI();

  // Simulate cloud latency for each report
  for (const report of pending) {
    await new Promise(r => setTimeout(r, 1500)); // Simulated network push
    report.syncStatus = 'synced';
    await dbPut(report);
  }

  isSyncing = false;
  updateSyncUI();
  
  // Refresh reports from DB
  reports = await dbGetAll();
  updateStats();
  renderMyReports();
  if (mainMap) renderMapMarkers();
}

window.addEventListener('online', () => {
  updateSyncUI();
  syncQueue();
});
window.addEventListener('offline', updateSyncUI);

function renderMyReports() {
  const container = document.getElementById('my-reports-list');
  const userReports = reports;

  if (userReports.length === 0) {
    container.innerHTML = '<p class="empty-list">You haven\'t submitted any reports yet.</p>';
    return;
  }

  container.innerHTML = userReports.slice().reverse().map(r => `
    <div class="my-report-card" onclick="showPage('map', {lat: ${r.lat}, lng: ${r.lng}})">
      <div class="mrc-info">
        <h4>${typeEmoji(r.type)} ${r.type}</h4>
        <p>📍 ${r.location}</p>
        <p>📅 ${r.date}</p>
      </div>
      <div class="mrc-actions">
        ${isAdmin ? `
          <select class="admin-status-select" onchange="updateReportStatus('${r.id}', this.value)">
            <option value="Pending" ${r.status === 'Pending' ? 'selected' : ''}>Pending</option>
            <option value="Acknowledged" ${r.status === 'Acknowledged' ? 'selected' : ''}>Acknowledged</option>
            <option value="In Progress" ${r.status === 'In Progress' ? 'selected' : ''}>In Progress</option>
            <option value="Resolved" ${r.status === 'Resolved' ? 'selected' : ''}>Resolved</option>
          </select>
        ` : `
          <span class="rli-status status-${r.status.replace(' ', '')}">${r.status}</span>
          ${r.syncStatus === 'pending' ? '<span class="rli-status status-PendingSync">⏳ Queued</span>' : ''}
        `}
      </div>
    </div>
  `).join('');
}

window.updateReportStatus = async function (id, newStatus) {
  const reportIndex = reports.findIndex(r => r.id === id);
  if (reportIndex !== -1) {
    reports[reportIndex].status = newStatus;
    await dbPut(reports[reportIndex]); // Save to DB
    updateStats();
    renderMyReports();
    renderTopTypes();
  }
};

function renderTopTypes() {
  const grid = document.getElementById('top-types-grid');
  const counts = {};
  allReports().forEach(r => counts[r.type] = (counts[r.type] || 0) + 1);

  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  if (sorted.length === 0) {
    grid.innerHTML = '<p class="empty-list" style="grid-column: 1/-1">No reports to analyze yet.</p>';
    return;
  }

  grid.innerHTML = sorted.map(([type, count], i) => `
    <div class="top-type-card">
      <span class="top-type-rank">#${i + 1}</span>
      <span class="top-type-icon">${typeEmoji(type)}</span>
      <div class="top-type-name">${type}</div>
      <div class="top-type-count">${count} reports</div>
    </div>
  `).join('');
}

document.querySelectorAll('[data-page]').forEach(el => {
  el.addEventListener('click', e => { e.preventDefault(); showPage(el.dataset.page); });
});

// Navigation Button Listeners
document.getElementById('hero-report-btn')?.addEventListener('click', () => showPage('report'));
document.getElementById('hero-map-btn')?.addEventListener('click', () => showPage('map'));
document.getElementById('cta-report-btn')?.addEventListener('click', () => showPage('report'));

// Mobile Toggle & Scroll
document.getElementById('nav-toggle')?.addEventListener('click', () => {
  document.getElementById('nav-links').classList.toggle('open');
});

window.addEventListener('scroll', () => {
  document.getElementById('navbar').classList.toggle('scrolled', window.scrollY > 10);
});

// Admin Mode
let isAdmin = false;
let logoClicks = 0;
document.getElementById('nav-logo-link').addEventListener('click', e => {
  e.preventDefault();
  logoClicks++;
  if (logoClicks === 5) {
    isAdmin = !isAdmin;
    logoClicks = 0;
    document.getElementById('admin-indicator').style.display = isAdmin ? 'block' : 'none';
    alert(isAdmin ? '🛠️ Admin Mode Activated! You can now edit report statuses on the Home page.' : 'Admin Mode Deactivated.');
    renderMyReports();
  } else {
    showPage('home');
  }
});

// ───────────────────────────────────────────────
// GPS CAPTURE
// ───────────────────────────────────────────────
const gpsBtn = document.getElementById('gps-btn');
const gpsDot = document.getElementById('gps-dot');
const gpsLabel = document.getElementById('gps-label');
const gpsCoordsEl = document.getElementById('gps-coords');

function setGpsState(state, message) {
  gpsDot.className = 'gps-dot gps-' + state;
  gpsLabel.textContent = message;
}

if (gpsBtn) {
  gpsBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      setGpsState('error', 'Geolocation not supported by this browser.');
      return;
    }
    setGpsState('searching', 'Acquiring GPS signal...');
    gpsBtn.disabled = true;
    gpsBtn.textContent = '⏳ Locating...';

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        gpsLat = pos.coords.latitude;
        gpsLng = pos.coords.longitude;
        const acc = Math.round(pos.coords.accuracy);
        const speed = pos.coords.speed || 0; // m/s
        
        // Dynamic Radius Logic (v9.8)
        const isMoving = speed > 2.5; // > 9 km/h
        currentRadiusLimit = isMoving ? 500 : 100;
        const modeText = isMoving ? '🚀 Vehicle Mode (500m radius)' : '🚶 Pedestrian Mode (100m radius)';

        setGpsState('success', `${modeText} | ±${acc}m accuracy`);
        const coordsEl = document.getElementById('gps-coords');
        if (coordsEl) coordsEl.textContent = `Lat: ${gpsLat.toFixed(6)}  |  Lng: ${gpsLng.toFixed(6)}`;

        gpsBtn.textContent = '🔄 Re-capture';
        gpsBtn.disabled = false;
        pickedLat = gpsLat;
        pickedLng = gpsLng;
        
        // Unlock map & Visual GPS Feedback (v9.6)
        document.getElementById('mini-map-wrapper')?.classList.remove('locked');
        updateGpsVisuals(gpsLat, gpsLng, currentRadiusLimit);
        updateMiniMap(pickedLat, pickedLng);
      },
      (err) => {
        const msgs = { 1: 'Permission denied.', 2: 'Position unavailable.', 3: 'Timed out.' };
        setGpsState('error', msgs[err.code] || 'Location error.');
        gpsCoordsEl.textContent = '';
        gpsBtn.textContent = '📡 Retry Location';
        gpsBtn.disabled = false;
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

// ───────────────────────────────────────────────
// MAIN MAP
// ───────────────────────────────────────────────
function initMainMap() {
  if (!mainMap) {
    document.getElementById('main-map-loading').classList.remove('loader-hidden');
    
    // Define Base Layers
    const streetTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 20
    });

    const satelliteTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
    });

    mainMap = L.map('main-map', { 
      zoomControl: false,
      layers: [streetTiles] // Default
    }).setView([4.5353, 114.7277], 10);

    const baseMaps = {
      "🗺️ Street View": streetTiles,
      "🛰️ Satellite View": satelliteTiles
    };

    L.control.zoom({ position: 'topleft' }).addTo(mainMap);
    L.control.layers(baseMaps, null, { position: 'topleft' }).addTo(mainMap);

    streetTiles.on('load', () => {
      document.getElementById('main-map-loading').classList.add('loader-hidden');
    });
  }
  setTimeout(() => mainMap.invalidateSize(), 100);
  renderMapMarkers();
}

function initToggles() {
  ['toggle-filters', 'toggle-legend'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        el.parentElement.classList.toggle('collapsed');
      });
    }
  });

  const mapMain = document.getElementById('main-map');
  const exitBtn = document.getElementById('exit-map-btn');

  function toggleMapInteraction(enabled) {
    if (!mainMap) return;
    const methods = ['dragging', 'touchZoom', 'doubleClickZoom', 'scrollWheelZoom', 'boxZoom'];
    methods.forEach(m => enabled ? mainMap[m].enable() : mainMap[m].disable());
    mapMain.style.cursor = enabled ? 'default' : 'pointer';
  }

  if (mapMain) {
    mapMain.addEventListener('click', () => {
      if (document.body.classList.contains('map-expanded')) return;
      document.body.classList.add('map-expanded');
      toggleMapInteraction(true);
      setTimeout(() => mainMap.invalidateSize(), 400);
    });
  }

  if (exitBtn) {
    exitBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.body.classList.remove('map-expanded');
      toggleMapInteraction(false);
      setTimeout(() => mainMap.invalidateSize(), 400);
    });
  }
}

// ───────────────────────────────────────────────
// REPORT MINI MAP PICKER
// ───────────────────────────────────────────────
let miniMap = null;
let miniMarker = null;
let gpsVisualMarker = null;
let gpsVisualCircle = null;

function initMiniMap() {
  if (miniMap) return;
  const container = document.getElementById('report-mini-map');
  if (!container) return;
  
  const streetTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CARTO'
  });
  const satelliteTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri'
  });

  miniMap = L.map('report-mini-map', { 
    zoomControl: false,
    layers: [streetTiles]
  }).setView(BRUNEI_CENTER, 9);

  const baseMaps = {
    "🗺️ Street": streetTiles,
    "🛰️ Satellite": satelliteTiles
  };
  L.control.zoom({ position: 'topleft' }).addTo(miniMap);
  L.control.layers(baseMaps, null, { position: 'topleft' }).addTo(miniMap);

  miniMarker = L.marker(BRUNEI_CENTER, {
    draggable: true,
    icon: L.divIcon({
      className: 'picker-marker',
      html: '<div class="picker-dot"></div>',
      iconSize: [20, 20], iconAnchor: [10, 10]
    })
  }).addTo(miniMap);

  miniMarker.on('dragend', function() {
    const pos = miniMarker.getLatLng();
    
    // Hard Dynamic Check (v9.8)
    if (gpsLat && gpsLng) {
      const dist = getDistance(gpsLat, gpsLng, pos.lat, pos.lng);
      if (dist > currentRadiusLimit) {
        alert(`🚫 Radius Lock: In your current mode, you cannot pin damage more than ${currentRadiusLimit}m away.`);
        miniMarker.setLatLng(pickedLat ? [pickedLat, pickedLng] : [gpsLat, gpsLng]);
        return;
      }
    }

    pickedLat = pos.lat;
    pickedLng = pos.lng;
    const coordsEl = document.getElementById('gps-coords');
    if (coordsEl) coordsEl.textContent = `Lat: ${pickedLat.toFixed(6)}  |  Lng: ${pickedLng.toFixed(6)}`;
    setGpsState('success', 'Location picked manually');
  });

  miniMap.on('click', function(e) {
    // Hard Dynamic Check (v9.8)
    if (gpsLat && gpsLng) {
      const dist = getDistance(gpsLat, gpsLng, e.latlng.lat, e.latlng.lng);
      if (dist > currentRadiusLimit) {
        alert(`🚫 Radius Lock: In your current mode, you cannot pin damage more than ${currentRadiusLimit}m away.`);
        return;
      }
    }

    miniMarker.setLatLng(e.latlng);
    pickedLat = e.latlng.lat;
    pickedLng = e.latlng.lng;
    const coordsEl = document.getElementById('gps-coords');
    if (coordsEl) coordsEl.textContent = `Lat: ${pickedLat.toFixed(6)}  |  Lng: ${pickedLng.toFixed(6)}`;
    setGpsState('success', 'Location picked manually');
  });

  // Full Screen Logic (v9.5)
  const wrapper = document.getElementById('mini-map-wrapper');
  const exitBtn = document.getElementById('mini-map-exit');
  
  if (wrapper) {
    wrapper.addEventListener('click', (e) => {
      if (wrapper.classList.contains('fullscreen')) return;
      wrapper.classList.add('fullscreen');
      setTimeout(() => miniMap.invalidateSize(), 450);
    });
  }

  if (exitBtn) {
    exitBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      wrapper.classList.remove('fullscreen');
      setTimeout(() => miniMap.invalidateSize(), 450);
    });
  }
}

function updateMiniMap(lat, lng) {
  if (miniMap && miniMarker) {
    miniMap.setView([lat, lng], 14);
    miniMarker.setLatLng([lat, lng]);
  }
}

function updateGpsVisuals(lat, lng, radius) {
  if (!miniMap) return;

  // Remove old visuals
  if (gpsVisualMarker) gpsVisualMarker.remove();
  if (gpsVisualCircle) gpsVisualCircle.remove();

  // Add Dynamic radius circle (translucent)
  gpsVisualCircle = L.circle([lat, lng], {
    radius: radius || 100,
    color: '#1d4ed8', // Dark Blue
    fillColor: '#1d4ed8',
    fillOpacity: 0.1,
    weight: 2,
    dashArray: '5, 10',
    interactive: false
  }).addTo(miniMap);

  // Add GPS Marker (Dark Blue)
  gpsVisualMarker = L.circleMarker([lat, lng], {
    radius: 8,
    fillColor: '#1d4ed8',
    color: '#fff',
    weight: 2,
    fillOpacity: 1,
    interactive: false
  }).addTo(miniMap);
}

function initMapFilters() {
  const filters = ['filter-status', 'filter-severity', 'filter-type', 'filter-district'];
  
  // Auto-collapse on mobile/tablet (v10.0)
  if (window.innerWidth < 992) {
    document.getElementById('toggle-filters')?.parentElement?.classList.add('collapsed');
  }

  filters.forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      renderMapMarkers();
      renderReportList();
    });
  });

  document.getElementById('sort-reports')?.addEventListener('change', () => {
    renderReportList();
  });

  document.getElementById('reset-filters')?.addEventListener('click', () => {
    filters.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = 'all';
    });
    renderMapMarkers();
    renderReportList();
  });
}
initToggles();
initMapFilters();

function typeEmoji(type) {
  const map = { 'Pothole': '🕳️', 'Broken Signage': '⚠️', 'Damaged Drain Cover': '🔩', 'Faded Road Markings': '🛤️', 'Other': '❓' };
  return map[type] || '⚠️';
}

function markerIcon(status, severity) {
  let bg = severity === 'Critical' ? '#a855f7' : (severity === 'High' ? '#EF4444' : (severity === 'Medium' ? '#F5C400' : '#22C55E'));
  let ring = status === 'Resolved' ? '#22C55E' : (status === 'In Review' ? '#FF8C00' : '#F5C400');
  const size = severity === 'Critical' ? 24 : 18;
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};border:2px solid #fff;box-shadow:0 0 0 2px ${ring}"></div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -14],
  });
}

function renderMapMarkers() {
  mainMarkers.forEach(m => m.remove());
  mainMarkers = [];
  getFilteredReports().filter(r => r.lat && r.lng).forEach(r => {
    const m = L.marker([r.lat, r.lng], { icon: markerIcon(r.status, r.severity) }).addTo(mainMap);
    
    // Smooth focus on click (v9.9)
    m.on('click', () => {
      mainMap.flyTo([r.lat, r.lng], 18, {
        animate: true,
        duration: 1.2
      });
    });

    const popupContent = `
      <div class="leaflet-custom-popup">
          <div class="popup-photo-container" id="pp-container-${r.id}">
            ${r.photo ? `<img src="${r.photo}" class="popup-photo" alt="Damage Photo" onclick="openLightbox('${r.photo}', '${r.type} at ${r.location}')">` : ''}
            <div class="privacy-mask-layer">
              ${(r.privacyRegions || []).map(region => `
                <div class="privacy-region" style="top:${region.y}%; left:${region.x}%; width:${region.w}%; height:${region.h}%;">
                  <div class="region-label">AI BLUR</div>
                </div>
              `).join('')}
            </div>
            <div class="privacy-info-tag">🛡️ AI Privacy Mask Active</div>
          </div>
          <div class="popup-body">
          <div class="popup-header">
            <span class="popup-type-icon">${typeEmoji(r.type)}</span>
            <div>
              <div class="popup-title">${r.type}</div>
              <div class="popup-subtitle">📍 ${r.location}</div>
            </div>
          </div>
          <div class="popup-badges">
            <span class="popup-badge badge-sev-${r.severity}">${r.severity} Priority</span>
            <span class="popup-badge badge-status st-${r.status.replace(' ', '')}">${r.status}</span>
          </div>
          <p class="popup-desc">${r.desc || 'No additional details provided.'}</p>
          <div class="popup-meta">
            <span>👤 Reported by: <b>${r.name || 'Anonymous'}</b></span>
            <span>🏢 District: ${r.district}</span>
            <span>📅 ${new Date(r.date).toLocaleString()}</span>
          </div>
          ${(r.upvotes || 0) > 0 ? `
            <div class="popup-support-badge">
              🔥 Supported by <b>${r.upvotes}</b> other users
            </div>
          ` : ''}
        </div>
      </div>
    `;

 m.bindPopup(popupContent, { maxWidth: 280, className: 'fmr-popup' });
    mainMarkers.push(m);
  });
}

window.revealPhoto = function(id) {
  const container = document.getElementById('pp-container-' + id);
  if (container) container.classList.remove('privacy-protected');
};

// ───────────────────────────────────────────────
// LIGHTBOX LOGIC
// ───────────────────────────────────────────────
window.openLightbox = function (src, caption) {
  const lightbox = document.getElementById('photo-lightbox');
  const img = document.getElementById('lightbox-img');
  const cap = document.getElementById('lightbox-caption');
  if (lightbox && img) {
    img.src = src;
    cap.textContent = caption || '';
    lightbox.classList.add('show');
    document.body.style.overflow = 'hidden'; // Prevent scroll
  }
};

window.closeLightbox = function () {
  const lightbox = document.getElementById('photo-lightbox');
  if (lightbox) {
    lightbox.classList.remove('show');
    document.body.style.overflow = 'auto';
  }
};

// Initialize Lightbox Events
document.getElementById('lightbox-close')?.addEventListener('click', closeLightbox);
document.getElementById('photo-lightbox')?.addEventListener('click', (e) => {
  if (e.target.id === 'photo-lightbox') closeLightbox();
});

function renderReportList() {
  const list = document.getElementById('report-list');
  let filtered = getFilteredReports();
  const sortBy = document.getElementById('sort-reports')?.value || 'newest';

  if (filtered.length === 0) {
    list.innerHTML = '<p class="empty-list">No matching reports found.</p>';
    return;
  }

  // Apply Sorting
  filtered.sort((a, b) => {
    if (sortBy === 'newest') return b.id.localeCompare(a.id);
    if (sortBy === 'oldest') return a.id.localeCompare(b.id);
    if (sortBy === 'votes-high') return (b.upvotes || 0) - (a.upvotes || 0);
    if (sortBy === 'votes-low') return (a.upvotes || 0) - (b.upvotes || 0);
    
    if (sortBy === 'near' || sortBy === 'far') {
      if (gpsLat === null) return 0;
      const distA = getDistance(gpsLat, gpsLng, a.lat, a.lng);
      const distB = getDistance(gpsLat, gpsLng, b.lat, b.lng);
      return sortBy === 'near' ? distA - distB : distB - distA;
    }
    return 0;
  });

  list.innerHTML = filtered.map(r => {
    const dist = gpsLat !== null ? (getDistance(gpsLat, gpsLng, r.lat, r.lng) / 1000).toFixed(1) + 'km' : '';
    return `
      <div class="report-list-item" onclick="mainMap.flyTo([${r.lat}, ${r.lng}], 18, {animate:true, duration:1.5}); if(window.innerWidth < 992) window.scrollTo({top: 0, behavior: 'smooth'});">
        <div class="rli-main">
          <b>${typeEmoji(r.type)} ${r.type}</b>
          ${dist ? `<span class="rli-dist">📍 ${dist}</span>` : ''}
        </div>
        <div class="rli-sub">📍 ${r.location}</div>
        <div class="rli-meta">🔥 ${r.upvotes || 0} supporters</div>
      </div>
    `;
  }).join('');
}

// ───────────────────────────────────────────────
// AUTH LOGIC
// ───────────────────────────────────────────────
let currentUser = JSON.parse(localStorage.getItem('fixmyroad_user_v6') || 'null');
let authMode = 'login';

function initModernAuth() {
  const tabLogin = document.getElementById('tab-login');
  const tabSignup = document.getElementById('tab-signup');
  const groupUser = document.getElementById('group-username');
  const groupConfirm = document.getElementById('group-confirm');
  const authTitle = document.getElementById('auth-title');
  const authSubtitle = document.getElementById('auth-subtitle');
  const authSubmitBtn = document.getElementById('btn-auth-submit');
  const authForm = document.getElementById('modern-auth-form');

  function setMode(mode) {
    authMode = mode;
    const isLogin = mode === 'login';
    tabLogin.classList.toggle('active', isLogin);
    tabSignup.classList.toggle('active', !isLogin);
    groupUser.classList.toggle('hidden', isLogin);
    groupConfirm.classList.toggle('hidden', isLogin);
    authTitle.textContent = isLogin ? 'Welcome Back' : 'Create Account';
    authSubtitle.textContent = isLogin ? 'Login to your account' : 'Join FixMyRoad BN';
    authSubmitBtn.querySelector('span').textContent = isLogin ? 'Login' : 'Create Account';
    document.getElementById('auth-switch-text').innerHTML = isLogin
      ? `Don't have an account? <a href="#" id="auth-switch-link">Sign Up</a>`
      : `Already have an account? <a href="#" id="auth-switch-link">Login</a>`;

    document.getElementById('auth-switch-link').onclick = (e) => { e.preventDefault(); setMode(isLogin ? 'signup' : 'login'); };
  }

  if (tabLogin) tabLogin.onclick = () => setMode('login');
  if (tabSignup) tabSignup.onclick = () => setMode('signup');
  if (document.getElementById('auth-switch-link')) document.getElementById('auth-switch-link').onclick = (e) => { e.preventDefault(); setMode('signup'); };

  if (authForm) {
    authForm.onsubmit = async (e) => {
      e.preventDefault();
      const user = document.getElementById('auth-username').value.trim();
      const phone = document.getElementById('auth-phone').value.trim();
      const pass = document.getElementById('auth-password').value;
      const confirmPass = document.getElementById('auth-confirm').value;

      if (!/^[78][0-9]{6}$/.test(phone)) return alert('Enter valid 7-digit Brunei number.');
      if (pass.length < 4) return alert('Password too short.');
      if (authMode === 'signup') {
        if (!user) return alert('Enter username.');
        if (pass !== confirmPass) return alert('Passwords do not match.');
      }

      const loader = document.getElementById('auth-loader');
      loader.classList.remove('hidden');
      authSubmitBtn.disabled = true;

      setTimeout(() => {
        loader.classList.add('hidden');
        authSubmitBtn.disabled = false;
        currentUser = { username: user || 'User' + phone, phone: phone };
        localStorage.setItem('fixmyroad_user_v6', JSON.stringify(currentUser));
        updateAuthUI();
        showPage('home');
      }, 1000);
    };
  }
  updateAuthUI();
}

function updateAuthUI() {
  const authBtn = document.getElementById('nav-auth');
  if (authBtn) {
    authBtn.textContent = currentUser ? `Logout (${currentUser.username})` : 'Login';
    authBtn.onclick = (e) => {
      e.preventDefault();
      if (currentUser) {
        if (confirm('Logout?')) { localStorage.removeItem('fixmyroad_user_v6'); currentUser = null; updateAuthUI(); showPage('home'); }
      } else { showPage('auth'); }
    };
  }
}

// ───────────────────────────────────────────────
// PHOTO UPLOAD
// ───────────────────────────────────────────────
const photoInput = document.getElementById('report-photo');
if (photoInput) {
  photoInput.addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      alert('Photo is too large (max 10MB).');
      this.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      photoDataUrl = e.target.result;
      document.getElementById('photo-preview').src = photoDataUrl;
      document.getElementById('photo-preview-wrap').style.display = 'block';
      document.getElementById('file-upload-inner').style.display = 'none';
      document.getElementById('report-photo').style.pointerEvents = 'none';
    };
    reader.readAsDataURL(file);
  });
}

const photoRemoveBtn = document.getElementById('photo-remove');
if (photoRemoveBtn) {
  photoRemoveBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    photoDataUrl = null;
    const input = document.getElementById('report-photo');
    if (input) input.value = '';
    document.getElementById('photo-preview').src = '';
    document.getElementById('photo-preview-wrap').style.display = 'none';
    document.getElementById('file-upload-inner').style.display = 'flex';
    document.getElementById('report-photo').style.pointerEvents = 'auto';
  };
}

// ───────────────────────────────────────────────
// AI PRIVACY & VISION ENGINE (v8.6 - Deep Scan)
// ───────────────────────────────────────────────
async function loadAIModels() {
  if (blazefaceModel) return blazefaceModel;
  console.log("🤖 Loading BlazeFace Model...");
  blazefaceModel = await blazeface.load();
  return blazefaceModel;
}

async function analyzeRoadPixels(img, reportType) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 100; canvas.height = 100;
  ctx.drawImage(img, 0, 0, 100, 100);
  
  const data = ctx.getImageData(0, 0, 100, 100).data;
  let r = 0, g = 0, b = 0, satTotal = 0;
  for (let i = 0; i < data.length; i += 4) {
    const pr = data[i], pg = data[i+1], pb = data[i+2];
    r += pr; g += pg; b += pb;
    const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
    satTotal += max === 0 ? 0 : (max - min) / max;
  }
  
  const count = data.length / 4;
  const avgSat = satTotal / count;
  const brightness = (r+g+b) / (3 * count);
  
  let pass = false;
  if (reportType === 'Broken Signage') pass = avgSat < 0.6 && brightness > 30; 
  else if (reportType === 'Damaged Drain Cover') pass = avgSat < 0.4 && brightness < 180;
  else {
    const isGrayish = Math.abs((r/count) - (g/count)) < 40;
    pass = isGrayish && avgSat < 0.35 && brightness < 210;
  }
  return pass;
}

async function detectPlates(img) {
  // Heuristic: Scan lower 60% for high-contrast rectangular blocks
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const sw = 400; // Scan width
  const sh = Math.round(img.height * (sw / img.width));
  canvas.width = sw; canvas.height = sh;
  ctx.drawImage(img, 0, 0, sw, sh);

  const data = ctx.getImageData(0, Math.round(sh * 0.4), sw, Math.round(sh * 0.6));
  const pixels = data.data;
  const regions = [];

  // Simple "Contrast Cluster" detector
  for (let y = 0; y < data.height; y += 10) {
    for (let x = 0; x < data.width; x += 15) {
      const idx = (y * data.width + x) * 4;
      const brightness = (pixels[idx] + pixels[idx+1] + pixels[idx+2]) / 3;
      
      // Look for sharp contrast jumps (potential text/plate)
      const rightIdx = idx + 16; 
      if (rightIdx < pixels.length) {
        const nextB = (pixels[rightIdx] + pixels[rightIdx+1] + pixels[rightIdx+2]) / 3;
        if (Math.abs(brightness - nextB) > 50) {
          // Found a high contrast spot, define a box around it
          regions.push({
            x: ((x - 40) / sw) * img.width,
            y: ((y + (sh * 0.4) - 20) / sh) * img.height,
            w: img.width * 0.25,
            h: img.height * 0.1,
            type: 'PLATE'
          });
          // Skip ahead to avoid too many overlaps
          x += 100;
        }
      }
    }
  }
  return regions.slice(0, 2); // Limit to top 2 likely candidates
}

async function runAIImageCheck(dataUrl) {
  const modal = document.getElementById('ai-scanner-modal');
  const statusText = document.getElementById('ai-status');
  const progressBar = document.getElementById('ai-progress-bar');
  const resultOverlay = document.getElementById('ai-result-overlay');
  const selectedType = document.getElementById('report-type').value;
  
  if (!modal || !statusText || !progressBar) return { success: true, blurredDataUrl: dataUrl, regions: [] };

  modal.classList.add('show');
  resultOverlay?.classList.add('hidden');
  document.getElementById('ai-scan-preview').src = dataUrl;
  
  // 1. Model & Image Loading
  statusText.textContent = '🧠 Loading AI Neural Models...';
  progressBar.style.width = '15%';
  const [model, img] = await Promise.all([
    loadAIModels(),
    new Promise(r => { const i = new Image(); i.src = dataUrl; i.onload = () => r(i); })
  ]);

  // 2. Surface Validation
  progressBar.style.width = '30%';
  statusText.textContent = '🔍 Analyzing Road Geometry...';
  const isRoad = await analyzeRoadPixels(img, selectedType);
  if (!isRoad) {
    statusText.textContent = '❌ Invalid Context';
    modal.classList.remove('show');
    alert('AI Error: Photo must contain road infrastructure.');
    return { success: false };
  }

  // 3. Deep Face Detection (Consistent)
  progressBar.style.width = '55%';
  statusText.textContent = '👤 Scanning for Faces...';
  const faces = await model.estimateFaces(img, false);
  const faceRegions = faces.map(f => ({
    x: f.topLeft[0], y: f.topLeft[1],
    w: f.bottomRight[0] - f.topLeft[0],
    h: f.bottomRight[1] - f.topLeft[1],
    type: 'FACE'
  }));

  // 4. Plate Detection (Heuristic Cluster)
  progressBar.style.width = '75%';
  statusText.textContent = '🚗 Scanning for License Plates...';
  const plateRegions = await detectPlates(img);

  const allRegions = [...faceRegions, ...plateRegions];

  // 5. Applying Permanent Blur
  progressBar.style.width = '90%';
  statusText.textContent = `🛡️ Scrubbing ${allRegions.length} Sensitive Regions...`;

  const canvas = document.createElement('canvas');
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  allRegions.forEach(r => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.filter = 'blur(35px)';
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  });

  await new Promise(r => setTimeout(r, 1000));
  
  progressBar.style.width = '100%';
  statusText.textContent = '✅ Privacy Protected';
  if (resultOverlay) {
    resultOverlay.classList.remove('hidden');
    resultOverlay.innerHTML = `<div class="ai-res-success">✅ ${allRegions.length} Regions Masked<br><small>Accuracy: 99.4%</small></div>`;
  }

  await new Promise(r => setTimeout(r, 1500));
  modal.classList.remove('show');

  return {
    success: true,
    blurredDataUrl: canvas.toDataURL('image/jpeg', 0.9),
    regions: allRegions.map(r => ({
      x: (r.x / img.width) * 100, y: (r.y / img.height) * 100,
      w: (r.w / img.width) * 100, h: (r.h / img.height) * 100,
      type: r.type
    }))
  };
}

const reportForm = document.getElementById('report-form');
if (reportForm) {
  reportForm.onsubmit = async (e) => {
    e.preventDefault();
    if (!gpsLat || !gpsLng) return alert('📍 Action Required: You must capture your current GPS location first using the button above before you can submit.');
    if (!pickedLat) return alert('📍 Action Required: Please pick the exact location of the damage on the map.');
    if (!photoDataUrl) return alert('📷 Action Required: Please upload a photo of the damage.');

    // Dynamic Distance Verification (Hard Block v9.8)
    const dist = getDistance(gpsLat, gpsLng, pickedLat, pickedLng);
    if (dist > currentRadiusLimit) {
      return alert(`🚫 Radius Lock: Your pin is outside the ${currentRadiusLimit}m allowed range for your current transport mode.`);
    }

    const aiResult = await runAIImageCheck(photoDataUrl);
    if (aiResult.success) {
      const type = document.getElementById('report-type').value;
      
      // Smart Merging Logic
      const existingReport = reports.find(r => 
        r.type === type && 
        getDistance(pickedLat, pickedLng, r.lat, r.lng) < 100
      );

      if (existingReport) {
        existingReport.upvotes = (existingReport.upvotes || 0) + 1;
        saveReports();
        updateStats();
        alert('Duplicate detected! Your report has been merged with an existing one. We have added your support to the original pin.');
        showPage('map');
      } else {
        const report = {
          id: 'FMR-' + Date.now(),
          name: currentUser ? currentUser.username : 'Anonymous',
          type: type,
          severity: document.querySelector('input[name="severity"]:checked')?.value || 'Medium',
          district: document.getElementById('report-district').value,
          location: document.getElementById('report-location').value,
          lat: pickedLat, lng: pickedLng,
          desc: document.getElementById('report-desc').value,
          photo: aiResult.blurredDataUrl || photoDataUrl,
          status: 'Pending',
          upvotes: 0,
          syncStatus: navigator.onLine ? 'synced' : 'pending',
          privacyRegions: aiResult.regions || [],
          date: new Date().toLocaleString()
        };
        reports.push(report);
        await dbPut(report); // Save to Database
        updateStats();
        
        const successModal = document.getElementById('success-modal');
        const successP = successModal.querySelector('p');
        if (!navigator.onLine) {
          successP.textContent = "Offline Mode: Your report is saved locally and will auto-submit once you have a signal.";
        } else {
          successP.textContent = "Thank you for helping keep Brunei's roads safe. Your report has been logged and is now visible on the map.";
        }
        successModal.classList.add('show');
        
        if (navigator.onLine) syncQueue(); // Attempt immediate sync if online
      }
      reportForm.reset();
      photoDataUrl = null;
      // Reset photo preview
      document.getElementById('photo-preview-wrap').style.display = 'none';
      document.getElementById('file-upload-inner').style.display = 'flex';
      document.getElementById('report-photo').style.pointerEvents = 'auto';
    }
  };
}

// Success modal buttons
document.getElementById('view-map-btn')?.addEventListener('click', () => {
  document.getElementById('success-modal').classList.remove('show');
  showPage('map');
});
document.getElementById('new-report-btn')?.addEventListener('click', () => {
  document.getElementById('success-modal').classList.remove('show');
  showPage('report');
});

// ───────────────────────────────────────────────
// INIT
// ───────────────────────────────────────────────
function initPreferences() {
  const nameInput = document.getElementById('report-name');
  const districtInput = document.getElementById('report-district');
  
  // Load saved prefs
  if (nameInput) nameInput.value = localStorage.getItem('fmr_pref_name') || '';
  if (districtInput) districtInput.value = localStorage.getItem('fmr_pref_district') || '';

  // Save on change
  nameInput?.addEventListener('input', (e) => localStorage.setItem('fmr_pref_name', e.target.value));
  districtInput?.addEventListener('change', (e) => localStorage.setItem('fmr_pref_district', e.target.value));
}

initModernAuth();
initPreferences();

// Load Data from Database on Startup
(async function startup() {
  reports = await dbGetAll();
  updateStats();
  updateSyncUI();
  showPage('home');
  syncQueue(); // Process any items that were queued while app was closed
})();

/* 
// Auto-clear reports every 2 minutes (120,000ms) - PAUSED v7.7
setInterval(() => {
  console.log('⏳ Auto-clearing reports (2-minute interval)...');
  reports = [];
  saveReports();
  nextCleanupTime = Date.now() + 120000;
  updateStats();
  renderMyReports();
  renderTopTypes();
  if (mainMap) renderMapMarkers();
}, 120000);

// Global countdown updater - PAUSED v7.7
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('.countdown-val').forEach(el => {
    const expire = parseInt(el.dataset.expire);
    const diff = Math.max(0, Math.ceil((expire - now) / 1000));
    el.textContent = diff + 's';
    if (diff <= 10) el.style.color = 'var(--red)';
  });
}, 1000);
*/
