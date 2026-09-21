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
function jpegWithGps({ lat, lon, date }) {
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
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = app1.length + 2;
  return Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, len >> 8, len & 255, ...app1, 0xFF, 0xD9]);
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
let sentQuery = '';
await page.route('**/api/interpreter', async r => {
  sentQuery = decodeURIComponent(r.request().postData().replace(/^data=/, ''));
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
check((await page.locator('#msg').innerText()).includes('"Alta Via 1" loaded from OpenStreetMap: 2 ways, 5 points'), 'relation name, way and point counts reported');
check(sentQuery.includes('[out:json]') && sentQuery.includes('route"="hiking"') && sentQuery.includes('^Alta Via (n\\\\.? ?)?1$') && sentQuery.includes('>>;);out geom;'), `query shape: ${sentQuery}`);
check((await lines('ref-route')) === 2, '2 reference segments from the ways');
check((await page.locator('#stats').innerText()).includes('4 off route'), 'off-route recomputed against the fetched route');
await page.unroute('**/api/interpreter');
await page.route('**/api/interpreter', r => r.fulfill({ status: 504, body: 'busy' }));
await page.click('#btn-clear-route');
await page.click('#btn-osm');
await page.waitForFunction(() => document.getElementById('msg').textContent.includes('failed'));
check((await page.locator('#msg').innerText()).includes('Overpass answered 504'), 'Overpass failure reported, page still usable');
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
await page.setInputFiles('#files', [fx, fx + '.nogps.jpg']);
await page.waitForFunction(() => document.getElementById('msg').textContent.includes('added'));
const fp = await page.evaluate(() => window.__hike.points());
check(fp.length === 1 && near(fp[0].lat, -33.8688, 1e-4) && near(fp[0].lon, 151.2093, 1e-4), `1 point, S/E signs: ${fp[0] && fp[0].lat}, ${fp[0] && fp[0].lon}`);
check(fp.length === 1 && fp[0].t === new Date(2026, 8, 20, 14, 30, 15).getTime(), 'DateTimeOriginal parsed');
check((await page.locator('#msg').innerText()).includes('1 without GPS'), 'file without EXIF reported, not fatal');
check(page.url().includes('#p=-33.8688'), 'URL updated with the picked points');
fs.unlinkSync(fx); fs.unlinkSync(fx + '.nogps.jpg'); fs.unlinkSync(rf);

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
