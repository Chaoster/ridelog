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

// Convert a data URL (e.g. canvas.toDataURL) to a Blob for uploading
async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}


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
    const eleEl = pt.querySelector('ele');
    const p = [
      parseFloat(pt.getAttribute('lat')),
      parseFloat(pt.getAttribute('lon'))
    ];
    if (eleEl) {
      p.push(parseFloat(eleEl.textContent));
    }
    points.push(p);
  });
  return points;
}

// Photo EXIF GPS reader — reads JPEG EXIF GPS lat/lng
async function getPhotoGPS(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const buf = e.target.result;
      const view = new DataView(buf);

      // Check JPEG SOI marker
      if (view.getUint16(0) !== 0xFFD8) {
        resolve({ lat: null, lng: null });
        return;
      }

      // Find APP1 (EXIF) segment
      let offset = 2;
      while (offset < view.byteLength - 4) {
        const marker = view.getUint16(offset);
        if (marker === 0xFFD9 || marker === 0xFFD8) break;
        const len = view.getUint16(offset + 2);
        if (marker === 0xFFE1) {
          // Check "Exif\0\0" header (at offset+4, after APP1 marker+length)
          const header = String.fromCharCode(
            view.getUint8(offset + 4), view.getUint8(offset + 5),
            view.getUint8(offset + 6), view.getUint8(offset + 7),
            view.getUint8(offset + 8), view.getUint8(offset + 9)
          );
          if (header === 'Exif\0\0') {
            const tiffStart = offset + 4 + 6;
            const gps = parseExifGPS(view, tiffStart);
            resolve(gps);
            return;
          }
        }
        offset += 2 + len;
      }
      resolve({ lat: null, lng: null });
    };
    // EXIF data is always near the start; 256KB is more than enough
    reader.readAsArrayBuffer(file.slice(0, 262144));
  });
}

// Parse TIFF EXIF to extract GPS lat/lng
function parseExifGPS(view, tiffStart) {
  const isLE = view.getUint16(tiffStart) === 0x4949; // "II" little-endian
  const firstIFD = view.getUint32(tiffStart + 4, isLE);

  function readIFDEntries(ifdOffset) {
    const count = view.getUint16(tiffStart + ifdOffset, isLE);
    const entries = [];
    for (let i = 0; i < count; i++) {
      const entryOff = tiffStart + ifdOffset + 2 + i * 12;
      entries.push({
        tag: view.getUint16(entryOff, isLE),
        type: view.getUint16(entryOff + 2, isLE),
        count: view.getUint32(entryOff + 4, isLE),
        valueOff: view.getUint32(entryOff + 8, isLE),
        entryOff: entryOff
      });
    }
    return entries;
  }

  function readRational(off) {
    const num = view.getUint32(tiffStart + off, isLE);
    const den = view.getUint32(tiffStart + off + 4, isLE);
    return den === 0 ? 0 : num / den;
  }

  function parseDegrees(entry) {
    // GPSLatitude/GPSLongitude: 3 rationals (deg, min, sec) starting at entry.valueOff
    const degs = readRational(entry.valueOff);
    const mins = readRational(entry.valueOff + 8);
    const secs = readRational(entry.valueOff + 16);
    return degs + mins / 60 + secs / 3600;
  }

  // Walk IFD0 chain to find GPS IFD pointer (tag 0x8825)
  let ifdOffset = firstIFD;
  while (ifdOffset !== 0) {
    const entries = readIFDEntries(ifdOffset);
    let gpsIFDOffset = null;
    for (const e of entries) {
      if (e.tag === 0x8825) {
        gpsIFDOffset = e.valueOff;
        break;
      }
    }

    if (gpsIFDOffset !== null) {
      const gpsEntries = readIFDEntries(gpsIFDOffset);
      let latRef = 'N', lngRef = 'E';
      let latVals = null, lngVals = null;
      for (const e of gpsEntries) {
        if (e.tag === 0x0001) latRef = String.fromCharCode(view.getUint8(e.entryOff + 8));
        if (e.tag === 0x0002) latVals = e;
        if (e.tag === 0x0003) lngRef = String.fromCharCode(view.getUint8(e.entryOff + 8));
        if (e.tag === 0x0004) lngVals = e;
      }
      if (latVals && lngVals) {
        let lat = parseDegrees(latVals);
        let lng = parseDegrees(lngVals);
        if (latRef === 'S') lat = -lat;
        if (lngRef === 'W') lng = -lng;
        return { lat, lng };
      }
    }

    // Next IFD offset is 4 bytes after last entry
    const nextIFDOff = tiffStart + ifdOffset + 2 + entries.length * 12;
    if (nextIFDOff + 4 > view.byteLength) break;
    const nextIFD = view.getUint32(nextIFDOff, isLE);
    if (nextIFD === ifdOffset || nextIFD === 0) break;
    ifdOffset = nextIFD;
  }

  return { lat: null, lng: null };
}
