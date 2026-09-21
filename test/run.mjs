// Zero-dependency test for index.html: needs only node and a Playwright install.
//   node test/run.mjs
// Playwright is resolved from NODE_PATH or the global npm root.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

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
function tiffWithGps({ lat, lon, date }) {
  const latRef = lat < 0 ? 'S' : 'N', lonRef = lon < 0 ? 'W' : 'E';
  const dms = v => { v = Math.abs(v); const d = Math.floor(v), m = Math.floor((v - d) * 60), s = Math.round(((v - d) * 60 - m) * 60 * 1000); return [[d, 1], [m, 1], [s, 1000]]; };
  const tiff = [];
  const u16 = n => tiff.push(n & 255, (n >> 8) & 255);
  const u32 = n => tiff.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
  tiff.push(0x49, 0x49); u16(42); u32(8);
  u16(2);
  u16(0x8769); u16(4); u32(1); u32(38);
  u16(0x8825); u16(4); u32(1); u32(76);
  u32(0);
  u16(1);
  u16(0x9003); u16(2); u32(20); u32(56);
  u32(0);
  for (const c of date.padEnd(19, ' ')) tiff.push(c.charCodeAt(0)); tiff.push(0);
  u16(4);
  u16(1); u16(2); u32(2); tiff.push(latRef.charCodeAt(0), 0, 0, 0);
  u16(2); u16(5); u32(3); u32(130);
  u16(3); u16(2); u32(2); tiff.push(lonRef.charCodeAt(0), 0, 0, 0);
  u16(4); u16(5); u32(3); u32(154);
  u32(0);
  for (const [n, d] of dms(lat)) { u32(n); u32(d); }
  for (const [n, d] of dms(lon)) { u32(n); u32(d); }
  return tiff;
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
const hx1 = path.join(root, 'test', 'fixture-early.heic'), hx2 = path.join(root, 'test', 'fixture-late.heic');
fs.writeFileSync(hx1, heicWithGps({ lat: 46.5432, lon: 12.1234, date: '2026:09:21 09:15:00' }));
fs.writeFileSync(hx2, heicWithGps({ lat: 46.6, lon: 12.2, date: '2026:09:22 17:45:30' }, 1500 * 1024));
fs.writeFileSync(hx2 + '.noexif.heic', heicWithGps({ lat: 1, lon: 1, date: '2026:01:01 00:00:00' }).subarray(0, 40));
check(fs.statSync(hx2).size > 1024 * 1024, 'late-Exif HEIC fixture is larger than the 1 MB head read');
await page.setInputFiles('#files', [fx, fx + '.nogps.jpg', hx1, hx2, hx2 + '.noexif.heic']);
await page.waitForFunction(() => document.getElementById('msg').textContent.includes('added'));
const fp = await page.evaluate(() => window.__hike.points());
check(fp.length === 3, `3 points from 5 files (got ${fp.length})`);
const byLat = Object.fromEntries(fp.map(p => [p.lat.toFixed(4), p]));
check(byLat['-33.8688'] && near(byLat['-33.8688'].lon, 151.2093, 1e-4), 'JPEG: S/E signs and DMS');
check(byLat['-33.8688'] && byLat['-33.8688'].t === new Date(2026, 8, 20, 14, 30, 15).getTime(), 'JPEG: DateTimeOriginal parsed');
check(byLat['46.5432'] && near(byLat['46.5432'].lon, 12.1234, 1e-4) && byLat['46.5432'].t === new Date(2026, 8, 21, 9, 15, 0).getTime(), 'HEIC with Exif inside the first MB');
check(byLat['46.6000'] && near(byLat['46.6000'].lon, 12.2, 1e-4) && byLat['46.6000'].t === new Date(2026, 8, 22, 17, 45, 30).getTime(), 'HEIC with Exif past the first MB (range read)');
check((await page.locator('#msg').innerText()).includes('3 added, 2 without GPS'), 'files without EXIF reported, not fatal');
check(page.url().includes('#p=-33.8688'), 'URL updated with the picked points');
for (const f of [fx, fx + '.nogps.jpg', hx1, hx2, hx2 + '.noexif.heic', rf]) fs.unlinkSync(f);

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
const eg = await page.evaluate(e => window.__hike.elevationGain(e.map(x => [0, 0, x])), ELE);
check(eg.up === 50 && eg.down === 20, `elevation gain with hysteresis: up ${eg.up} down ${eg.down}`);
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

// ---- 9. tiles toggle and layout ----
console.log('9. tiles and layout');
await page.click('#btn-tiles');
check(await page.locator('#btn-tiles').innerText() === 'Street tiles', 'topo tiles toggled on');
check(await page.evaluate(() => !!document.querySelector('img.leaflet-tile[src*="opentopomap"]')), 'opentopomap tile URLs requested');
await page.click('#btn-tiles');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
check(!overflow, 'no horizontal overflow at 390px');
check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);

await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
