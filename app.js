/* FixMyRoad BN — app.js */
'use strict';

// ───────────────────────────────────────────────
// STATE
// ───────────────────────────────────────────────
let reports = JSON.parse(localStorage.getItem('fixmyroad_reports') || '[]');
let mainMap = null;
let pickedLat = null, pickedLng = null;
let mainMarkers = [];
let gpsLat = null, gpsLng = null;
let photoDataUrl = null;

// Demo seed data
const DEMO = [
  { id: 'd1', name: 'Ahmad Haji',  type: 'Pothole',             severity: 'High',     district: 'Brunei-Muara', location: 'Jalan Tutong near Hua Ho', lat: 4.9031, lng: 114.9398, desc: 'Large pothole causing tyre damage.', status: 'Pending',   timestamp: '2026-04-20T08:30:00.000Z', date: '2026-04-20' },
  { id: 'd2', name: 'Siti Nur',    type: 'Broken Signage',      severity: 'Medium',   district: 'Belait',       location: 'Jalan Seria Lama',         lat: 4.6072, lng: 114.3265, desc: 'Stop sign knocked down.',           status: 'In Review', timestamp: '2026-04-18T14:15:00.000Z', date: '2026-04-18' },
  { id: 'd3', name: 'Anonymous',   type: 'Faded Road Markings', severity: 'Low',      district: 'Tutong',       location: 'Jalan Tutong Pekan',        lat: 4.8026, lng: 114.6497, desc: 'Lane markings barely visible.',     status: 'Resolved',  timestamp: '2026-04-15T09:00:00.000Z', date: '2026-04-15' },
  { id: 'd4', name: 'Haziq',       type: 'Damaged Drain Cover', severity: 'Critical', district: 'Brunei-Muara', location: 'Simpang 88 Gadong',         lat: 4.9200, lng: 114.9280, desc: 'Missing drain cover — hazard!',     status: 'Pending',   timestamp: '2026-04-21T11:45:00.000Z', date: '2026-04-21' },
];

function allReports() { return [...DEMO, ...reports]; }
function saveReports() { localStorage.setItem('fixmyroad_reports', JSON.stringify(reports)); }

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
        mainMap.setView([centerCoords.lat, centerCoords.lng], 16);
      }, 200);
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
  document.getElementById('stat-total').textContent = all.length;
  document.getElementById('stat-pending').textContent = all.filter(r => r.status === 'Pending').length;
  document.getElementById('stat-progress').textContent = all.filter(r => r.status === 'In Progress').length;
  document.getElementById('stat-resolved').textContent = all.filter(r => r.status === 'Resolved').length;
}

// ───────────────────────────────────────────────
// MY REPORTS & ADMIN
// ───────────────────────────────────────────────
function renderMyReports() {
  const container = document.getElementById('my-reports-list');
  const userReports = reports; // In this app, 'reports' is the localStorage array

  if (userReports.length === 0) {
    container.innerHTML = '<p class="empty-list">You haven\'t submitted any reports yet.</p>';
    return;
  }

  container.innerHTML = userReports.slice().reverse().map(r => `
    <div class="my-report-card">
      <div class="mrc-info">
        <h4>${typeEmoji(r.type)} ${r.type}</h4>
        <p>📍 ${r.location}</p>
        <p>🕒 ${r.date}</p>
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
        `}
      </div>
    </div>
  `).join('');
}

window.updateReportStatus = function(id, newStatus) {
  const reportIndex = reports.findIndex(r => r.id === id);
  if (reportIndex !== -1) {
    reports[reportIndex].status = newStatus;
    saveReports();
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
document.getElementById('hero-report-btn').addEventListener('click', () => showPage('report'));
document.getElementById('hero-map-btn').addEventListener('click', () => showPage('map'));
document.getElementById('cta-report-btn').addEventListener('click', () => showPage('report'));
document.getElementById('nav-toggle').addEventListener('click', () => {
  document.getElementById('nav-links').classList.toggle('open');
});
window.addEventListener('scroll', () => {
  document.getElementById('navbar').classList.toggle('scrolled', window.scrollY > 10);
});

// ───────────────────────────────────────────────
// STATS
// ───────────────────────────────────────────────
function updateStats() {
  const all = allReports();
  document.getElementById('stat-total').textContent = all.length;
  document.getElementById('stat-pending').textContent = all.filter(r => r.status === 'Pending').length;
  document.getElementById('stat-resolved').textContent = all.filter(r => r.status === 'Resolved').length;
}
updateStats();

// ───────────────────────────────────────────────
// GPS CAPTURE
// ───────────────────────────────────────────────
const gpsBtn   = document.getElementById('gps-btn');
const gpsDot   = document.getElementById('gps-dot');
const gpsLabel = document.getElementById('gps-label');
const gpsCoordsEl = document.getElementById('gps-coords');

function setGpsState(state, message) {
  gpsDot.className = 'gps-dot gps-' + state;
  gpsLabel.textContent = message;
}

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

      setGpsState('success', `Location captured (±${acc}m accuracy)`);
      gpsCoordsEl.textContent = `Lat: ${gpsLat.toFixed(6)}  |  Lng: ${gpsLng.toFixed(6)}`;

      gpsBtn.textContent = '🔄 Re-capture';
      gpsBtn.disabled = false;

      // Update picks
      pickedLat = gpsLat;
      pickedLng = gpsLng;
    },
    (err) => {
      const msgs = {
        1: 'Permission denied. Please allow location access.',
        2: 'Position unavailable. Try again.',
        3: 'Timed out. Move to a better signal area.',
      };
      setGpsState('error', msgs[err.code] || 'Location error. Try again.');
      gpsCoordsEl.textContent = '';
      gpsBtn.textContent = '📡 Retry Location';
      gpsBtn.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
});



// ───────────────────────────────────────────────
// MAIN MAP (Map Page)
// ───────────────────────────────────────────────
function initMainMap() {
  if (!mainMap) {
    document.getElementById('main-map-loading').classList.remove('loader-hidden');
    mainMap = L.map('main-map', { zoomControl: true }).setView([4.5353, 114.7277], 10);
    const layer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20
    }).addTo(mainMap);

    layer.on('load', () => {
      document.getElementById('main-map-loading').classList.add('loader-hidden');
    });

    layer.on('load', () => {
      document.getElementById('main-map-loading').classList.add('loader-hidden');
    });
  }
  setTimeout(() => mainMap.invalidateSize(), 100);
  renderMapMarkers();
}

// Collapsible logic
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

  // Mobile auto-collapse
  if (window.innerWidth < 768) {
    const f = document.getElementById('toggle-filters');
    const l = document.getElementById('toggle-legend');
    if (f) f.parentElement.classList.add('collapsed');
    if (l) l.parentElement.classList.add('collapsed');
  }
}
initToggles();

function statusColor(status) {
  if (status === 'Resolved') return '#22C55E';
  if (status === 'Acknowledged') return '#3B82F6';
  if (status === 'In Progress') return '#F97316';
  return '#F5C400';
}

function markerIcon(status, severity) {
  let bg;
  if (severity === 'Critical') bg = '#a855f7';
  else if (severity === 'High') bg = '#EF4444';
  else if (severity === 'Medium') bg = '#F5C400';
  else bg = '#22C55E';

  let ringColor;
  if (status === 'Resolved') ringColor = '#22C55E';
  else if (status === 'In Review') ringColor = '#FF8C00';
  else ringColor = '#F5C400';

  const size = severity === 'Critical' ? 24 : 18;
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};border:2px solid #fff;box-shadow:0 0 0 2px ${ringColor}, 0 2px 8px rgba(0,0,0,0.5)"></div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -14],
  });
}

function renderMapMarkers(filterStatus = 'all', filterType = 'all', filterDistrict = 'all', filterSeverity = 'all') {
  mainMarkers.forEach(m => m.remove());
  mainMarkers = [];

  allReports()
    .filter(r => {
      if (filterStatus !== 'all' && r.status !== filterStatus) return false;
      if (filterType !== 'all' && r.type !== filterType) return false;
      if (filterDistrict !== 'all' && r.district !== filterDistrict) return false;
      if (filterSeverity !== 'all' && r.severity !== filterSeverity) return false;
      return r.lat && r.lng;
    })
    .forEach(r => {
      const m = L.marker([r.lat, r.lng], { icon: markerIcon(r.status, r.severity) }).addTo(mainMap);
      m.bindPopup(`
        <div class="popup-header">
          <div class="popup-type-icon">${typeEmoji(r.type)}</div>
          <div>
            <div class="popup-title">${r.type}</div>
            <div class="popup-subtitle">📍 ${r.location}, ${r.district}</div>
          </div>
        </div>
        <div class="popup-badges">
          <span class="popup-badge badge-sev-${r.severity}">${r.severity}</span>
          <span class="popup-badge badge-status st-${r.status}">${r.status}</span>
        </div>
        ${r.desc ? `<div class="popup-desc">${r.desc}</div>` : ''}
        <div class="popup-meta">
          <span>🕒 Reported: ${formatTimestamp(r.timestamp || r.date)}</span>
          <span>👤 ${r.name || 'Anonymous'}</span>
        </div>
        ${r.photo ? `<img src="${r.photo}" class="popup-photo" alt="Damage photo"/>` : ''}
      `);
      mainMarkers.push(m);
    });
}

// ───────────────────────────────────────────────
// REPORT LIST SIDEBAR
// ───────────────────────────────────────────────
function typeEmoji(type) {
  const map = {
    'Pothole': '🕳️',
    'Broken Signage': '⚠️',
    'Damaged Drain Cover': '🔩',
    'Faded Road Markings': '🛤️',
    'Other': '❓',
    // legacy demo types
    'Road Crack': '⚡', 'Flooding': '💧', 'Road Collapse': '🚧', 'Debris': '🪨', 'Signal Damage': '🚦',
  };
  return map[type] || '⚠️';
}

function formatTimestamp(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('en-BN', { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return ts; }
}

function renderReportList(filterStatus = 'all', filterType = 'all', filterDistrict = 'all', filterSeverity = 'all') {
  const list = document.getElementById('report-list');
  const all = allReports().filter(r => {
    if (filterStatus !== 'all' && r.status !== filterStatus) return false;
    if (filterType !== 'all' && r.type !== filterType) return false;
    if (filterDistrict !== 'all' && r.district !== filterDistrict) return false;
    if (filterSeverity !== 'all' && r.severity !== filterSeverity) return false;
    return true;
  });

  document.getElementById('report-count').textContent = all.length;
  
  // Update stats bar
  const pending = all.filter(r => r.status === 'Pending').length;
  const critical = all.filter(r => r.severity === 'Critical').length;
  document.getElementById('map-stats-bar').innerHTML = `
    <span class="msb-chip msb-pending">${pending} Pending</span>
    ${critical > 0 ? `<span class="msb-chip msb-critical">${critical} Critical</span>` : ''}
  `;

  if (!all.length) {
    list.innerHTML = '<p class="empty-list">No reports match filters.</p>';
    return;
  }

  list.innerHTML = all.slice().reverse().map(r => `
    <div class="report-list-item" data-lat="${r.lat}" data-lng="${r.lng}">
      <div class="rli-header">
        <span class="rli-type">${typeEmoji(r.type)} ${r.type}</span>
        <span class="rli-status status-${r.status}">${r.status}</span>
      </div>
      <div class="rli-loc">📍 ${r.location}</div>
      <div class="rli-date">${r.district} · ${r.severity} · ${r.date || ''}</div>
    </div>
  `).join('');

  list.querySelectorAll('.report-list-item').forEach(item => {
    item.addEventListener('click', () => {
      const lat = parseFloat(item.dataset.lat);
      const lng = parseFloat(item.dataset.lng);
      if (lat && lng) mainMap.setView([lat, lng], 16);
    });
  });
}

// Filters
function applyFilters() {
  const fs = document.getElementById('filter-status').value;
  const ft = document.getElementById('filter-type').value;
  const fd = document.getElementById('filter-district').value;
  const fsv = document.getElementById('filter-severity').value;
  renderReportList(fs, ft, fd, fsv);
  renderMapMarkers(fs, ft, fd, fsv);
}
['filter-status', 'filter-type', 'filter-district', 'filter-severity'].forEach(id => {
  document.getElementById(id).addEventListener('change', applyFilters);
});
document.getElementById('reset-filters').addEventListener('click', () => {
  document.getElementById('filter-status').value = 'all';
  document.getElementById('filter-type').value = 'all';
  document.getElementById('filter-district').value = 'all';
  document.getElementById('filter-severity').value = 'all';
  applyFilters();
});

// ───────────────────────────────────────────────
// PHOTO UPLOAD
// ───────────────────────────────────────────────
document.getElementById('report-photo').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;

  if (file.size > 10 * 1024 * 1024) {
    alert('Photo is too large (max 10MB). Please choose a smaller image.');
    this.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    photoDataUrl = e.target.result;
    document.getElementById('photo-preview').src = photoDataUrl;
    document.getElementById('photo-preview-wrap').style.display = 'block';
    document.getElementById('file-upload-inner').style.display = 'none';
  };
  reader.readAsDataURL(file);
});

document.getElementById('photo-remove').addEventListener('click', () => {
  photoDataUrl = null;
  document.getElementById('report-photo').value = '';
  document.getElementById('photo-preview').src = '';
  document.getElementById('photo-preview-wrap').style.display = 'none';
  document.getElementById('file-upload-inner').style.display = 'flex';
});

// ───────────────────────────────────────────────
// REPORT FORM SUBMIT
// ───────────────────────────────────────────────
document.getElementById('report-form').addEventListener('submit', function (e) {
  e.preventDefault();
  if (!validateForm()) return;

  const now = new Date();
  const uid = 'FMR-' + now.getFullYear()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0')
    + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();

  // Prefer GPS > map click > district centre
  const finalLat = pickedLat || districtCenter(document.getElementById('report-district').value).lat;
  const finalLng = pickedLng || districtCenter(document.getElementById('report-district').value).lng;

  const report = {
    id: uid,
    timestamp: now.toISOString(),
    date: now.toISOString().slice(0, 10),
    name: document.getElementById('report-name').value.trim() || 'Anonymous',
    type: document.getElementById('report-type').value,
    severity: document.querySelector('input[name="severity"]:checked')?.value || 'Medium',
    district: document.getElementById('report-district').value,
    location: document.getElementById('report-location').value.trim(),
    lat: finalLat,
    lng: finalLng,
    gpsLat: gpsLat,
    gpsLng: gpsLng,
    desc: document.getElementById('report-desc').value.trim(),
    photo: photoDataUrl || null,
    status: 'Pending',
  };

  reports.push(report);
  saveReports();
  updateStats();

  // Show success animation
  const overlay = document.getElementById('submit-success-overlay');
  overlay.style.display = 'flex';

  setTimeout(() => {
    overlay.style.display = 'none';
    resetForm();
    showPage('map', { lat: report.lat, lng: report.lng });
  }, 1800);
});

function validateForm() {
  let valid = true;
  const required = ['report-type', 'report-district', 'report-location'];
  required.forEach(id => {
    const el = document.getElementById(id);
    if (!el.value.trim()) {
      el.style.borderColor = '#EF4444';
      el.style.boxShadow = '0 0 0 3px rgba(239,68,68,0.15)';
      setTimeout(() => { el.style.borderColor = ''; el.style.boxShadow = ''; }, 2500);
      valid = false;
    }
  });
  if (!valid) {
    // Scroll to first error
    document.querySelector('.report-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  return valid;
}

function resetForm() {
  document.getElementById('report-form').reset();
  pickedLat = null; pickedLng = null;
  gpsLat = null; gpsLng = null;
  photoDataUrl = null;

  document.getElementById('gps-coords').textContent = '';
  setGpsState('idle', 'Location not captured yet');
  document.getElementById('gps-btn').textContent = '📡 Capture My Location';
  document.getElementById('gps-btn').disabled = false;

  document.getElementById('photo-preview').src = '';
  document.getElementById('photo-preview-wrap').style.display = 'none';
  document.getElementById('file-upload-inner').style.display = 'flex';
}

function districtCenter(district) {
  const centers = {
    'Brunei-Muara': { lat: 4.9031, lng: 114.9398 },
    'Belait':       { lat: 4.6072, lng: 114.3265 },
    'Tutong':       { lat: 4.8026, lng: 114.6497 },
    'Temburong':    { lat: 4.6200, lng: 115.1450 },
  };
  return centers[district] || { lat: 4.5353, lng: 114.7277 };
}

// Success modal buttons
document.getElementById('view-map-btn').addEventListener('click', () => {
  document.getElementById('success-modal').classList.remove('show');
  showPage('map');
});
document.getElementById('new-report-btn').addEventListener('click', () => {
  document.getElementById('success-modal').classList.remove('show');
});

// ───────────────────────────────────────────────
// INIT
// ───────────────────────────────────────────────
showPage('home');
