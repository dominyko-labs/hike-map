// Zero-dependency test for index.html: needs only node and a Playwright install.
//   node test/run.mjs
// Playwright is resolved from NODE_PATH or the global npm root.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); }

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.gpx': 'application/gpx+xml' };

let failures = 0;
function check(cond, msg) { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failures++; }
function near(a, b, eps) { return Math.abs(a - b) <= eps; }
const R = 6371.0088, toRad = Math.PI / 180;
const hv = (a, b) => { const dLat = (b[0] - a[0]) * toRad, dLon = (b[1] - a[1]) * toRad; const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const pathKm = pts => { let d = 0; for (let i = 1; i < pts.length; i++) d += hv(pts[i - 1], pts[i]); return d; };

// ---- fixture: a minimal JPEG whose APP1 carries GPS + DateTimeOriginal (little-endian TIFF) ----
function tiffWithGps({ lat, lon, date, offset }) {
  const latRef = lat < 0 ? 'S' : 'N', lonRef = lon < 0 ? 'W' : 'E';
  const dms = v => { v = Math.abs(v); const d = Math.floor(v), m = Math.floor((v - d) * 60), s = Math.round(((v - d) * 60 - m) * 60 * 1000); return [[d, 1], [m, 1], [s, 1000]]; };
  const tiff = [];
  const u16 = n => tiff.push(n & 255, (n >> 8) & 255);
  const u32 = n => tiff.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
  // layout: header 8 | IFD0 @8 (2 entries: 30 bytes) | Exif IFD @38 (1 or 2 entries) | date 20 | [offset 8] | GPS IFD (4 entries: 54) | lat 24 | lon 24
  const nExif = offset ? 2 : 1, exifAt = 38, dateAt = exifAt + 2 + 12 * nExif + 4, offAt = dateAt + 20;
  const gpsAt = offAt + (offset ? 8 : 0), latAt = gpsAt + 54, lonAt = latAt + 24;
  tiff.push(0x49, 0x49); u16(42); u32(8);
  u16(2);
  u16(0x8769); u16(4); u32(1); u32(exifAt);
  u16(0x8825); u16(4); u32(1); u32(gpsAt);
  u32(0);
  u16(nExif);
  u16(0x9003); u16(2); u32(20); u32(dateAt);
  if (offset) { u16(0x9011); u16(2); u32(7); u32(offAt); }
  u32(0);
  for (const c of date.padEnd(19, ' ')) tiff.push(c.charCodeAt(0)); tiff.push(0);
  if (offset) { for (const c of offset) tiff.push(c.charCodeAt(0)); tiff.push(0, 0); }
  u16(4);
  u16(1); u16(2); u32(2); tiff.push(latRef.charCodeAt(0), 0, 0, 0);
  u16(2); u16(5); u32(3); u32(latAt);
  u16(3); u16(2); u32(2); tiff.push(lonRef.charCodeAt(0), 0, 0, 0);
  u16(4); u16(5); u32(3); u32(lonAt);
  u32(0);
  if (tiff.length !== latAt) throw new Error('fixture layout mismatch ' + tiff.length + ' vs ' + latAt);
  for (const [n, d] of dms(lat)) { u32(n); u32(d); }
  for (const [n, d] of dms(lon)) { u32(n); u32(d); }
  return tiff;
}
// A recorded-track GPX: `days` is a list of {date: 'YYYY-MM-DD', n, from: [lat, lon], to: [lat, lon], ele: fn(i, n)}, one point every 30 s from 08:00Z.
function recordedGpx(days, name = 'Morning Hike') {
  const trks = days.map(d => {
    const pts = Array.from({ length: d.n }, (_, i) => {
      const t = i / (d.n - 1), lat = d.from[0] + (d.to[0] - d.from[0]) * t, lon = d.from[1] + (d.to[1] - d.from[1]) * t;
      const time = new Date(Date.parse(d.date + 'T08:00:00Z') + i * 30000).toISOString();
      return `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${d.ele(i, d.n).toFixed(1)}</ele><time>${time}</time></trkpt>`;
    });
    return `<trk><name>${name}</name><type>hiking</type><trkseg>${pts.join('')}</trkseg></trk>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?><gpx creator="StravaGPX" version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><metadata><time>${days[0].date}T08:00:00Z</time></metadata>${trks.join('')}</gpx>`;
}
function jpegWithGps(o) {
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiffWithGps(o)];
  const len = app1.length + 2;
  return Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, len >> 8, len & 255, ...app1, 0xFF, 0xD9]);
}
// A minimal HEIF: ftyp, meta{hdlr, pitm, iinf(infe v2 'Exif'), iloc(v0)}, filler, then the Exif item.
// `fillerBytes` pushes the Exif item that far into the file (0 = right after meta).
function heicWithGps(o, fillerBytes = 0) {
  const be32 = n => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const be16 = n => [(n >> 8) & 255, n & 255];
  const cc = s => [...s].map(c => c.charCodeAt(0));
  const box = (type, ...parts) => { const body = parts.flat(); return [...be32(8 + body.length), ...cc(type), ...body]; };
  const full = (type, ver, ...parts) => box(type, [ver, 0, 0, 0], ...parts);
  const exifItem = [...be32(6), ...cc('Exif'), 0, 0, ...tiffWithGps(o)];
  const ftyp = box('ftyp', cc('heic'), be32(0), cc('mif1'), cc('heic'));
  const hdlr = full('hdlr', 0, be32(0), cc('pict'), be32(0), be32(0), be32(0), [0]);
  const pitm = full('pitm', 0, be16(1));
  const infe = full('infe', 2, be16(1), be16(0), cc('Exif'), [0]);
  const iinf = full('iinf', 0, be16(1), infe);
  const ilocFor = off => full('iloc', 0, [0x44, 0x00], be16(1), be16(1), be16(0), be16(1), be32(off), be32(exifItem.length));
  const metaLen = 12 + hdlr.length + pitm.length + iinf.length + ilocFor(0).length;
  const filler = fillerBytes ? box('free', new Array(fillerBytes).fill(0)) : [];
  const exifOff = ftyp.length + metaLen + filler.length;
  const meta = full('meta', 0, hdlr, pitm, iinf, ilocFor(exifOff));
  if (meta.length !== metaLen) throw new Error('meta size mismatch');
  return Buffer.from([...ftyp, ...meta, ...filler, ...exifItem, ...box('mdat', cc('xx'))]);
}
// A reference route running north along lon 12.0 from 46.50 to 46.60, as a GPX track with two segments.
const routeGpx = `<?xml version="1.0"?><gpx version="1.1" creator="t"><metadata><name>Alta Via 1 test</name></metadata>
<trk><name>Alta Via 1 test</name>
<trkseg><trkpt lat="46.50" lon="12.00"/><trkpt lat="46.53" lon="12.00"/><trkpt lat="46.55" lon="12.00"/></trkseg>
<trkseg><trkpt lat="46.55" lon="12.00"/><trkpt lat="46.60" lon="12.00"/></trkseg></trk></gpx>`;

// ---- PNG encoder for tile mocks (8-bit RGB, no dependencies) ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function png(w, h, rgbAt) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = rgbAt(x, y), o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// Terrarium encoding: value = (R * 256 + G + B / 256) - 32768
const terrarium = metres => { const v = metres + 32768; const r = Math.floor(v / 256), g = Math.floor(v - r * 256), b = Math.round((v - r * 256 - g) * 256); return [r, g, b]; };
const DEM_PNG = png(256, 256, () => terrarium(1500));
const MAP_PNG = png(256, 256, (x, y) => [200, 220 - (y >> 3), 160 + (x >> 3)]);

// ---- static server ----
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const p = path.join(root, rel === '/' ? 'index.html' : rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await playwright.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); }); // the 404/504 fetches and blocked tiles are provoked on purpose
const ready = () => page.waitForFunction(() => !!window.__hike);
await page.route('**/brouter?*', r => r.fulfill({ status: 503, body: 'mock: routing off' }));   // sections 1-9: auto-routing fails fast
const lines = cls => page.locator('path.' + cls).count();

// ---- 1. multi-day link, deliberately out of time order ----
console.log('1. link with 3 days of photos');
const EPOCH = Date.parse('2026-09-21T11:00:00Z') / 1000;
const pts = [
  { lat: 46.5500, lon: 12.0100, t: '2026-09-20T09:00:00' },  // day 1, 2nd
  { lat: 46.5200, lon: 12.0000, t: '2026-09-20T08:00:00' },  // day 1, 1st (start)
  { lat: 46.6000, lon: 12.0300, t: EPOCH },                  // day 2, last
  { lat: 46.5800, lon: 12.0200, t: '2026-09-21T10:00:00' },  // day 2, 1st
  { lat: 46.6200, lon: 12.0400, t: '2026-09-22T07:30:00' },  // day 3, only photo
];
const hash = '#p=' + pts.map(p => `${p.lat},${p.lon},${p.t}`).join(';') + '&s=2&n=Alta%20Via%201';
await page.goto(base + hash);
await ready();
const sorted = await page.evaluate(() => window.__hike.points().map(p => [p.lat, p.lon, p.t]));
check(sorted.length === 5, `5 points parsed (got ${sorted.length})`);
check(sorted.map(p => p[0]).join(',') === '46.52,46.55,46.58,46.6,46.62', `sorted by time: ${sorted.map(p => p[0]).join(' -> ')}`);
check(sorted[2][2] === Date.parse('2026-09-21T10:00:00'), 'ISO time parsed as local time');
check(sorted[3][2] === EPOCH * 1000, 'epoch seconds accepted');
const days = await page.evaluate(() => window.__hike.days());
check(days.length === 3 && days.map(d => d.n).join(',') === '2,2,1', `3 day groups with 2,2,1 photos (got ${JSON.stringify(days.map(d => d.n))})`);
check(new Set(days.map(d => d.color)).size === 3, 'distinct colour per day');
check((await lines('day-line')) === 3, `3 day polylines drawn (got ${await lines('day-line')})`);
check((await page.locator('.leaflet-interactive').count()) === 8, '5 markers + 3 lines interactive');
const d2 = pathKm([[46.58, 12.02], [46.6, 12.03]]);
check(near(days[1].km, d2, 1e-9), `day 2 distance ${d2.toFixed(3)} km`);
const stats = (await page.locator('#stats').innerText()).replace(/\n/g, ' | ');
const total = pathKm([[46.52, 12], [46.55, 12.01]]) + d2;
check(stats.includes(`${total.toFixed(1)} km`) && stats.includes('5 photos') && stats.includes('3 days') && stats.includes('2 without GPS'), `stats: ${stats}`);
check(!stats.includes('off route'), 'no off-route stat without a reference route');
check((await page.locator('#days li').count()) === 3, 'day list has 3 rows');
const rowText = await page.locator('#days li').nth(1).innerText();
check(/Day 2/.test(rowText) && rowText.includes(d2.toFixed(1) + ' km') && rowText.includes('1:00 h'), `day row: ${rowText.replace(/\n/g, ' ')}`);
await page.locator('#days li').nth(2).click();
await page.waitForTimeout(400);
check(await page.locator('#title').innerText() === 'Alta Via 1', 'name from &n= shown as title');

// ---- 2. GPX out ----
console.log('2. GPX export');
const g = await page.evaluate(() => window.__hike.gpx());
check((g.match(/<trk>/g) || []).length === 3 && (g.match(/<trkpt /g) || []).length === 5 && (g.match(/<wpt /g) || []).length === 5, 'one track per day, 5 trkpt, 5 wpt');
check(g.includes('day 1 (2026-09-20)') && g.indexOf('lat="46.52"') < g.indexOf('lat="46.55"'), 'tracks named and in time order');
check(/<time>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/time>/.test(g), 'times are ISO UTC');
const link = await page.evaluate(() => window.__hike.shareLink());
check(link.includes('#p=46.52,12,') && link.endsWith('&s=2&n=Alta%20Via%201'), 'share link rebuilt in time order');

// ---- 3. reference route from a GPX file, off-route detection ----
console.log('3. route GPX file + off-route');
const rf = path.join(root, 'test', 'route-fixture.gpx');
fs.writeFileSync(rf, routeGpx);
await page.setInputFiles('#route-file', rf);
await page.waitForFunction(() => document.getElementById('msg').textContent.includes('loaded'));
check((await page.locator('#msg').innerText()).includes('"Alta Via 1 test" loaded, 5 points'), 'route name and point count reported');
check((await lines('ref-route')) === 2, `2 dashed reference segments (got ${await lines('ref-route')})`);
const dashed = await page.locator('path.ref-route').first().getAttribute('stroke-dasharray');
check(dashed === '6 6', 'reference is dashed');
// photos at lon 12.01..12.04 are 0.76 km .. 3 km east of the route; only the one at lon 12.00 is on it
const dist = await page.evaluate(() => window.__hike.points().map(p => Math.round(window.__hike.distToRouteM(p, window.__hike.route()))));
const expected = [0, Math.round(0.01 * 111.32 * Math.cos(46.55 * toRad) * 1000)];
check(dist[0] === 0 && near(dist[1], expected[1], 2), `distance to route: ${dist.join(', ')} m (expected 0 and ~${expected[1]})`);
const statsR = (await page.locator('#stats').innerText()).replace(/\n/g, ' | ');
check(statsR.includes('4 off route'), `4 of 5 photos off route (stats: ${statsR})`);
check((await page.locator('path.off-route').count()) === 4, 'off-route markers styled');
check(await page.locator('#btn-clear-route').isVisible(), 'clear-route button shown');

// ---- 4. route persists across reload, clears on demand ----
console.log('4. route persistence');
await page.reload(); await ready();
await page.waitForSelector('path.ref-route', { state: 'attached' });
check((await lines('ref-route')) === 2, 'route restored from localStorage after reload');
await page.click('#btn-clear-route');
check((await lines('ref-route')) === 0, 'route cleared');
await page.reload(); await ready();
await page.waitForSelector('path.day-line', { state: 'attached' });
check((await lines('ref-route')) === 0, 'cleared route stays cleared after reload');

// ---- 5. route from routes/<name>.gpx via &r= ----
console.log('5. route from the site via &r=');
const siteRoute = path.join(root, 'routes', 'zz-test.gpx');
fs.writeFileSync(siteRoute, routeGpx);
await page.goto(base + hash + '&r=zz-test'); await ready();
await page.waitForFunction(() => document.getElementById('msg').textContent.includes('loaded from the site'));
check((await lines('ref-route')) === 2, 'routes/zz-test.gpx drawn');
check((await page.evaluate(() => window.__hike.shareLink())).endsWith('&r=zz-test'), 'share link keeps &r=');
fs.unlinkSync(siteRoute);
await page.goto(base + hash + '&r=zz-missing'); await ready();
await page.waitForFunction(() => document.getElementById('msg').textContent.includes('not loaded'));
check((await page.locator('#msg').innerText()).includes('zz-missing.gpx not found (404)'), 'missing site route reported');
await page.goto(base + hash + '&r=../etc'); await ready();
await page.waitForFunction(() => document.getElementById('msg').textContent.length > 0);
check((await page.locator('#msg').innerText()).includes('Bad route name'), 'path-like route name refused');

// ---- 6. Overpass fetch, mocked ----
console.log('6. Alta Via 1 from OSM (mocked Overpass)');
let sentQuery = ''; const opHosts = [];
await page.route('**/api/interpreter', async r => {
  const host = new URL(r.request().url()).host; opHosts.push(host);
  sentQuery = decodeURIComponent(r.request().postData().replace(/^data=/, ''));
  if (host === 'overpass-api.de') { await r.fulfill({ status: 504, body: 'Gateway Timeout' }); return; }   // busy main server: fall through to a mirror
  await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ elements: [
    { type: 'relation', id: 1, tags: { name: 'Alta Via 1', route: 'hiking' }, members: [] },
    { type: 'way', id: 2, geometry: [{ lat: 46.5, lon: 12.0 }, { lat: 46.55, lon: 12.0 }] },
    { type: 'way', id: 3, geometry: [{ lat: 46.55, lon: 12.0 }, { lat: 46.6, lon: 12.0 }, { lat: 46.65, lon: 12.0 }] },
    { type: 'node', id: 4, lat: 46.5, lon: 12.0 },
  ] }) });
});
await page.goto(base + hash); await ready();
await page.click('#btn-osm');
await page.waitForFunction(() => document.getElementById('msg').textContent.includes('OpenStreetMap:'));
check((await page.locator('#msg').innerText()).includes('"Alta Via 1" loaded from OpenStreetMap: 2 ways, 5 points'), 'way and point counts reported');
check(opHosts.join(',') === 'overpass-api.de,overpass.kumi.systems', `main server 504 -> mirror used (${opHosts.join(',')})`);
check(sentQuery === '[out:json][timeout:60];relation(177743);>>;way._;out geom;', `light query by id: ${sentQuery}`);
check(await page.locator('#btn-route-gpx').isVisible(), 'save-route-GPX button shown');
const rg = await page.evaluate(() => window.__hike.routeGpx());
check((rg.match(/<trkseg>/g) || []).length === 2 && (rg.match(/<trkpt /g) || []).length === 5 && rg.includes('<name>Alta Via 1</name>'), 'route GPX: one segment per way, all points');
// a relation that carries its members' geometry itself, plus the same way as a separate element: no duplicates
const po = await page.evaluate(() => window.__hike.parseOverpass({ elements: [
  { type: 'relation', id: 177743, tags: { name: 'Alta via n. 1 delle Dolomiti' }, members: [
    { type: 'way', ref: 7, role: '', geometry: [{ lat: 46.5, lon: 12 }, { lat: 46.51, lon: 12 }] },
    { type: 'node', ref: 8, role: 'guidepost', lat: 46.5, lon: 12 },
    { type: 'relation', ref: 9, role: '' }] },
  { type: 'way', id: 7, geometry: [{ lat: 46.5, lon: 12 }, { lat: 46.51, lon: 12 }] },
  { type: 'way', id: 10, geometry: [{ lat: 46.51, lon: 12 }, { lat: 46.52, lon: 12.01 }] }] }));
check(po.name === 'Alta via n. 1 delle Dolomiti' && po.segs.length === 2, `member geometry read, way 7 not duplicated (${po.segs.length} segments)`);
check((await lines('ref-route')) === 2, '2 reference segments from the ways');
check((await page.locator('#stats').innerText()).includes('4 off route'), 'off-route recomputed against the fetched route');
await page.unroute('**/api/interpreter');
opHosts.length = 0;
await page.route('**/api/interpreter', r => { opHosts.push(new URL(r.request().url()).host); r.fulfill({ status: 504, body: 'busy' }); });
await page.click('#btn-clear-route');
await page.click('#btn-osm');
await page.waitForFunction(() => document.getElementById('msg').textContent.includes('failed'));
check((await page.locator('#msg').innerText()).includes('overpass.private.coffee answered 504') && opHosts.length === 3, `all three servers tried, last failure named (${opHosts.join(',')})`);
// by-id answer with no ways (relation gone): the name search runs as fallback
await page.unroute('**/api/interpreter');
const opQueries = [];
await page.route('**/api/interpreter', async r => {
  const q = decodeURIComponent(r.request().postData().replace(/^data=/, '')); opQueries.push(q);
  const els = q.includes('relation(177743)') ? [] : [{ type: 'way', id: 5, geometry: [{ lat: 46.5, lon: 12 }, { lat: 46.51, lon: 12 }] }];
  await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ elements: els }) });
});
await page.click('#btn-osm');
await page.waitForFunction(() => /loaded from OpenStreetMap|failed/.test(document.getElementById('msg').textContent));
check(opQueries.length === 2 && opQueries[1].includes('["name"~"alta via') && (await page.locator('#msg').innerText()).includes('1 ways, 2 points'), 'empty by-id answer falls back to the name search');
check(await page.locator('#btn-osm').isEnabled(), 'button re-enabled after failure');
await page.unroute('**/api/interpreter');

// ---- 7. empty and malformed links ----
console.log('7. empty and malformed links');
await page.goto(base); await ready();
check(await page.locator('#empty').isVisible() && await page.locator('#stats').isHidden(), 'empty state shown, stats hidden');
check((await page.locator('.leaflet-interactive').count()) === 0, 'nothing drawn');
await page.goto(base + '#p=hello;99,999,now'); await ready();
await page.waitForFunction(() => document.getElementById('msg').textContent.length > 0);
check((await page.locator('#msg').innerText()).startsWith('No usable points'), 'error message shown');

// ---- 8. photo file picker (JPEG EXIF) ----
console.log('8. JPEG photo picker (EXIF parser)');
await page.goto(base); await ready();
const fx = path.join(root, 'test', 'fixture.jpg');
fs.writeFileSync(fx, jpegWithGps({ lat: -33.8688, lon: 151.2093, date: '2026:09:20 14:30:15' }));
fs.writeFileSync(fx + '.nogps.jpg', Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));
const fxo = path.join(root, 'test', 'fixture-offset.jpg');
fs.writeFileSync(fxo, jpegWithGps({ lat: 47.1, lon: 11.1, date: '2026:09:24 14:30:15', offset: '+02:00' }));
const hx1 = path.join(root, 'test', 'fixture-early.heic'), hx2 = path.join(root, 'test', 'fixture-late.heic');
fs.writeFileSync(hx1, heicWithGps({ lat: 46.5432, lon: 12.1234, date: '2026:09:21 09:15:00' }));
fs.writeFileSync(hx2, heicWithGps({ lat: 46.6, lon: 12.2, date: '2026:09:22 17:45:30' }, 1500 * 1024));
fs.writeFileSync(hx2 + '.noexif.heic', heicWithGps({ lat: 1, lon: 1, date: '2026:01:01 00:00:00' }).subarray(0, 40));
check(fs.statSync(hx2).size > 1024 * 1024, 'late-Exif HEIC fixture is larger than the 1 MB head read');
await page.setInputFiles('#files', [fx, fx + '.nogps.jpg', hx1, hx2, hx2 + '.noexif.heic', fxo]);
await page.waitForFunction(() => document.getElementById('msg').textContent.includes('added'));
const fp = await page.evaluate(() => window.__hike.points());
check(fp.length === 4, `4 points from 6 files (got ${fp.length})`);
const byLat = Object.fromEntries(fp.map(p => [p.lat.toFixed(4), p]));
check(byLat['-33.8688'] && near(byLat['-33.8688'].lon, 151.2093, 1e-4), 'JPEG: S/E signs and DMS');
check(byLat['-33.8688'] && byLat['-33.8688'].t === new Date(2026, 8, 20, 14, 30, 15).getTime(), 'JPEG: DateTimeOriginal parsed');
check(byLat['46.5432'] && near(byLat['46.5432'].lon, 12.1234, 1e-4) && byLat['46.5432'].t === new Date(2026, 8, 21, 9, 15, 0).getTime(), 'HEIC with Exif inside the first MB');
check(byLat['46.6000'] && near(byLat['46.6000'].lon, 12.2, 1e-4) && byLat['46.6000'].t === new Date(2026, 8, 22, 17, 45, 30).getTime(), 'HEIC with Exif past the first MB (range read)');
check(byLat['47.1000'] && byLat['47.1000'].t === Date.UTC(2026, 8, 24, 12, 30, 15), 'OffsetTimeOriginal +02:00 makes the photo time absolute');
check((await page.locator('#msg').innerText()).includes('4 added, 2 without GPS'), 'files without EXIF reported, not fatal');
check(page.url().includes('#p=-33.8688'), 'URL updated with the picked points');
for (const f of [fx, fx + '.nogps.jpg', hx1, hx2, hx2 + '.noexif.heic', fxo, rf]) fs.unlinkSync(f);

// ---- 8a. hundreds of files: progress message, incremental drawing, second-pass read ----
console.log('8a. 120 files, one with its Exif past the first 256 KB');
await page.goto(base); await ready();
const many = [];
for (let i = 0; i < 119; i++) {
  const f = path.join(root, 'test', `fixture-many-${i}.heic`);
  fs.writeFileSync(f, heicWithGps({ lat: 46.5 + i * 0.001, lon: 12.0 + i * 0.001, date: `2026:09:${20 + (i % 3)} ${String(8 + (i % 10)).padStart(2, '0')}:00:00` }));
  many.push(f);
}
// a JPEG whose APP1 comes after five 60 KB COM segments (segment lengths are 16-bit): not in the
// first 256 KB, found on the full read
const late = path.join(root, 'test', 'fixture-late-app1.jpg');
const com = 60 * 1024, comSeg = Buffer.concat([Buffer.from([0xFF, 0xFE, (com + 2) >> 8 & 255, (com + 2) & 255]), Buffer.alloc(com)]);
const jpg = jpegWithGps({ lat: 46.9, lon: 12.9, date: '2026:09:23 12:00:00' });
fs.writeFileSync(late, Buffer.concat([Buffer.from([0xFF, 0xD8]), comSeg, comSeg, comSeg, comSeg, comSeg, jpg.subarray(2)]));
check(fs.statSync(late).size > 256 * 1024, 'late-APP1 fixture is larger than the first read');
many.push(late);
const seen = [];
const poll = setInterval(async () => { try { seen.push(await page.locator('#msg').innerText()); } catch {} }, 20);
await page.setInputFiles('#files', many);
await page.waitForFunction(() => document.getElementById('msg').textContent.includes('added'));
clearInterval(poll);
const mp = await page.evaluate(() => window.__hike.points());
check(mp.length === 120, `120 points read (got ${mp.length})`);
check(mp.some(p => near(p.lat, 46.9, 1e-6)), 'late-APP1 JPEG found by the second, full read');
check(seen.some(m => /^Reading \d+ of 120…/.test(m)), `progress message seen while reading (${seen.filter(m => m.startsWith('Reading')).length} samples)`);
check((await page.locator('#msg').innerText()).startsWith('120 added.'), 'final message');
check((await page.locator('#days li').count()) === 4, 'four days listed');
check(await page.locator('#files').isEnabled(), 'picker re-enabled');
for (const f of many) fs.unlinkSync(f);

// ---- 8b. link entry formats the Shortcut produces ----
console.log('8b. |-separated entries with N/S/E/W and decimal commas');
const ent = await page.evaluate(() => window.__hike.parsePointList('46,5512N|12,0123E|2026:09:20 08:15:00;46.60S|12.30W|2026-09-21T10:00:00;46.7|12.4|;x|y|z;47,1|12,5|1789902000'));
check(ent.points.length === 4 && ent.bad === 1, `4 parsed, 1 bad (got ${ent.points.length}, ${ent.bad})`);
check(near(ent.points[0].lat, 46.5512, 1e-9) && near(ent.points[0].lon, 12.0123, 1e-9) && ent.points[0].t === new Date(2026, 8, 20, 8, 15, 0).getTime(), 'decimal comma + N/E + EXIF time');
check(ent.points[1].lat === -46.6 && ent.points[1].lon === -12.3, 'S and W make the values negative');
check(isNaN(ent.points[2].t) && ent.points[3].t === 1789902000000, 'empty time allowed; epoch seconds in |-form');
const legacy = await page.evaluate(() => window.__hike.parsePointList('46.52,12.00,2026-09-20T08:00:00;46.55,12.01'));
check(legacy.points.length === 2 && legacy.points[1].lon === 12.01, 'comma form still parses');

// ---- 10. trails + elevation via mocked BRouter ----
console.log('10. trails + elevation (mocked BRouter)');
const ELE = [1000, 1005, 1003, 1020, 1015, 1050, 1049, 1030];      // hysteresis 8 m: up 50, down 20
const eg = await page.evaluate(e => window.__hike.elevationGain(e.map(x => [0, 0, x]), 8), ELE);
check(eg.up === 50 && eg.down === 20, `elevation gain with an 8 m threshold: up ${eg.up} down ${eg.down}`);
const eg1 = await page.evaluate(e => window.__hike.elevationGain(e.map(x => [0, 0, x])), ELE);
check(eg1.up === 57 && eg1.down === 27, `recordings use a 1 m threshold: up ${eg1.up} down ${eg1.down}`);
const dw = await page.evaluate(() => window.__hike.dayWaypoints([{ lat: 46.5, lon: 12 }, { lat: 46.50005, lon: 12 }, { lat: 46.51, lon: 12 }]).length);
check(dw === 2, `waypoints within 40 m collapse (got ${dw})`);
const brReqs = [];
let failMode = 'first-profile';        // first request: hiking-mountain fails, trekking succeeds
await page.route('**/brouter?*', async r => {
  const u = new URL(r.request().url());
  const profile = u.searchParams.get('profile'), lonlats = u.searchParams.get('lonlats').split('|');
  brReqs.push({ profile, n: lonlats.length });
  if (failMode === 'all' || (failMode === 'first-profile' && brReqs.length === 1 && profile === 'hiking-mountain')) {
    await r.fulfill({ status: 500, body: 'no way' }); return;
  }
  // 8 coordinates spread from the first to the last waypoint, with the ELE profile
  const [lon0, lat0] = lonlats[0].split(',').map(Number), [lon1, lat1] = lonlats[lonlats.length - 1].split(',').map(Number);
  const coords = ELE.map((e, i) => [lon0 + (lon1 - lon0) * i / 7, lat0 + (lat1 - lat0) * i / 7, e]);
  // BRouter puts the track first and waypoint Points after it; the parser must pick the LineString
  await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { type: 'from' }, geometry: { type: 'Point', coordinates: [lon0, lat0] } },
    { type: 'Feature', properties: { 'track-length': '1234' }, geometry: { type: 'LineString', coordinates: coords } }] }) });
});
await page.goto(base + hash); await ready();
check(await page.locator('#btn-trails').isVisible(), 'trails button offered');
await page.waitForFunction(() => document.getElementById('msg2').textContent.includes('days on trails'));   // no click: routing starts by itself
check((await page.locator('#msg2').innerText()) === '2 of 2 days on trails with elevation.', `message: ${await page.locator('#msg2').innerText()}`);
check((await page.locator('#msg').innerText()) === '', 'routing status does not overwrite the main message');
check(brReqs.map(r => r.profile).join(',') === 'hiking-mountain,trekking,hiking-mountain', `profile fallback then normal: ${brReqs.map(r => r.profile).join(',')}`);
check((await lines('routed')) === 2 && (await lines('straight')) === 1, `2 routed lines, 1 straight (single-photo day)`);
const tdays = await page.evaluate(() => window.__hike.days());
check(tdays[0].trail && tdays[0].trail.n === 8 && tdays[0].trail.up === 50 && tdays[0].trail.down === 20, 'day 1 trail: 8 vertices, up 50, down 20');
const expKm = pathKm(ELE.map((e, i) => [46.52 + (46.55 - 46.52) * i / 7, 12 + (12.01 - 12) * i / 7]));
check(near(tdays[0].km, expKm, 1e-9) && near(tdays[0].trail.km, expKm, 1e-9), `day distance now from the routed line (${expKm.toFixed(3)} km)`);
check((await page.locator('#days li').nth(0).innerText()).includes('↑ 50 m ↓ 20 m'), 'day row shows ascent and descent');
check((await page.locator('#stats').innerText()).includes('↑ 100 m'), 'total ascent in stats');
check((await page.locator('#btn-trails').innerText()) === 'Trails ✓', 'button shows done');
const g2 = await page.evaluate(() => window.__hike.gpx());
check((g2.match(/<ele>/g) || []).length === 16 && g2.includes('on trails'), 'GPX carries routed points with elevation');
// timeline on a routed day: half-way in time is half-way along the trail, with elevation interpolated
const tlr = await page.evaluate(() => window.__hike.timelineAt(10000 * 30 / 121));
check(tlr && tlr.day === 0 && near(tlr.lat, 46.535, 1e-6) && near(tlr.ele, 1017.5, 1e-2), `timeline follows the routed trail: lat ${tlr && tlr.lat.toFixed(4)}, ele ${tlr && tlr.ele}`);
const before = brReqs.length;
await page.reload(); await ready();
await page.waitForSelector('path.routed', { state: 'attached' });
check((await lines('routed')) === 2 && brReqs.length === before, 'routed lines restored from cache on reload, no new requests');
// chunking: one day with 45 waypoints spaced ~111 m -> requests of 10,10,10,10,9 (sharing a point), joined into 36 vertices
const wps45 = Array.from({ length: 45 }, (_, i) => `${(46.7 + i * 0.001).toFixed(4)},12.5,2026-09-25T${String(8 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}:00`);
brReqs.length = 0; failMode = 'none';
await page.goto(base + '#p=' + wps45.join(';')); await ready();
await page.waitForFunction(() => document.getElementById('msg2').textContent.includes('days on trails'));
check(brReqs.map(r => r.n).join('+') === '10+10+10+10+9', `45 waypoints sent as 10+10+10+10+9 (got ${brReqs.map(r => r.n).join('+')})`);
const t45 = await page.evaluate(() => window.__hike.days()[0].trail);
// the mock restarts its profile at 1000 m in every chunk, so after the first (up 50, down 20) each
// further chunk starts from base 1030: 1005 (down 25), 1020 (up 15), 1050 (up 30), 1030 (down 20)
check(t45 && t45.n === 36 && t45.up === 50 + 4 * 45 && t45.down === 20 + 4 * 45, `chunks joined: ${t45 && t45.n} vertices, up ${t45 && t45.up}, down ${t45 && t45.down}`);
// total failure: straight line stays, message says which day
failMode = 'all'; brReqs.length = 0;
await page.goto(base + '#p=46.8,12.6,2026-09-26T08:00:00;46.81,12.61,2026-09-26T09:00:00'); await ready();   // hash-only change: no reload, the status line must reset
await page.waitForFunction(() => document.getElementById('msg2').textContent.includes('0 of 1 days on trails'));
const fm = await page.locator('#msg2').innerText();
check(fm.startsWith('0 of 1 days on trails') && fm.includes('Not routed: day 1 (trekking: 500'), `failure reported: ${fm}`);
check((await lines('straight')) === 1 && (await lines('routed')) === 0 && brReqs.length === 2, `straight line kept, both profiles tried (requests: ${JSON.stringify(brReqs)}, straight ${await lines('straight')}, routed ${await lines('routed')})`);
check(await page.locator('#btn-trails').isEnabled(), 'button re-enabled after failure');
// the button retries; a network-level failure is named as such
await page.unroute('**/brouter?*');
await page.route('**/brouter?*', r => r.abort('failed'));
await page.click('#btn-trails');
await page.waitForFunction(() => /days on trails/.test(document.getElementById('msg2').textContent) && document.getElementById('btn-trails').disabled === false);
const nm = await page.locator('#msg2').innerText();
check(nm.includes('network error'), `network failure named: ${nm}`);
await page.unroute('**/brouter?*');
await page.route('**/brouter?*', r => r.fulfill({ status: 503, body: 'mock: routing off' }));   // unroute dropped the default mock too

// ---- 11. walk timeline ----
console.log('11. walk timeline');
await page.evaluate(() => localStorage.removeItem('hike-map.trails.v1'));   // forget section 10's routed days: straight lines here
await page.goto(base + hash); await page.reload(); await ready();   // reload: a hash-only goto keeps the in-memory cache. 3 days: 60 min, 60 min, 1 min
await page.waitForFunction(() => document.getElementById('msg2').textContent.includes('days on trails'));   // routing (mock 503) settled
check((await page.evaluate(() => window.__hike.timelineTotal())) === 121 * 60000, 'walk time is the sum of the days, 121 min');
check(await page.locator('#timeline').isVisible() && (await page.locator('#tl').inputValue()) === '10000', 'slider shown, at the end');
check((await page.locator('path.walker').count()) === 0 && (await page.locator('#tl-label').innerText()) === '', 'nothing animated at the end');
const v30 = 10000 * 30 / 121;
const p30 = await page.evaluate(v => window.__hike.timelineAt(v), v30);
check(p30.day === 0 && near(p30.lat, 46.535, 1e-9) && near(p30.lon, 12.005, 1e-9) && near(p30.km, pathKm([[46.52, 12], [46.55, 12.01]]) / 2, 1e-9), `30 min in: half-way along day 1 (${p30.lat}, ${p30.lon}, ${p30.km.toFixed(3)} km)`);
await page.evaluate(v => window.__hike.setTimeline(v), v30);
check((await page.locator('path.walker').count()) === 1 && (await page.locator('path.progress-line').count()) === 1, 'walker and progress line drawn');
const lbl = await page.locator('#tl-label').innerText();
check(/^Day 1 · .*08:30( AM)? · 1\.7 km$/.test(lbl), `label: ${lbl}`);
const faint = await page.evaluate(() => [...document.querySelectorAll('path.day-line')].map(p => p.getAttribute('stroke-opacity')));
check(faint.join(',') === '0.18,0.18,0.18', `day lines faint while day 1 is in progress (${faint})`);
const mk = await page.evaluate(() => [...document.querySelectorAll('path.leaflet-interactive')].filter(p => p.getAttribute('fill-opacity') !== null && !p.classList.contains('day-line') && !p.classList.contains('walker')).map(p => p.getAttribute('fill-opacity')));
check(mk.filter(x => x === '1').length === 1 && mk.filter(x => x === '0.25').length === 4, `1 photo reached, 4 faded (${mk})`);
await page.evaluate(v => window.__hike.setTimeline(v), 10000 * 90 / 121);
const faint2 = await page.evaluate(() => [...document.querySelectorAll('path.day-line')].map(p => p.getAttribute('stroke-opacity')));
check(faint2.join(',') === '0.9,0.18,0.18' && (await page.locator('#tl-label').innerText()).startsWith('Day 2'), `day 1 complete, day 2 in progress (${faint2})`);
await page.evaluate(() => window.__hike.setTimeline(10000));
const faint3 = await page.evaluate(() => [...document.querySelectorAll('path.day-line')].map(p => p.getAttribute('stroke-opacity')));
check(faint3.join(',') === '0.9,0.9,0.9' && (await page.locator('path.walker').count()) === 0, 'back to the end: everything drawn, walker gone');
await page.click('#btn-play');
await page.waitForFunction(() => document.querySelector('path.walker') !== null);
await page.waitForTimeout(400);
const vPlay = +(await page.locator('#tl').inputValue());
check(vPlay > 0 && vPlay < 10000 && (await page.locator('#btn-play').innerText()) === '❚❚', `playing from the start (slider at ${Math.round(vPlay)})`);
await page.click('#btn-play');
const vPause = +(await page.locator('#tl').inputValue());
await page.waitForTimeout(300);
check(+(await page.locator('#tl').inputValue()) === vPause && (await page.locator('#btn-play').innerText()) === '▶', 'paused');
await page.evaluate(() => window.__hike.setTimeline(10000));

// ---- 12. recorded GPX (Strava / AllTrails) ----
console.log('12. recorded GPX');
await page.goto(base + hash); await page.reload(); await ready();
const tt = await page.evaluate(() => [...document.querySelectorAll('#days .tag')].length);
check(tt === 0, 'no GPS tags before loading a recording');
const rec1 = path.join(root, 'test', 'fixture-strava.gpx');
fs.writeFileSync(rec1, recordedGpx([
  { date: '2026-09-20', n: 200, from: [46.52, 12.00], to: [46.55, 12.01], ele: (i, n) => i < 150 ? 1000 + 500 * i / 149 : 1500 - 100 * (i - 149) / 50 },
  { date: '2026-09-21', n: 100, from: [46.58, 12.02], to: [46.60, 12.03], ele: () => 1800 }]));
await page.setInputFiles('#rec-file', rec1);
await page.waitForFunction(() => document.getElementById('msg').textContent.includes('fixture-strava.gpx'));
const rmsg = await page.locator('#msg').innerText();
check(/fixture-strava\.gpx: .*Sep 20 3\.4 km, .*Sep 21 2\.4 km\./.test(rmsg), `two days reported: ${rmsg}`);
check((await page.locator('#days .tag').count()) === 2 && (await lines('recorded')) === 2 && (await lines('straight')) === 1, 'days 1 and 2 recorded, day 3 straight');
const rd = await page.evaluate(() => window.__hike.days());
check(rd[0].trail.recorded && rd[0].trail.n === 200 && rd[0].trail.up >= 497 && rd[0].trail.up <= 500 && rd[0].trail.down >= 97 && rd[0].trail.down <= 100, `day 1 from the recording: ${rd[0].trail.n} points, up ${rd[0].trail.up}, down ${rd[0].trail.down}`);
check(rd[0].dur === 199 * 30000 && rd[1].dur === 99 * 30000, 'day durations from the recording');
const rtotal = await page.evaluate(() => window.__hike.timelineTotal());
check(rtotal === (199 + 99) * 30000 + 60000, `walk time from recordings: ${rtotal / 60000} min`);
const half = await page.evaluate((v) => window.__hike.timelineAt(v), 10000 * (199 * 30000 / 2) / rtotal);
check(half.day === 0 && near(half.lat, 46.52 + 0.03 * 99.5 / 199, 1e-6) && near(half.ele, 1000 + 500 * 99.5 / 149, 0.5), `walker follows the recorded pace: lat ${half.lat.toFixed(6)}, ele ${half.ele.toFixed(1)}`);
const rg2 = await page.evaluate(() => window.__hike.gpx());
check(rg2.includes('day 1 (2026-09-20), recorded') && /<trkpt lat="46.52" lon="12"><ele>1000<\/ele><time>2026-09-20T08:00:00Z<\/time>/.test(rg2), 'GPX export keeps recorded time and elevation');
await page.reload(); await ready();
check((await page.locator('#days .tag').count()) === 2, 'recordings survive a reload');
// a day with a recording but no photos still appears
const rec2 = path.join(root, 'test', 'fixture-alltrails.gpx');
fs.writeFileSync(rec2, recordedGpx([{ date: '2026-09-23', n: 50, from: [46.65, 12.05], to: [46.66, 12.06], ele: () => 2000 }], 'Rifugio walk'));
await page.setInputFiles('#rec-file', rec2);
await page.waitForFunction(() => document.getElementById('msg').textContent.includes('fixture-alltrails.gpx'));
const rows4 = await page.locator('#days li').allInnerTexts();
check(rows4.length === 4 && /0 · 1\.[34] km/.test(rows4[3]), `recorded-only day listed after the photo days (${JSON.stringify(rows4.map(r => r.replace(/\n/g, ' ')))})`);
// no timestamps: becomes the reference route
const rec3 = path.join(root, 'test', 'fixture-planned.gpx');
fs.writeFileSync(rec3, routeGpx);
await page.setInputFiles('#rec-file', rec3);
await page.waitForFunction(() => document.getElementById('msg').textContent.includes('fixture-planned.gpx'));
check((await page.locator('#msg').innerText()).includes('no timestamps, loaded as the reference route') && (await lines('ref-route')) === 2, 'planned GPX becomes the dashed reference');
// GPS jitter must not count as distance: a 2 km walk north sampled every second with ±0.6 m noise
const jit = []; let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
for (let i = 0; i <= 2000; i++) jit.push({ lat: 46.7 + i / 110574 + rnd() * 1.2 / 110574, lon: 12.6 + rnd() * 1.2 / (111320 * Math.cos(46.7 * Math.PI / 180)), t: i * 1000, ele: 1000 });
const jk = await page.evaluate(pts => ({ counted: window.__hike.recordedKm(pts), raw: window.__hike.totalKm(pts) }), jit);
check(jk.raw > 2.15 && Math.abs(jk.counted - 2.0) < 0.1, `jittered 2 km walk: raw sum ${jk.raw.toFixed(2)} km, counted ${jk.counted.toFixed(2)} km`);
const sm = await page.evaluate(() => window.__hike.smoothElevation([[46.7, 12.6, 1000], [46.70009, 12.6, 1030], [46.70018, 12.6, 1000], [46.7009, 12.6, 1100]], 30).map(c => Math.round(c[2])));
// points at 0, 10, 20 and 100 m: the first three average each other, the last stands alone
check(sm.join(',') === '1010,1010,1010,1100', `terrain smoothing over ±30 m: ${sm}`);
const thin = await page.evaluate(() => window.__hike.thinTrack([{ lat: 46.5, lon: 12, t: 0 }, { lat: 46.500001, lon: 12, t: 1000 }, { lat: 46.500002, lon: 12, t: 2000 }]).length);
check(thin === 2, `points within 5 m and 60 s collapse to first and last (got ${thin})`);
await page.click('#btn-clear-rec');
check((await page.locator('#days .tag').count()) === 0 && (await lines('recorded')) === 0 && (await page.locator('#days li').count()) === 3, 'recordings cleared');
await page.click('#btn-clear-route');
for (const f of [rec1, rec2, rec3]) fs.unlinkSync(f);

// ---- 15. huts from OSM (mocked Overpass) ----
console.log('15. huts near the walk');
await page.goto(base + hash); await page.reload(); await ready();
await page.waitForFunction(() => document.getElementById('msg2').textContent.includes('days on trails'));
check(await page.locator('#btn-huts').isVisible(), 'huts button offered');
let hutQuery = '';
await page.route('**/api/interpreter', async r => {
  hutQuery = decodeURIComponent(r.request().postData().replace(/^data=/, ''));
  await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ elements: [
    { type: 'node', id: 1, lat: 46.521, lon: 12.001, tags: { tourism: 'alpine_hut', name: 'Rifugio Uno', ele: '2050' } },
    { type: 'node', id: 2, lat: 46.575, lon: 12.018, tags: { tourism: 'alpine_hut', 'name:it': 'Rifugio Due' } },
    { type: 'node', id: 3, lat: 46.80, lon: 12.30, tags: { tourism: 'alpine_hut', name: 'Far Away Hut' } },
    { type: 'node', id: 4, lat: 46.522, lon: 12.002, tags: { tourism: 'alpine_hut' } },
    { type: 'way', id: 5, center: { lat: 46.5215, lon: 12.0012 }, tags: { building: 'yes', tourism: 'alpine_hut', name: 'Rifugio Uno' } },
    { type: 'way', id: 6, center: { lat: 46.601, lon: 12.031 }, tags: { building: 'yes', tourism: 'hotel', name: 'Rifugio Tre' } },
    { type: 'relation', id: 7, center: { lat: 46.55, lon: 12.011 }, tags: { amenity: 'restaurant', name: 'Malga Quattro' } },
    { type: 'way', id: 8, tags: { tourism: 'alpine_hut', name: 'No centre, ignored' } }] }) });
});
await page.click('#btn-huts');
await page.waitForFunction(() => /hut/.test(document.getElementById('msg').textContent) && !/Fetching/.test(document.getElementById('msg').textContent));
check(hutQuery.startsWith('[out:json][timeout:60];(nwr["tourism"~"^(alpine_hut|wilderness_hut)$"](46.') && hutQuery.includes('nwr["name"~"rifugio|rif\\\\. |hütte|huette|malga|baita|refuge",i]["tourism"](') && hutQuery.includes('["amenity"~"^(restaurant|cafe|bar|shelter)$"](') && hutQuery.endsWith(');out center;'), `points, outlines and relations, by tag or by name: ${hutQuery}`);
check((await page.locator('#msg').innerText()) === '4 huts near the walk (5 in the area). Saved on this device.', `message: ${await page.locator('#msg').innerText()}`);
const hl = await page.evaluate(() => window.__hike.huts().map(h => h.name + (h.ele ? ' ' + h.ele : '')));
check(hl.join(', ') === 'Rifugio Uno 2050, Rifugio Due, Rifugio Tre, Malga Quattro', `building centres and hotel/restaurant rifugi kept, the duplicate outline of Rifugio Uno merged, far and nameless dropped (${hl.join(', ')})`);
check((await page.locator('.leaflet-marker-icon.hut').count()) === 4 && (await page.locator('.hut .lbl').allInnerTexts()).join(',') === 'Rifugio Uno,Rifugio Due,Rifugio Tre,Malga Quattro', 'hut markers with labels on the map');
check((await page.locator('#btn-huts').innerText()) === 'Huts ✓ (4)', 'button shows the count');
await page.reload(); await ready();
check((await page.locator('.leaflet-marker-icon.hut').count()) === 4, 'huts survive a reload');
await page.unroute('**/api/interpreter');

// ---- 13. 3D terrain view (mocked terrain and map tiles) ----
console.log('13. 3D terrain view');
await page.goto(base + hash); await page.reload(); await ready();
await page.waitForFunction(() => document.getElementById('msg2').textContent.includes('days on trails'));
let demHits = 0, mapHits = 0, demMode = 'ok', mapMode = 'ok';
await page.route('**/elevation-tiles-prod/terrarium/**', r => { demHits++; demMode === 'ok' ? r.fulfill({ contentType: 'image/png', body: DEM_PNG }) : r.fulfill({ status: 404, body: '' }); });
await page.route('**/*.tile.opentopomap.org/**', r => { mapHits++; mapMode === 'ok' ? r.fulfill({ contentType: 'image/png', body: MAP_PNG }) : r.fulfill({ status: 404, body: '' }); });
const b3 = await page.evaluate(() => window.__hike.bounds3d());
check(b3 && b3.south < 46.52 && b3.north > 46.62 && b3.west < 12 && b3.east > 12.04, `bounds cover the photos with padding (${JSON.stringify(b3)})`);
check(await page.locator('#btn-3d').isVisible() && (await page.locator('#btn-3d').innerText()) === '3D', '3D button offered');
demHits = 0; mapHits = 0;
await page.click('#btn-3d');
await page.waitForFunction(() => document.getElementById('btn-3d').textContent === 'Map' || /failed/.test(document.getElementById('msg').textContent), null, { timeout: 120000 });
const m3 = await page.locator('#msg').innerText();
check(m3.startsWith('3D: ') && !m3.includes('failed'), `3D built: ${m3}`);
const st3 = await page.evaluate(() => window.__hike.view3d().state());
check(st3.z === 14 && st3.tiles === demHits && st3.missing === 0 && st3.tiles <= 36, `terrain: ${st3.tiles} tiles at zoom ${st3.z}, all loaded`);
check(st3.textureTiles > 0 && mapHits >= st3.textureTiles, `map tiles draped: ${st3.textureTiles} (requested ${mapHits})`);
check(st3.vertices > 4000 && st3.skirt > 100, `terrain mesh: ${st3.vertices} vertices, skirt ring of ${st3.skirt}`);
check(st3.huts === 4, `4 huts in the scene (got ${st3.huts})`);
check(st3.days === 2 && st3.photos === 5, `2 day tubes (single-photo day has no line), 5 photo spheres (got ${st3.days}, ${st3.photos})`);
const hAt = await page.evaluate(() => window.__hike.view3d().heightAt(46.55, 12.01));
check(near(hAt, 1500, 0.01), `elevation decoded from terrarium: ${hAt} m`);
check(near(st3.minH, 1500, 0.01) && near(st3.maxH, 1500, 0.01), 'flat mocked terrain');
check(await page.locator('#map').isHidden() && await page.locator('#map3d canvas').isVisible(), 'canvas shown in place of the map');
await page.evaluate(v => window.__hike.setTimeline(v), v30);
const st3w = await page.evaluate(() => window.__hike.view3d().state());
const w3 = st3w.walker;
check(w3 && w3.y > 1512 * 1.25 && w3.y < 1512 * 1.25 + 600, `walker placed above the surface at ${w3 && w3.y.toFixed(0)} (surface ${(1512 * 1.25).toFixed(0)})`);
check(st3w.segments[0] >= 50 && Math.abs(st3w.segmentsDrawn[0] - st3w.segments[0] / 2) <= 1 && st3w.segmentsDrawn[1] === st3w.segments[1], `day 1 densified to ${st3w.segments[0]} segments and drawn half-way, day 2 full but faded (${st3w.segmentsDrawn}/${st3w.segments})`);
await page.evaluate(() => window.__hike.setTimeline(10000));
check((await page.evaluate(() => window.__hike.view3d().state().walker)) === null, 'walker hidden at the end');
// centre: the camera can be moved anywhere; the button brings it home
const home3 = await page.evaluate(() => window.__hike.view3d().cameraPos());
const box = await page.locator('#map3d canvas').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 6 }); await page.mouse.up();
const moved3 = await page.evaluate(() => window.__hike.view3d().cameraPos());
check(Math.hypot(moved3.x - home3.x, moved3.z - home3.z) > 1, `drag moves the camera (${Math.hypot(moved3.x - home3.x, moved3.z - home3.z).toFixed(0)} m)`);
await page.click('#btn-center');
const back3 = await page.evaluate(() => window.__hike.view3d().cameraPos());
check(near(back3.x, home3.x, 1e-6) && near(back3.y, home3.y, 1e-6) && near(back3.z, home3.z, 1e-6), 'Centre returns the 3D camera home');
await page.click('#btn-3d');
check((await page.evaluate(() => window.__hike.view3d())) === null && await page.locator('#map').isVisible() && (await page.locator('#map3d canvas').count()) === 0, 'back to the map, 3D disposed');
// map tiles unavailable: height colours instead
mapMode = '404';
await page.click('#btn-3d');
await page.waitForFunction(() => document.getElementById('btn-3d').textContent === 'Map' || /failed/.test(document.getElementById('msg').textContent), null, { timeout: 120000 });
const st3b = await page.evaluate(() => window.__hike.view3d() && window.__hike.view3d().state());
check(st3b && st3b.textureTiles === 0 && (await page.locator('#msg').innerText()).includes('height colours'), 'no map tiles: falls back to height colours');
await page.click('#btn-3d');
// terrain unavailable: failure reported, map back
demMode = '404'; mapMode = 'ok';
await page.click('#btn-3d');
await page.waitForFunction(() => /failed/.test(document.getElementById('msg').textContent) || document.getElementById('btn-3d').textContent === 'Map', null, { timeout: 120000 });
check((await page.locator('#msg').innerText()).includes('3D view failed: no terrain tiles') && await page.locator('#map').isVisible() && await page.locator('#btn-3d').isEnabled(), 'no terrain: failure named, map restored');
await page.unroute('**/elevation-tiles-prod/terrarium/**'); await page.unroute('**/*.tile.opentopomap.org/**');
await page.evaluate(() => localStorage.removeItem('hike-map.huts.v1'));
demMode = 'ok';

// ---- 14. centre on the map ----
console.log('14. centre on the 2D map');
await page.goto(base + hash); await page.reload(); await ready();
const c0 = await page.evaluate(() => window.__hike.mapCenter());
await page.evaluate(() => { const m = document.getElementById('map'); m.dispatchEvent(new Event('x')); });
await page.evaluate(() => window.__hike.setTimeline(10000));
await page.evaluate(() => window.__hike.panMap(300, 200));      // a synthetic mouse drag proved timing-sensitive here
const c1 = await page.evaluate(() => window.__hike.mapCenter());
check(Math.abs(c1.lat - c0.lat) > 1e-3 || Math.abs(c1.lon - c0.lon) > 1e-3, `map dragged away (${c1.lat.toFixed(3)}, ${c1.lon.toFixed(3)})`);
await page.click('#btn-center');
await page.waitForTimeout(400);
const c2 = await page.evaluate(() => window.__hike.mapCenter());
check(Math.abs(c2.lat - c0.lat) < 2e-3 && Math.abs(c2.lon - c0.lon) < 2e-3, `Centre refits the trip (${c2.lat.toFixed(3)}, ${c2.lon.toFixed(3)} vs ${c0.lat.toFixed(3)}, ${c0.lon.toFixed(3)})`);

// ---- 9. tiles toggle and layout ----
console.log('9. tiles and layout');
check((await page.locator('#btn-tiles').innerText()) === 'Map: Street', 'starts on street tiles');
await page.click('#btn-tiles');
check((await page.locator('#btn-tiles').innerText()) === 'Map: Topo' && await page.evaluate(() => !!document.querySelector('img.leaflet-tile[src*="opentopomap"]')), 'topo tiles');
await page.click('#btn-tiles');
check((await page.locator('#btn-tiles').innerText()) === 'Map: Topo + trails' && await page.evaluate(() => !!document.querySelector('img.leaflet-tile[src*="waymarkedtrails.org/hiking"]')), 'marked-trails overlay requested on top of topo');
page.once('dialog', d => d.dismiss());                     // custom tiles asked for a URL: cancel -> back to street
await page.click('#btn-tiles');
check((await page.locator('#btn-tiles').innerText()) === 'Map: Street' && !(await page.evaluate(() => !!document.querySelector('img.leaflet-tile[src*="waymarkedtrails"]'))), 'cancelled custom URL falls back to street, overlay removed');
await page.evaluate(() => window.__hike.setCustomTiles('https://tiles.example.test/outdoor/{z}/{x}/{y}.png?key=abc'));
await page.click('#btn-tiles'); await page.click('#btn-tiles'); await page.click('#btn-tiles');
check((await page.locator('#btn-tiles').innerText()) === 'Map: Custom' && await page.evaluate(() => !!document.querySelector('img.leaflet-tile[src*="tiles.example.test/outdoor/"]')), 'custom tile template used');
await page.reload(); await ready();
check((await page.locator('#btn-tiles').innerText()) === 'Map: Custom', 'tile choice remembered');
await page.click('#btn-tiles');
check((await page.locator('#btn-tiles').innerText()) === 'Map: Street', 'cycles back to street');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
check(!overflow, 'no horizontal overflow at 390px');
check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);

await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
