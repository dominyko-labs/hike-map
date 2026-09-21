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
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

let failures = 0;
function check(cond, msg) { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failures++; }
function near(a, b, eps) { return Math.abs(a - b) <= eps; }

// ---- fixture: a minimal JPEG whose APP1 carries GPS + DateTimeOriginal (little-endian TIFF) ----
function jpegWithGps({ lat, lon, date }) {
  const latRef = lat < 0 ? 'S' : 'N', lonRef = lon < 0 ? 'W' : 'E';
  const dms = v => { v = Math.abs(v); const d = Math.floor(v), m = Math.floor((v - d) * 60), s = Math.round(((v - d) * 60 - m) * 60 * 1000); return [[d, 1], [m, 1], [s, 1000]]; };
  const tiff = [];
  const u16 = n => tiff.push(n & 255, (n >> 8) & 255);
  const u32 = n => tiff.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
  // layout (offsets from TIFF start): header 8 | IFD0 at 8 (2 entries, 2+24+4=30) -> ends 38
  // ExifIFD at 38 (1 entry: 2+12+4=18) -> 56 | date string 20 bytes at 56 -> 76
  // GPS IFD at 76 (4 entries: 2+48+4=54) -> 130 | lat rationals at 130 (24) | lon rationals at 154 (24) -> 178
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

// ---- static server ----
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('#')[0].split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !/tile\.openstreetmap|net::ERR/.test(m.text())) errors.push(m.text()); });

// ---- 1. hash with points, deliberately out of time order ----
const EPOCH = Date.parse('2026-09-20T11:00:00Z') / 1000;
const pts = [
  { lat: 46.5500, lon: 8.0100, t: '2026-09-20T09:00:00' },  // 2nd
  { lat: 46.5200, lon: 8.0000, t: '2026-09-20T08:00:00' },  // 1st (start)
  { lat: 46.6000, lon: 8.0300, t: EPOCH },                   // 4th, epoch seconds
  { lat: 46.5800, lon: 8.0200, t: '2026-09-20T10:00:00' },  // 3rd
];
const hash = '#p=' + pts.map(p => `${p.lat},${p.lon},${p.t}`).join(';') + '&s=2&n=Test%20Ridge';
console.log('1. link with 4 points');
await page.goto(base + hash);
await page.waitForSelector('.leaflet-interactive');
const sorted = await page.evaluate(() => window.__hike.points().map(p => [p.lat, p.lon, p.t]));
check(sorted.length === 4, `4 points parsed (got ${sorted.length})`);
check(sorted[0][0] === 46.52 && sorted[3][0] === 46.6, `sorted by time: ${sorted.map(p => p[0]).join(' -> ')}`);
check(sorted[2][2] === Date.parse('2026-09-20T10:00:00'), 'ISO time parsed as local time');
check(sorted[3][2] === EPOCH * 1000, 'epoch seconds accepted');
const paths = await page.locator('.leaflet-interactive').count();
check(paths === 5, `4 circle markers + 1 polyline drawn (got ${paths} paths)`);
const stats = await page.locator('#stats').innerText();
// independent haversine over the sorted order
const R = 6371.0088, toRad = Math.PI / 180;
const hv = (a, b) => { const dLat = (b[0] - a[0]) * toRad, dLon = (b[1] - a[1]) * toRad; const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const order = [[46.52, 8.0], [46.55, 8.01], [46.58, 8.02], [46.6, 8.03]];
let expKm = 0; for (let i = 1; i < 4; i++) expKm += hv(order[i - 1], order[i]);
check(stats.includes(`${expKm.toFixed(2)} km`), `distance ${expKm.toFixed(2)} km shown (stats: ${stats.replace(/\n/g, ' | ')})`);
check(stats.includes('4 photos') && stats.includes('2 without GPS'), 'photo count and skipped count shown');
check(await page.locator('#title').innerText() === 'Test Ridge', 'name from &n= shown as title');
check(await page.locator('#empty').isHidden(), 'empty state hidden');

// ---- 2. GPX ----
console.log('2. GPX export');
const g = await page.evaluate(() => window.__hike.gpx());
check((g.match(/<trkpt /g) || []).length === 4 && (g.match(/<wpt /g) || []).length === 4, '4 trkpt and 4 wpt');
check(g.indexOf('lat="46.52"') < g.indexOf('lat="46.55"'), 'track in time order');
check(/<time>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/time>/.test(g), 'times are ISO UTC');
check(g.includes('<name>Test Ridge</name>'), 'name carried into GPX');
const link = await page.evaluate(() => window.__hike.shareLink());
check(link.includes('#p=46.52,8,') && link.endsWith('&s=2&n=Test%20Ridge'), `share link rebuilt in time order: ${link.slice(link.indexOf('#'), link.indexOf('#') + 40)}…`);

// ---- 3. empty hash ----
console.log('3. empty link');
await page.goto(base);
await page.waitForFunction(() => !!window.__hike);
check(await page.locator('#empty').isVisible(), 'empty state shown');
check(await page.locator('#stats').isHidden(), 'stats hidden');
check((await page.locator('.leaflet-interactive').count()) === 0, 'nothing drawn');

// ---- 4. malformed hash ----
console.log('4. malformed link');
await page.goto(base + '#p=hello;99,999,now');
await page.waitForFunction(() => document.getElementById('msg').textContent.length > 0);
check((await page.locator('#msg').innerText()).startsWith('No usable points'), 'error message shown');
check((await page.locator('.leaflet-interactive').count()) === 0, 'nothing drawn');

// ---- 5. file picker fallback with a JPEG fixture ----
console.log('5. JPEG file picker (EXIF parser)');
await page.goto(base);
await page.waitForFunction(() => !!window.__hike);
const fx = path.join(root, 'test', 'fixture.jpg');
fs.writeFileSync(fx, jpegWithGps({ lat: -33.8688, lon: 151.2093, date: '2026:09:20 14:30:15' }));
fs.writeFileSync(fx + '.nogps.jpg', Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));
await page.setInputFiles('#files', [fx, fx + '.nogps.jpg']);
await page.waitForFunction(() => document.getElementById('msg').textContent.includes('added'));
const fp = await page.evaluate(() => window.__hike.points());
check(fp.length === 1, `1 point from 2 files (got ${fp.length})`);
check(fp.length === 1 && near(fp[0].lat, -33.8688, 0.0001) && near(fp[0].lon, 151.2093, 0.0001), `S/E hemisphere signs and DMS: ${fp[0] && fp[0].lat}, ${fp[0] && fp[0].lon}`);
check(fp.length === 1 && fp[0].t === new Date(2026, 8, 20, 14, 30, 15).getTime(), 'DateTimeOriginal parsed');
check((await page.locator('#msg').innerText()).includes('1 without GPS'), 'file without EXIF reported, not fatal');
check(page.url().includes('#p=-33.8688'), 'URL updated with the picked points');
fs.unlinkSync(fx); fs.unlinkSync(fx + '.nogps.jpg');

// ---- 6. phone width: no horizontal scroll ----
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
check(!overflow, 'no horizontal overflow at 390px');

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);

await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
