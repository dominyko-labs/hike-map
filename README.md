# Hike Map

Turns the GPS metadata of your iPhone photos into a map of a multi-day hike:
one pin per photo, one coloured line per day through them in the order they
were taken, distance per day, a GPX download, and a dashed reference line of the
official route so you can see where you took your own way. Built for the
Alta Via 1 in the Dolomites; nothing in it is specific to that route except the
default map view and the "Alta Via 1 from OSM" button.

Nothing leaves your phone except the coordinates you choose to put in a link.

Two parts:

1. **An iOS Shortcut** reads location and time from the photos you pick and opens
   Safari on this page with the points in the URL. Shortcuts has full access to
   photo metadata; Safari's photo picker does not (iOS strips location from
   photos picked from the library), which is why the Shortcut does the reading.
2. **`index.html`**, one static page served by GitHub Pages. No build, no server,
   no dependencies beyond a vendored copy of Leaflet 1.9.4.

Live page: `https://dominyko-labs.github.io/hike-map/`

## What the page shows

* **Days.** Photos are grouped by the calendar day they were taken. Each day is
  a line in its own colour, listed under the stats with photo count, distance
  and the time between the day's first and last photo. Tap a day to zoom to it.
  The very first photo is green, the very last red.
* **Reference route.** A dashed grey line. Load it once and it is kept on the
  device (localStorage) until you clear it. Three ways to load it:
  * **Route GPX**: pick a GPX file from Files (a guidebook download, an export
    from a hiking app). Tracks and routes both work.
  * **Alta Via 1 from OSM**: queries the OpenStreetMap Overpass API for hiking
    relations named "Alta Via 1" in the Dolomites and draws all their ways. Takes
    a few seconds; needs network; the button reports what it got.
  * `&r=<name>` in the link loads `routes/<name>.gpx` from this site. See
    `routes/README.md` for how to upload one from the phone.
* **Off route.** With a reference loaded, each photo more than 250 m from the
  nearest point of the route gets a red ring and the stats line counts them.
  Tap a pin to see its distance from the route. That is how your custom
  variants show up: a run of red-ringed pins on a line that leaves the dashes.
* **Tiles.** Street tiles from OpenStreetMap, or **Topo tiles** from
  OpenTopoMap with contour lines, huts and marked trails. The choice is
  remembered on the device.

## Link format

```
https://dominyko-labs.github.io/hike-map/#p=LAT,LON,TIME;LAT,LON,TIME;...&s=SKIPPED&n=NAME&r=ROUTE
```

* `p` is a `;`-separated list of `lat,lon,time`. `time` is either epoch seconds
  or anything `Date.parse` accepts, such as `2026-09-20T08:15:00` (read as
  local time). It may be omitted; points without a time sort last and form a
  "No date" day.
* `s` (optional) is how many photos had no GPS, shown in the stats line.
* `n` (optional) is a name for the hike, URL-encoded.
* `r` (optional) is the name of a GPX in `routes/`.

Points are sorted by time before drawing, so the order you pass does not matter.
A whole Alta Via 1 of a few hundred photos is a link of some tens of kilobytes,
which Safari handles.

## Building the Shortcut (on the iPhone, in the Shortcuts app)

Create a new Shortcut named **Hike map** and add these actions in order.
Wherever an action asks which variable to use, pick the one named in brackets.

1. **Receive** `Images` **input from** `Share Sheet`. (Shortcut details → turn on
   *Show in Share Sheet*, accept *Images*.) Set *If there's no input* to
   **Select Photos**, with *Select Multiple* on.
2. **Repeat with Each** item in `Shortcut Input`.
3. Inside the repeat: **Get Details of Images** → *Location* of `Repeat Item`.
4. **If** `Location` *has any value*.
5. Inside the If: **Get Details of Locations** → *Latitude* of `Location`.
   Rename the result variable to **lat** (tap the variable → Rename).
6. **Get Details of Locations** → *Longitude* of `Location`. Rename to **lon**.
7. **Get Details of Images** → *Date Taken* of `Repeat Item`.
8. **Format Date** with the `Date Taken`, *Date Format* **Custom**, format string
   `yyyy-MM-dd'T'HH:mm:ss`. Rename to **when**.
9. **Text**: `lat,lon,when` (insert the three variables, separated by commas,
   no spaces).
10. **Add to Variable** `points` (type the new name `points`).
11. **Otherwise** branch of the If: **Add to Variable** `skipped` with the
    `Repeat Item`, so photos without GPS are counted.
12. **End If**, **End Repeat**.
13. **Combine Text** `points` with **Custom** separator `;`. Rename to **plist**.
14. **Count** *Items* in `skipped`. Rename to **nskip**.
15. **Ask for Input**, *Text*, prompt "Name this hike", default answer
    `Alta Via 1`. Rename to **hname**.
16. **URL**: `https://dominyko-labs.github.io/hike-map/#p=plist&s=nskip&n=hname`
    (insert the variables; leave the literal characters exactly as written).
17. **Open URLs**.

Use: in Photos, select all photos of the trip (or the album) → Share →
**Hike map**. Safari opens with the map, one colour per day. Load the reference
route once with **Alta Via 1 from OSM** or **Route GPX**; it stays for next time.
**Download GPX** saves a `.gpx` (one track per day) to Files; **Copy link** puts
the shareable URL on the clipboard.

If step 3's *Location* is missing on your iOS version, use *Metadata Dictionary*
instead, then **Get Dictionary Value** for key `{GPS}`, and inside it the keys
`Latitude`, `Longitude`, `LatitudeRef` and `LongitudeRef` (negate the value when
the ref is `S` or `W`).

## Fallback: picking files on the page

**Pick photos** on the page reads GPS from JPEG files directly in the browser.
It only helps when the files still carry location: from the Photos app, share →
*Options* → turn *Location* on → *Save to Files*, then pick from Files. HEIC is
not parsed by the fallback; the Shortcut route handles every format because it
never reads the file itself.

## Development

```
node test/run.mjs
```

The test serves the page locally, loads it in headless Chromium through
Playwright, and checks parsing, time-sorting, day grouping, the distance sums
against an independent haversine, GPX output, route loading from a file, from
`routes/` and from a mocked Overpass response (including the failure path),
off-route detection, persistence across reloads, the empty and malformed
states, and the JPEG EXIF reader against a fixture it builds byte by byte. It
resolves Playwright from the global npm root if it is not installed locally.

Map tiles come from `tile.openstreetmap.org` and `opentopomap.org` at view time
under their usage policies; fine for personal use. Route data fetched from
Overpass is © OpenStreetMap contributors, ODbL.

## Hosting

GitHub Pages, deploying from the `main` branch, root folder. Settings → Pages →
*Build and deployment* → Source **Deploy from a branch**, branch **main**,
folder **/ (root)**. No workflow file is needed.
