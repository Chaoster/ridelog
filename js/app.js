// ===== Shared Utilities =====

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// Highlight active nav item based on current page
function highlightNav() {
  const path = window.location.pathname;
  const page = path.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-item').forEach(item => {
    const href = item.getAttribute('href') || item.dataset.page;
    if (href === page || (page === '' && href === 'index.html')) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
}

// Fullscreen image viewer
function initFullscreenViewer() {
  const overlay = document.createElement('div');
  overlay.className = 'fullscreen-overlay';
  overlay.innerHTML = '<button class="close-fullscreen">&times;</button><img src="" alt="">';
  document.body.appendChild(overlay);

  const img = overlay.querySelector('img');
  const closeBtn = overlay.querySelector('.close-fullscreen');

  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-fullscreen]');
    if (target) {
      img.src = target.dataset.fullscreen || target.src;
      overlay.classList.add('active');
    }
  });

  closeBtn.addEventListener('click', () => overlay.classList.remove('active'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('active');
  });
}

// LocalStorage helpers
const storage = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      console.error('Storage set failed:', e);
      return false;
    }
  },
};

// Sample data for demo (empty - only user journeys shown)
const SAMPLE_JOURNEYS = [];

// Init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    highlightNav();
    initFullscreenViewer();
  });
} else {
  highlightNav();
  initFullscreenViewer();
}

// GPX parser (simple)
function parseGPX(gpxText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(gpxText, 'text/xml');
  const points = [];
  doc.querySelectorAll('trkpt').forEach(pt => {
    points.push([
      parseFloat(pt.getAttribute('lat')),
      parseFloat(pt.getAttribute('lon'))
    ]);
  });
  return points;
}

// Photo EXIF GPS reader
async function getPhotoGPS(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const view = new DataView(e.target.result);
      // Simple JPEG EXIF parser
      let offset = 2;
      while (offset < view.byteLength) {
        if (view.getUint16(offset) === 0xFFE1) {
          const exifOffset = offset + 4 + 6;
          // Simplified - in real app use exif-js library
          resolve({ lat: null, lng: null });
          return;
        }
        offset++;
      }
      resolve({ lat: null, lng: null });
    };
    reader.readAsArrayBuffer(file.slice(0, 65536));
  });
}
