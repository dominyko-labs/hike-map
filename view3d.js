// 3D terrain view: elevation from the AWS Open Data terrain tiles (Terrarium PNGs, Mapzen/Tilezen),
// the current map tiles draped over it, one tube per day and a walker sphere driven by the timeline.
// Loaded on demand by index.html; three.js is vendored under vendor/three (import map: "three").
import * as THREE from 'three';
import { MapControls } from './vendor/three/MapControls.js';
import { Line2 } from './vendor/three/lines/Line2.js';
import { LineGeometry } from './vendor/three/lines/LineGeometry.js';
import { LineMaterial } from './vendor/three/lines/LineMaterial.js';

const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const MAX_TILES = 36;          // terrain tiles per scene (6 x 6 at most)
const STEP = 4;                // sample every 4th DEM pixel: 65 x 65 vertices per tile
const SKIRT_M = 250;           // the block is cut SKIRT_M below its lowest point, with textured sides
const EXAG = 1.25;             // vertical exaggeration
const TRACK_LIFT = 12;         // metres above the surface for tubes and spheres
const TILE = 256;
const DENSIFY_M = 60;          // lines get a vertex at least every 60 m so they drape over ridges

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lon2px = (lon, z) => (lon + 180) / 360 * Math.pow(2, z) * TILE;
const lat2px = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z) * TILE; };
const px2lon = (x, z) => x / (Math.pow(2, z) * TILE) * 360 - 180;
const px2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / (Math.pow(2, z) * TILE); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('tile ' + url));
    img.src = url;
  });
}
function tileUrl(template, z, x, y) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'abc'[(x + y) % 3]);
}
// Pick the zoom whose tile block over the bounds has at most MAX_TILES tiles.
function pickBlock(bounds) {
  for (let z = 14; z >= 6; z--) {
    const x0 = Math.floor(lon2px(bounds.west, z) / TILE), x1 = Math.floor(lon2px(bounds.east, z) / TILE);
    const y0 = Math.floor(lat2px(bounds.north, z) / TILE), y1 = Math.floor(lat2px(bounds.south, z) / TILE);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES) return { z, x0, y0, nx: x1 - x0 + 1, ny: y1 - y0 + 1 };
  }
  return null;
}

export async function build(opts) {
  const { container, bounds, days, links = [], huts = [], textureUrl, onProgress = () => {} } = opts;
  const blk = pickBlock(bounds);
  if (!blk) throw new Error('area too large');
  const W = blk.nx * TILE, H = blk.ny * TILE;

  // ---- elevation: one big canvas of terrain tiles, decoded to metres ----
  const demCanvas = document.createElement('canvas'); demCanvas.width = W; demCanvas.height = H;
  const demCtx = demCanvas.getContext('2d', { willReadFrequently: true });
  let done = 0, missing = 0; const total = blk.nx * blk.ny;
  await Promise.all(Array.from({ length: total }, (_, i) => {
    const tx = blk.x0 + (i % blk.nx), ty = blk.y0 + Math.floor(i / blk.nx);
    return loadImage(tileUrl(TERRAIN_URL, blk.z, tx, ty))
      .then(img => demCtx.drawImage(img, (tx - blk.x0) * TILE, (ty - blk.y0) * TILE))
      .catch(() => { missing++; })
      .then(() => onProgress('3D: terrain tiles', ++done, total));
  }));
  if (missing === total) throw new Error('no terrain tiles could be loaded');
  const px = demCtx.getImageData(0, 0, W, H).data;
  const heights = new Float32Array(W * H);
  for (let i = 0, j = 0; i < heights.length; i++, j += 4) heights[i] = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;

  // ---- local metric frame: x east, y up (metres * EXAG), z south ----
  const lonW = px2lon(blk.x0 * TILE, blk.z), lonE = px2lon((blk.x0 + blk.nx) * TILE, blk.z);
  const latN = px2lat(blk.y0 * TILE, blk.z), latS = px2lat((blk.y0 + blk.ny) * TILE, blk.z);
  const latC = (latN + latS) / 2, lonC = (lonW + lonE) / 2;
  const mPerLon = 111320 * Math.cos(latC * Math.PI / 180), mPerLat = 110574;
  const toLocal = (lat, lon) => ({ x: (lon - lonC) * mPerLon, z: -(lat - latC) * mPerLat });
  const pxOf = (lat, lon) => ({ x: lon2px(lon, blk.z) - blk.x0 * TILE, y: lat2px(lat, blk.z) - blk.y0 * TILE });
  const heightAt = (lat, lon) => {
    const p = pxOf(lat, lon);
    const x = clamp(p.x, 0, W - 1.001), y = clamp(p.y, 0, H - 1.001);
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const h = (xx, yy) => heights[yy * W + xx];
    return (h(x0, y0) * (1 - fx) + h(x0 + 1, y0) * fx) * (1 - fy) + (h(x0, y0 + 1) * (1 - fx) + h(x0 + 1, y0 + 1) * fx) * fy;
  };

  // ---- terrain mesh ----
  const gw = blk.nx * (TILE / STEP) + 1, gh = blk.ny * (TILE / STEP) + 1;
  const pos = new Float32Array(gw * gh * 3), uv = new Float32Array(gw * gh * 2);
  let minH = Infinity, maxH = -Infinity;
  for (let j = 0; j < gh; j++) {
    const py = Math.min(H - 1, j * STEP), lat = px2lat(blk.y0 * TILE + py, blk.z);
    for (let i = 0; i < gw; i++) {
      const pxx = Math.min(W - 1, i * STEP), lon = px2lon(blk.x0 * TILE + pxx, blk.z);
      const h = heights[py * W + pxx], l = toLocal(lat, lon), k = j * gw + i;
      pos[k * 3] = l.x; pos[k * 3 + 1] = h * EXAG; pos[k * 3 + 2] = l.z;
      uv[k * 2] = pxx / W; uv[k * 2 + 1] = 1 - py / H;
      if (h < minH) minH = h; if (h > maxH) maxH = h;
    }
  }
  // boundary ring in order (top row, right column, bottom row reversed, left column reversed)
  const ring = [];
  for (let i = 0; i < gw; i++) ring.push(i);
  for (let j = 1; j < gh; j++) ring.push(j * gw + gw - 1);
  for (let i = gw - 2; i >= 0; i--) ring.push((gh - 1) * gw + i);
  for (let j = gh - 2; j >= 1; j--) ring.push(j * gw);
  const base = gw * gh, floorY = (minH - SKIRT_M) * EXAG;
  const pos2 = new Float32Array((base + ring.length) * 3), uv2 = new Float32Array((base + ring.length) * 2);
  pos2.set(pos); uv2.set(uv);
  ring.forEach((v, r) => {
    const k = base + r;
    pos2[k * 3] = pos[v * 3]; pos2[k * 3 + 1] = floorY; pos2[k * 3 + 2] = pos[v * 3 + 2];
    uv2[k * 2] = uv[v * 2]; uv2[k * 2 + 1] = uv[v * 2 + 1];
  });
  const idx = new Uint32Array((gw - 1) * (gh - 1) * 6 + ring.length * 6);
  let k = 0;
  for (let j = 0; j < gh - 1; j++) for (let i = 0; i < gw - 1; i++) {
    const a = j * gw + i, b = a + 1, c = a + gw, d = c + 1;
    idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  for (let r = 0; r < ring.length; r++) {
    const a = ring[r], b = ring[(r + 1) % ring.length], a2 = base + r, b2 = base + (r + 1) % ring.length;
    idx[k++] = a; idx[k++] = b; idx[k++] = a2; idx[k++] = b; idx[k++] = b2; idx[k++] = a2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos2, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv2, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  // ---- texture: the map tiles, or a height tint when they cannot be read cross-origin ----
  let material, textureTiles = 0;
  try {
    const tz = blk.nx * blk.ny * 4 <= 144 ? blk.z + 1 : blk.z, scale = Math.pow(2, tz - blk.z);
    const tc = document.createElement('canvas'); tc.width = W * scale; tc.height = H * scale;
    const tctx = tc.getContext('2d');
    const jobs = [];
    for (let ty = blk.y0 * scale; ty < (blk.y0 + blk.ny) * scale; ty++) for (let tx = blk.x0 * scale; tx < (blk.x0 + blk.nx) * scale; tx++) {
      jobs.push(loadImage(tileUrl(textureUrl, tz, tx, ty)).then(img => { tctx.drawImage(img, (tx - blk.x0 * scale) * TILE, (ty - blk.y0 * scale) * TILE); textureTiles++; }).catch(() => {}));
    }
    let texDone = 0;
    onProgress('3D: map tiles', 0, jobs.length);
    await Promise.all(jobs.map(j => j.then(() => onProgress('3D: map tiles', ++texDone, jobs.length))));
    if (!textureTiles) throw new Error('no map tiles');
    tctx.getImageData(0, 0, 1, 1);                       // throws when a tile tainted the canvas
    const tex = new THREE.CanvasTexture(tc);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
    material = new THREE.MeshLambertMaterial({ map: tex });
  } catch (e) {
    const nv = pos2.length / 3, colors = new Float32Array(nv * 3);
    for (let k = 0; k < nv; k++) {
      const t = clamp((pos2[k * 3 + 1] / EXAG - minH) / Math.max(1, maxH - minH), 0, 1);
      const c = new THREE.Color().setHSL(0.33 - 0.33 * t, 0.45, 0.35 + 0.45 * t);
      colors[k * 3] = c.r; colors[k * 3 + 1] = c.g; colors[k * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    material = new THREE.MeshLambertMaterial({ vertexColors: true });
    textureTiles = 0;
  }
  const terrain = new THREE.Mesh(geo, material);

  // ---- scene ----
  const scene = new THREE.Scene();
  const sky = document.createElement('canvas'); sky.width = 2; sky.height = 256;
  const sctx = sky.getContext('2d'), grad = sctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#5a8fd0'); grad.addColorStop(0.55, '#bcd6ee'); grad.addColorStop(1, '#eef2f5');
  sctx.fillStyle = grad; sctx.fillRect(0, 0, 2, 256);
  const skyTex = new THREE.CanvasTexture(sky); skyTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyTex;
  const spanX = (lonE - lonW) * mPerLon, spanZ = (latN - latS) * mPerLat, span = Math.max(spanX, spanZ);
  scene.fog = new THREE.Fog(0xd9e4ef, span * 1.5, span * 5);
  scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x6b5a45, 0.75));
  const sun = new THREE.DirectionalLight(0xfff2dc, 1.9); sun.position.set(-0.7, 0.55, -0.5).multiplyScalar(span); scene.add(sun);   // low sun from the north-west: relief
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.35); fill.position.set(0.6, 0.8, 0.7).multiplyScalar(span); scene.add(fill);
  scene.add(terrain);

  // ---- tracks (screen-space lines: same width at any zoom), photos, walker ----
  const resolution = new THREE.Vector2(container.clientWidth, container.clientHeight);
  const lineMaterials = [];
  const densify = coords => {
    const out = [];
    for (let i = 0; i < coords.length; i++) {
      if (i) {
        const a = coords[i - 1], b = coords[i];
        const m = Math.hypot((b[1] - a[1]) * mPerLon, (b[0] - a[0]) * mPerLat), n = Math.min(400, Math.ceil(m / DENSIFY_M));
        for (let k = 1; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
      }
      out.push(coords[i]);
    }
    return out;
  };
  const dayMeshes = days.map(d => {
    if (d.coords.length < 2) return null;
    const dense = densify(d.coords), flat = [];
    dense.forEach(c => { const l = toLocal(c[0], c[1]); flat.push(l.x, (heightAt(c[0], c[1]) + TRACK_LIFT) * EXAG, l.z); });
    const lg = new LineGeometry(); lg.setPositions(flat);
    const mat = new LineMaterial({ color: new THREE.Color(d.color).getHex(), linewidth: 5, worldUnits: false, transparent: true, opacity: 1, depthTest: true });
    mat.resolution.copy(resolution); lineMaterials.push(mat);
    const mesh = new Line2(lg, mat); mesh.computeLineDistances(); scene.add(mesh);
    return { mesh, segments: dense.length - 1 };
  });
  links.forEach(coords => {
    if (coords.length < 2) return;
    const flat = [];
    densify(coords).forEach(c => { const l = toLocal(c[0], c[1]); flat.push(l.x, (heightAt(c[0], c[1]) + TRACK_LIFT) * EXAG, l.z); });
    const lg = new LineGeometry(); lg.setPositions(flat);
    const mat = new LineMaterial({ color: 0x777777, linewidth: 3, worldUnits: false, transparent: true, opacity: 0.85, dashed: true, dashSize: span * 0.004, gapSize: span * 0.004 });
    mat.resolution.copy(resolution); lineMaterials.push(mat);
    const mesh = new Line2(lg, mat); mesh.computeLineDistances(); scene.add(mesh);
  });
  const sphereR = Math.max(4, span / 900);
  const photoCount = days.reduce((a, d) => a + d.photos.length, 0);
  let photos = null;
  if (photoCount) {
    photos = new THREE.InstancedMesh(new THREE.SphereGeometry(sphereR, 10, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }), photoCount);
    const m = new THREE.Matrix4(); let n = 0;
    days.forEach(d => d.photos.forEach(p => {
      const l = toLocal(p[0], p[1]);
      m.makeTranslation(l.x, (heightAt(p[0], p[1]) + TRACK_LIFT) * EXAG, l.z);
      photos.setMatrixAt(n, m); photos.setColorAt(n, new THREE.Color(d.color)); n++;
    }));
    scene.add(photos);
  }
  // huts: a brown pin and a label sprite sized in screen pixels (sizeAttenuation off), so it never
  // dwarfs the terrain; the pixel size shrinks as the camera moves away and the label hides when
  // it would be unreadable.
  const LABEL_PX_MAX = 20, LABEL_PX_MIN = 9;
  const labelSprite = (text, bg, fg) => {
    const cv = document.createElement('canvas'), cx = cv.getContext('2d');
    cx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif';
    const w = Math.ceil(cx.measureText(text).width) + 28, h = 44; cv.width = w; cv.height = h;
    cx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif';
    cx.fillStyle = bg; cx.beginPath(); cx.roundRect(0, 0, w, h, 10); cx.fill();
    cx.fillStyle = fg; cx.textBaseline = 'middle'; cx.fillText(text, 14, h / 2 + 1);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true, sizeAttenuation: false }));
    sp.userData.aspect = w / h; sp.renderOrder = 10;
    return sp;
  };
  const hutGroup = new THREE.Group(), labels = [];
  huts.forEach(h => {
    const l = toLocal(h.lat, h.lon), y = (heightAt(h.lat, h.lon) + TRACK_LIFT) * EXAG;
    const pin = new THREE.Mesh(new THREE.ConeGeometry(sphereR * 1.6, sphereR * 5, 8), new THREE.MeshLambertMaterial({ color: 0x8b4513 }));
    pin.position.set(l.x, y + sphereR * 2.5, l.z); pin.rotation.x = Math.PI; hutGroup.add(pin);
    const lab = labelSprite(h.name, 'rgba(255,255,255,0.92)', '#3b2a14');
    lab.position.set(l.x, y + sphereR * 7, l.z); hutGroup.add(lab); labels.push(lab);
  });
  scene.add(hutGroup);
  let labelPx = [];
  // Label height in pixels for a camera at distance d: full size near the terrain, shrinking with the
  // square root of distance past a quarter of the span, hidden under LABEL_PX_MIN.
  const labelPxFor = d => Math.min(LABEL_PX_MAX, LABEL_PX_MAX * Math.sqrt(Math.max(1e-6, span * 0.25 / Math.max(1, d))));
  const updateLabels = (camera, viewW, viewH) => {
    const k = 2 * Math.tan(camera.fov * Math.PI / 360);          // NDC height per unit of unattenuated sprite scale
    labelPx = labels.map(lab => {
      const px = labelPxFor(camera.position.distanceTo(lab.position));
      lab.visible = px >= LABEL_PX_MIN;
      const sy = px / viewH * k;                                   // sprite scale.y in NDC units -> px tall
      lab.scale.set(sy * lab.userData.aspect * viewH / viewW, sy, 1);
      return lab.visible ? Math.round(px) : 0;
    });
  };
  const walker = new THREE.Mesh(new THREE.SphereGeometry(sphereR * 2.2, 14, 10), new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x444444 }));
  walker.visible = false; scene.add(walker);
  const poleH = sphereR * 14;
  const walkerPole = new THREE.Mesh(new THREE.CylinderGeometry(sphereR * 0.35, sphereR * 0.35, poleH, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  walkerPole.visible = false; scene.add(walkerPole);

  // ---- renderer, camera, controls ----
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(55, container.clientWidth / Math.max(1, container.clientHeight), 10, span * 6);
  const center = new THREE.Vector3(0, ((minH + maxH) / 2) * EXAG, 0);
  const home = new THREE.Vector3(center.x, center.y + span * 0.55, center.z + span * 0.8);
  camera.position.copy(home);
  const controls = new MapControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = false;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = span * 0.02; controls.maxDistance = span * 3;
  controls.update();
  const render = () => { updateLabels(camera, container.clientWidth, container.clientHeight); renderer.render(scene, camera); };
  controls.addEventListener('change', render);
  const onResize = () => {
    renderer.setSize(container.clientWidth, container.clientHeight);
    lineMaterials.forEach(m => m.resolution.set(container.clientWidth, container.clientHeight));
    camera.aspect = container.clientWidth / Math.max(1, container.clientHeight);
    camera.updateProjectionMatrix(); render();
  };
  window.addEventListener('resize', onResize);
  render();

  let walkerPos = null;
  return {
    // pos: null (show everything) or {day, frac (0..1 along that day's path), lat, lon}
    setProgress(pos) {
      dayMeshes.forEach((dm, i) => {
        if (!dm) return;
        const g = dm.mesh.geometry;
        if (!pos || i < pos.day) { g.instanceCount = dm.segments; dm.mesh.material.opacity = 1; }
        else if (i === pos.day) { g.instanceCount = Math.max(1, Math.round(dm.segments * clamp(pos.frac, 0, 1))); dm.mesh.material.opacity = 1; }
        else { g.instanceCount = dm.segments; dm.mesh.material.opacity = 0.25; }
      });
      if (pos) {
        const l = toLocal(pos.lat, pos.lon), y = (heightAt(pos.lat, pos.lon) + TRACK_LIFT) * EXAG;
        walker.position.set(l.x, y + poleH, l.z); walker.visible = true;
        walkerPole.position.set(l.x, y + poleH / 2, l.z); walkerPole.visible = true;
        walkerPos = { x: l.x, y: y + poleH, z: l.z };
      } else { walker.visible = false; walkerPole.visible = false; walkerPos = null; }
      render();
    },
    heightAt,
    // Back to the opening framing: whole trip in view, looking north from the south.
    resetView() { camera.position.copy(home); controls.target.copy(center); controls.update(); render(); },
    cameraPos() { return { x: camera.position.x, y: camera.position.y, z: camera.position.z }; },
    // Move the camera towards (factor < 1) or away from (factor > 1) the target, as a pinch would.
    dolly(factor) { camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target); controls.update(); render(); },
    labelPx() { return labelPx.slice(); },
    state() { return { z: blk.z, tiles: total, missing, textureTiles, vertices: gw * gh, skirt: ring.length, huts: huts.length, links: links.length, days: dayMeshes.filter(Boolean).length, photos: photoCount, walker: walkerPos, minH, maxH,
                       segmentsDrawn: dayMeshes.map(dm => dm ? dm.mesh.geometry.instanceCount : 0), segments: dayMeshes.map(dm => dm ? dm.segments : 0) }; },
    dispose() {
      window.removeEventListener('resize', onResize);
      controls.dispose(); renderer.dispose();
      scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  };
}
