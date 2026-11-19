/* Lightweight SVG map component (no external tiles — works offline & in sandbox).
 * Projects WGS84 → local plane around the city centre, supports markers,
 * polylines, click-to-pick, drag/zoom, and live marker updates.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

export class MapView {
  constructor(container, { center = { lat: 50.4501, lng: 30.5234 }, zoom = 1, onPick = null } = {}) {
    this.container = container;
    this.center = { ...center };
    this.zoom = zoom;
    this.onPick = onPick;
    this.markers = new Map();
    this.route = [];
    this.width = 1000;
    this.height = 1000;

    container.innerHTML = `
      <div class="map-wrap" style="width:100%;height:100%">
        <svg class="map-svg" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Мапа">
          <defs>
            <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
              <path d="M50 0 L0 0 0 50" fill="none" stroke="#182029" stroke-width="1"/>
            </pattern>
            <filter id="glow"><feGaussianBlur stdDeviation="6" result="b"/><feMerge>
              <feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          </defs>
          <rect width="1000" height="1000" fill="#0d1218"/>
          <g id="blocks"></g>
          <rect width="1000" height="1000" fill="url(#grid)" opacity=".85"/>
          <g id="zones"></g>
          <g id="route"></g>
          <g id="markers"></g>
        </svg>
        <div class="map-hint" data-hint>Клік по мапі — вибір точки</div>
      </div>`;

    this.svg = container.querySelector('svg');
    this.layers = {
      blocks: container.querySelector('#blocks'),
      zones: container.querySelector('#zones'),
      route: container.querySelector('#route'),
      markers: container.querySelector('#markers'),
    };
    this.hint = container.querySelector('[data-hint]');
    this.drawBlocks();
    this.bindEvents();
    this.render();
  }

  /* ------------------------------------------------------------- projection */
  project(point) {
    const scale = 820 / this.zoom; // metres→px-ish factor tuned for city scale
    const latScale = 111_320;
    const lngScale = 111_320 * Math.cos((this.center.lat * Math.PI) / 180);
    const dx = ((point.lng - this.center.lng) * lngScale) / scale * 100; // → 0..1000 space
    const dy = ((this.center.lat - point.lat) * latScale) / scale * 100;
    return { x: 500 + dx, y: 500 + dy };
  }

  unproject(x, y) {
    const scale = 820 / this.zoom;
    const latScale = 111_320;
    const lngScale = 111_320 * Math.cos((this.center.lat * Math.PI) / 180);
    return {
      lat: this.center.lat - ((y - 500) / 100) * scale / latScale,
      lng: this.center.lng + ((x - 500) / 100) * scale / lngScale,
    };
  }

  /* ----------------------------------------------------------------- canvas */
  drawBlocks() {
    // pseudo street network: deterministic lines so the map looks like a city
    const lines = [];
    const seedRand = (seed) => {
      let s = seed;
      return () => {
        s = (s * 9301 + 49297) % 233280;
        return s / 233280;
      };
    };
    const rand = seedRand(42);
    for (let i = 0; i < 22; i++) {
      const y = 40 + i * 44 + rand() * 8;
      lines.push(`<path d="M0 ${y} L1000 ${y + rand() * 14 - 7}" stroke="#151d26" stroke-width="${rand() > .7 ? 7 : 3}" fill="none"/>`);
    }
    for (let i = 0; i < 18; i++) {
      const x = 40 + i * 54 + rand() * 10;
      lines.push(`<path d="M${x} 0 L${x + rand() * 16 - 8} 1000" stroke="#151d26" stroke-width="${rand() > .7 ? 7 : 3}" fill="none"/>`);
    }
    // a river-ish curve
    lines.push(`<path d="M-20 780 C 220 700, 380 860, 620 760 S 900 640, 1040 700" stroke="#12212b" stroke-width="34" fill="none" stroke-linecap="round"/>`);
    this.layers.blocks.innerHTML = lines.join('');
  }

  bindEvents() {
    this.svg.addEventListener('click', (event) => {
      if (this.dragged) { this.dragged = false; return; }
      if (!this.onPick) return;
      const rect = this.svg.getBoundingClientRect();
      // account for preserveAspectRatio="slice"
      const scale = Math.max(rect.width, rect.height) / 1000;
      const offsetX = (rect.width - 1000 * scale) / 2;
      const offsetY = (rect.height - 1000 * scale) / 2;
      const x = (event.clientX - rect.left - offsetX) / scale;
      const y = (event.clientY - rect.top - offsetY) / scale;
      this.onPick(this.unproject(x, y));
    });

    let start = null;
    this.svg.addEventListener('pointerdown', (event) => {
      start = { x: event.clientX, y: event.clientY, center: { ...this.center } };
      this.dragged = false;
    });
    this.svg.addEventListener('pointermove', (event) => {
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) < 4) return;
      this.dragged = true;
      const scale = 820 / this.zoom;
      const metresPerPx = scale * 3.4;
      this.center = {
        lat: start.center.lat + (dy * metresPerPx) / 111_320,
        lng: start.center.lng - (dx * metresPerPx) / (111_320 * Math.cos((this.center.lat * Math.PI) / 180)),
      };
      this.render();
    });
    const stop = () => { start = null; };
    this.svg.addEventListener('pointerup', stop);
    this.svg.addEventListener('pointerleave', stop);
    this.svg.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.shiftKey) return;
      event.preventDefault();
      this.zoom = Math.min(6, Math.max(0.4, this.zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
      this.render();
    }, { passive: false });
  }

  setCenter(lat, lng) {
    this.center = { lat, lng };
    this.render();
    return this;
  }

  setZoom(zoom) {
    this.zoom = Math.min(6, Math.max(0.4, zoom));
    this.render();
    return this;
  }

  setHint(text) {
    this.hint.textContent = text;
    return this;
  }

  /** markers: [{ id, lat, lng, kind, label, tone }] kind: pickup|dropoff|stop|driver|car */
  setMarkers(list) {
    this.markers = new Map(list.filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng)).map((m) => [m.id, m]));
    this.renderMarkers();
    return this;
  }

  upsertMarker(marker) {
    if (!marker || !Number.isFinite(marker.lat)) return this;
    this.markers.set(marker.id, marker);
    this.renderMarkers();
    return this;
  }

  setRoute(points) {
    this.route = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    this.renderRoute();
    return this;
  }

  fit(points, padding = 1.35) {
    const list = (points || []).filter((p) => Number.isFinite(p?.lat));
    if (!list.length) return this;
    const lats = list.map((p) => p.lat);
    const lngs = list.map((p) => p.lng);
    this.center = {
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
      lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    };
    const latSpanM = Math.max((Math.max(...lats) - Math.min(...lats)) * 111_320, 600);
    const lngSpanM = Math.max(
      (Math.max(...lngs) - Math.min(...lngs)) * 111_320 * Math.cos((this.center.lat * Math.PI) / 180), 600,
    );
    // "slice" cropping: only part of the 1000×1000 viewBox is visible
    const rect = this.container.getBoundingClientRect();
    const w = rect.width || 400;
    const h = rect.height || 240;
    const visibleX = 1000 * Math.min(1, w / h);
    const visibleY = 1000 * Math.min(1, h / w);
    const metresPerUnit = 8.2; // 1/zoom is applied below
    const zoomForLat = (visibleY * 0.78 * metresPerUnit) / (latSpanM * padding);
    const zoomForLng = (visibleX * 0.78 * metresPerUnit) / (lngSpanM * padding);
    this.zoom = Math.min(4, Math.max(0.45, Math.min(zoomForLat, zoomForLng)));
    this.render();
    return this;
  }

  render() {
    this.renderRoute();
    this.renderMarkers();
    return this;
  }

  renderRoute() {
    if (!this.layers) return;
    if (this.route.length < 2) { this.layers.route.innerHTML = ''; return; }
    const pts = this.route.map((p) => this.project(p));
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    this.layers.route.innerHTML = `
      <path d="${d}" stroke="#0b0e13" stroke-width="13" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity=".7"/>
      <path d="${d}" stroke="#c8ff3d" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="18 10"/>`;
  }

  renderMarkers() {
    if (!this.layers) return;
    const tone = { pickup: '#c8ff3d', dropoff: '#7c5cff', stop: '#ffb545', driver: '#2ee6a8', car: '#2ee6a8' };
    const html = [];
    for (const marker of this.markers.values()) {
      const { x, y } = this.project(marker);
      if (x < -60 || y < -60 || x > 1060 || y > 1060) continue;
      const color = marker.color || tone[marker.kind] || '#c8ff3d';
      if (marker.kind === 'driver' || marker.kind === 'car') {
        html.push(`
          <g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})" filter="url(#glow)">
            <circle r="17" fill="${color}" opacity=".18"/>
            <circle r="9" fill="${color}"/>
            <circle r="3.4" fill="#0b0e13"/>
          </g>`);
      } else {
        html.push(`
          <g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
            <circle r="18" fill="${color}" opacity=".16"/>
            <circle r="10" fill="${color}" stroke="#0b0e13" stroke-width="2"/>
            <circle r="3.6" fill="#0b0e13"/>
          </g>`);
      }
      if (marker.label) {
        html.push(`<text x="${(x + 16).toFixed(1)}" y="${(y + 5).toFixed(1)}" fill="#eef2f7" font-size="17"
          font-family="system-ui,sans-serif" opacity=".92">${String(marker.label).replace(/[<>&]/g, '')}</text>`);
      }
    }
    this.layers.markers.innerHTML = html.join('');
  }

  setZones(polygons = []) {
    if (!this.layers) return this;
    this.layers.zones.innerHTML = polygons.map((poly) => {
      const d = poly.points.map((p, i) => {
        const { x, y } = this.project(p);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(' ') + ' Z';
      return `<path d="${d}" fill="${poly.color || '#7c5cff'}" opacity="${poly.opacity ?? 0.12}"
        stroke="${poly.color || '#7c5cff'}" stroke-width="2" stroke-dasharray="10 8"/>`;
    }).join('');
    return this;
  }
}
