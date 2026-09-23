# Hike Map

Turns the GPS metadata of your iPhone photos into a map of a multi-day hike:
one pin per photo, one coloured line per day through them in the order they
were taken, distance per day, a GPX download, and a dashed reference line of the
official route so you can see where you took your own way. Built for the
Alta Via 1 in the Dolomites; nothing in it is specific to that route except the
default map view and the "Alta Via 1 from OSM" button.

Nothing leaves your phone except the coordinates you choose to put in a link.

Live page: `https://dominyko-labs.github.io/hike-map/`

## Easiest way: no Shortcut, just Files

1. In **Photos**, select all photos of the trip (or open the album and Select
   All). Tap **Share**.
2. At the top of the share sheet tap **Options**. Turn **Location** on. Go back.
3. Tap **Save to Files**, pick a folder, Save. The photos are copied out with
   their GPS data intact (HEIC or JPEG, both fine).
4. Open the live page in Safari. Tap **Pick photos**, choose **Browse** (the
   Files picker, not Photo Library), open the folder, Select all, Open.
5. The map draws itself: one colour per day, stats and a day list below. Tap
   **Copy link** to keep or share it; the link carries all the points.

Step 4 matters: if you pick from the **Photo Library** instead of Files, iOS
strips the location from every photo and the page reports them all as
"without GPS". Files keeps what step 2 saved. Then delete the copies in Files
if you like; the link is all the page needs.

The page reads the Exif block directly from JPEG and HEIC files, in the
browser. When the camera wrote its UTC offset (iPhones do), photo times are
absolute, so they line up with a recorded GPX taken in another time zone. It
reads a few hundred KB per photo, four files at a time, shows a progress bar
with the count, and redraws the map every couple of seconds, so a thousand
photos take a few minutes at most once iOS has handed them over. The same bar
reports GPX parsing, trail routing and 3D tile loading. Save the copies to On
My iPhone rather than iCloud Drive: iCloud copies may have to download first,
and that is the slow, silent part.

## What the page shows

* **Days.** Photos are grouped by the calendar day they were taken. Each day is
  a line in its own colour, listed under the stats with photo count, distance
  and the time between the day's first and last photo. Tap a day to zoom to it.
  The very first photo is green, the very last red.
* **Reference route.** A dashed grey line. Load it once and it is kept on the
  device (localStorage) until you clear it. Three ways to load it:
  * **Route GPX**: pick a GPX file from Files (a guidebook download, an export
    from a hiking app). Tracks and routes both work.
  * **Alta Via 1 from OSM**: fetches OpenStreetMap relation 177743, "Alta via
    n. 1 delle Dolomiti - Dolomiten-Höhenweg Nr. 1", through the Overpass API
    and draws all its ways. Three Overpass servers are tried in turn (the main
    one answers 504 when busy), with a name search in the Dolomites as
    fallback if the relation is ever renumbered. Takes a few seconds; the
    button reports what it got. **Save route GPX** then writes the fetched
    route to Files, so it can be loaded with **Route GPX** or uploaded to
    `routes/` and linked with `&r=`, without asking Overpass again.
  * `&r=<name>` in the link loads `routes/<name>.gpx` from this site. See
    `routes/README.md` for how to upload one from the phone.
* **Off route.** With a reference loaded, each photo more than 250 m from the
  nearest point of the route gets a red ring and the stats line counts them.
  Tap a pin to see its distance from the route. That is how your custom
  variants show up: a run of red-ringed pins on a line that leaves the dashes.
* **Map.** The map button cycles through four backgrounds, remembered on
  the device: **Street** (OpenStreetMap), **Topo** (OpenTopoMap, contour
  lines, huts), **Topo + trails** (the same with the
  [Waymarked Trails](https://hiking.waymarkedtrails.org) overlay: every marked
  hiking route with its number and colour, Alta Via 1 included), and
  **Custom**, which asks once for a tile URL template with `{z}/{x}/{y}` so a
  licensed provider (Thunderforest Outdoors with a free key, a MapTiler
  outdoor style, or any WMTS you have rights to) can be used. Tabacco maps
  are not available as a public tile service and are not included.
* **Recorded GPX.** The best input there is. Pick one or more GPX files
  recorded by Strava, AllTrails, a watch or any tracking app. Each file is
  split by calendar day, thinned to one point per 5 m (or 60 s), and used as
  that day's track: the real path, the real pace on the timeline, and ascent
  and descent from the recording's own elevation. Distance is measured on
  every recorded point before thinning, counting a point only once it is 3 m
  from the last counted one, so second-by-second GPS jitter does not add
  kilometres (a raw sum over a one-second recording overstates by 10–30 %). A recorded day is tagged
  **GPS** in the day list, is never sent to the router, and shows up even
  when no photo was taken that day. Recordings are kept on the device;
  **Clear recordings** forgets them. A GPX without timestamps (a planned
  route or an AllTrails map rather than an activity) is loaded as the dashed
  reference route instead.
  * Strava: exports GPX on its website only, not in the app. In Safari open
    strava.com, the activity, the three dots, *Export GPX*; the file lands in
    Downloads in Files.
  * AllTrails: on a recorded activity or a saved map, the share or *more* menu
    offers *Download route* → GPX (on the website; the app has the same item
    for members, unverified here).
* **Trails + elevation.** Photos are only where you stopped, so the plain
  line between them cuts corners. As soon as the photos are on the map, the
  page sends each day's positions, in order, to [BRouter](https://brouter.de)
  (a free OpenStreetMap-based router, `hiking-mountain` profile, falling back
  to `trekking`) and replaces the straight line with the trail it finds
  through them, with the altitude of every vertex. A second status line under
  the buttons reports "Routing day 3 of 9…" and, at the end, which days could
  not be routed and why; the **Trails + elevation** button retries those. Each day then shows its trail distance and **↑ ascent ↓
  descent**, and the stats line sums the ascent. Ascent and descent use a
  threshold method: a running level starts at the first elevation and moves
  only when the track is at least a threshold above or below it; each move
  counts in full and smaller wobbles are ignored. Recorded days use the
  recording's own (usually barometric) elevations with a 1 m threshold. On
  routed days the elevations are terrain-model samples at every trail vertex,
  which are noisier over rough ground, so they are first averaged over ±30 m
  along the line and then thresholded at 10 m, the same descent buffer
  BRouter itself uses for its "filtered ascend". Expect routed days to read
  somewhat higher than a barometer would.

  Calibration, on three Strava exports of this trip against the figures
  Strava displays for them (Strava's own totals are not in the files):

  | activity | Strava | page | error |
  |---|---|---|---|
  | 3.18 km, 28 m | 3.18 km / 28 m | 3.09 km / 29 m | −3 % / +4 % |
  | 17.24 km, 796 m | 17.24 km / 796 m | 17.12 km / 718 m | −1 % / −10 % |
  | 11.05 km, 705 m | 11.05 km / 705 m | 11.51 km / 687 m | +4 % / −3 % |

  For the middle activity Strava's ascent exceeds the raw sum of every rise
  in its own export (748 m), so no method on the file can reach it; Strava
  evidently computed it from a different elevation stream. The thresholds
  were chosen to minimise the largest error across the three. Results are cached on the device per set of photo
  positions, so it runs once. Ten positions go in one request (the public
  server allows 60 s per request and mountain legs are slow); longer days are
  split and joined. A photo taken off any mapped path makes the
  router detour to the nearest trail and back, so the line between two photos
  is the router's guess along trails, not a GPS track. Days that could not be
  routed keep their straight line and are named in the message.
  * **Between days.** Where one day's line ends and the next begins are the
    evening walk to the hut and the morning walk from it, which no photo
    covers. That stretch is routed too and drawn as a dotted grey link; its
    length is shown separately in the stats line as "between days" and goes
    into the GPX as its own track, but not into any day's figures.
  * **A recording that stopped early.** When a recorded day has photos taken
    before the recording started or after it ended, more than 100 m from
    its ends, the page routes from the recording's end through those photos
    and adds that to the day's track, distance and ascent; the timeline
    continues along it.
* **Download GPX** saves one track per day, on the routed trail with
  elevation where available, plus a waypoint per photo.
* **Huts.** **Huts from OSM** fetches every `tourism=alpine_hut` and
  `wilderness_hut` OpenStreetMap has inside the trip's area, as points, building
  outlines or relations, plus anything named like a hut (rifugio, Hütte,
  malga, baita, refuge) that is tagged as lodging or food instead, and keeps the
  named ones within 1.2 km of a walked line or photo. They appear as brown
  pins with their names on the map (tap for the altitude) and as labelled
  pins in 3D, and are kept on the device. Labels follow the zoom: on the map
  they are hidden below zoom 11, small up to 13 and full size from 14; in 3D
  they are sized in screen pixels, shrinking as the camera moves away and
  hiding when they would be under 9 px. Tapping the button again refreshes
  them.
* **3D.** The **3D** button swaps the map for a terrain view: elevation from
  the [AWS Open Data terrain tiles](https://registry.opendata.aws/terrain-tiles/)
  (Mapzen/Tilezen Terrarium PNGs, no key), OpenTopoMap draped over it one
  zoom level sharper than the terrain (your custom tiles if you set them;
  height colours if tiles cannot be read cross-origin), a sky gradient, a low
  north-western sun for relief, the block cut 250 m below its lowest point
  with textured sides, one line per day, a sphere per photo, hut pins with
  labels, and the timeline's walker on the surface, so ▶ plays the walk over
  the mountains. One finger pans, two fingers tilt, rotate
  and zoom. Vertical scale is exaggerated 1.25×. The scene covers the whole
  trip at the zoom that fits it in 36 terrain tiles; the module and three.js
  (vendored under `vendor/three`, release r186) load only when the button is
  first pressed. **Map** returns to the 2D view. **Centre** brings the whole
  trip back into view in either mode (the map refits its bounds, the 3D
  camera returns to its opening position).
* **Elevation profile.** Under the slider, a chart of altitude over distance
  for the whole trip, days in order and in their colours, with the day number
  above each span. It is tied to the timeline both ways: the walker's position
  is a hairline and a dot on the profile, the walked part is drawn in full and
  the rest faded, and tapping or dragging on the chart moves the timeline
  there (the map, the 3D walker and the label follow). A readout in the
  corner gives altitude, day and distance under the pointer. The chart shows
  only days that carry elevation (recorded or routed) and hides itself when
  none does.
* **Walk timeline.** The slider above the day list runs over the trip's
  walking time (the days back to back, nights skipped). Drag it and the map
  shows the walk up to that moment: the trail drawn so far in the day's
  colour, a walker marker at the current position, photos not yet reached
  faded, and a label with day, time of day, distance so far and altitude.
  ▶ plays the whole trip, five seconds per day, following the walker. Between
  two photos the position is interpolated by distance along the routed trail
  (or the straight line when a day is not routed), so it is a reconstruction
  of pace, not a recording.

## Optional: the Shortcut

The Shortcut does the same as the Files route in one tap from the share sheet:
select photos, Share, **Hike map**, and Safari opens with the map. It reads the
metadata itself, so no copies in Files are needed.

`shortcut/Hike map.shortcut` is the ready-made Shortcut. **iOS only imports
shortcuts that are signed**, and signing is done on a Mac (macOS 12 or later),
in Terminal, from the folder holding the file:

```
shortcuts sign --mode anyone --input "Hike map.shortcut" --output "Hike map signed.shortcut"
```

AirDrop or send the signed file to the iPhone and open it; Shortcuts offers to
add it. The unsigned file is generated by `node shortcut/build.mjs` and was
checked for structure only; it has not been run on a device.

### On iOS 27: let Apple Intelligence build it

iOS 27's Shortcuts app opens **New Shortcut** on a *Describe a Shortcut* box
(on iPhone 15 Pro or later). Paste this description, then check the result
against the numbered list below and fix anything it got wrong in the normal
editor:

> Make a shortcut that accepts images from the share sheet. Repeat with each
> image in the shortcut input. For each image, get its Metadata Dictionary
> (Get Details of Images). Get the dictionary value for key `{GPS}`. If that
> value has any value: get the values for keys `Latitude`, `LatitudeRef`,
> `Longitude` and `LongitudeRef` from the GPS dictionary; get the value for
> key `{Exif}` from the metadata dictionary and then `DateTimeOriginal` from
> it; make a Text of the form Latitude LatitudeRef | Longitude LongitudeRef |
> DateTimeOriginal with no spaces, exactly like `46.55N|12.01E|2026:09:20
> 08:15:00`; and add that text to a variable called `points`. After the
> repeat, Combine Text of `points` with the custom separator `;`. Build the
> URL `https://dominyko-labs.github.io/hike-map/#p=` followed by the combined
> text followed by `&n=Alta%20Via%201`, and open it in Safari.

Things it tends to get wrong: the key names must be typed exactly, braces
included; the Text must use `|` between the three parts and nothing between
a number and its N/S/E/W letter; and the URL must be opened, not shown.

### Building it by hand instead

If no Mac is around, build it in the Shortcuts app. It is 17 actions, but
eleven of them are the same **Get Dictionary Value** action, so it goes
quickly. Search for each action by name with the search field at the bottom.

Setup first: tap the ⓘ (or the shortcut name, then *Details*), turn on **Show in
Share Sheet**, and under *Share Sheet Types* keep only **Images**.

1. **Repeat with Each** — item in *Shortcut Input*. (Everything up to step 12
   goes *inside* the Repeat.)
2. **Get Details of Images** — tap *Detail*, choose **Metadata Dictionary**;
   the input should be *Repeat Item*.
3. **Get Dictionary Value** — key `{GPS}` (type the braces), from *Metadata
   Dictionary*.
4. **If** — *Dictionary Value* (the one from step 3) **has any value**.
   (Everything up to step 11 goes inside the If.)
5. **Get Dictionary Value** — key `Latitude`, from the *Dictionary Value* of
   step 3. When picking the variable, tap *Select Magic Variable* and tap the
   output of step 3.
6. **Get Dictionary Value** — key `LatitudeRef`, from the same step 3 value.
7. **Get Dictionary Value** — key `Longitude`, same source.
8. **Get Dictionary Value** — key `LongitudeRef`, same source.
9. **Get Dictionary Value** — key `{Exif}`, from the *Metadata Dictionary* of
   step 2.
10. **Get Dictionary Value** — key `DateTimeOriginal`, from step 9's value.
11. **Text** — type `|`, `|` and insert five magic variables so it reads:
    `[5][6]|[7][8]|[10]` (step numbers stand for each step's *Dictionary
    Value*; no spaces). Example result: `46.55N|12.01E|2026:09:20 08:15:00`.
12. **Add to Variable** — variable name `points`, input the *Text* of step 11.
    Leave the *Otherwise* branch of the If empty. Steps 13 and 14 are the
    End If and End Repeat that Shortcuts inserted automatically.
15. **Combine Text** — *points*, separator **Custom**, `;`. (After the End
    Repeat.)
16. **URL** — `https://dominyko-labs.github.io/hike-map/#p=` then insert the
    *Combined Text* variable, then `&n=Alta%20Via%201`.
17. **Open URLs** — input the *URL* of step 16.

Photos without GPS are skipped by the If. Decimal commas (from a phone set to
a European locale) are fine: the `|` form of the link accepts them.

## Link format

```
https://dominyko-labs.github.io/hike-map/#p=ENTRY;ENTRY;...&s=SKIPPED&n=NAME&r=ROUTE
```

Each `ENTRY` is either `lat,lon,time` (dot decimals) or `lat|lon|time`, where
`lat`/`lon` may carry an `N`/`S`/`E`/`W` suffix and, in the `|` form, a decimal
comma. `time` is epoch seconds, an ISO date such as `2026-09-20T08:15:00`, or
Exif's `2026:09:20 08:15:00` (both read as local time). It may be omitted;
undated points sort last and form a "No date" day. `s` (optional) is how many
photos had no GPS; `n` (optional) is the hike's name, URL-encoded; `r`
(optional) is the name of a GPX in `routes/`.

A whole Alta Via 1 of a few hundred photos is a link of some tens of kilobytes,
which Safari handles.

## Development

```
node test/run.mjs
node shortcut/build.mjs
```

The test serves the page locally, loads it in headless Chromium through
Playwright, and checks parsing of every link form, time-sorting, day grouping,
distance sums against an independent haversine, GPX output, route loading from
a file, from `routes/` and from a mocked Overpass response (including the
failure path), off-route detection, trail routing against a mocked BRouter (profile
fallback, request chunking, elevation gain, caching, failure), the walk
timeline (time-to-position mapping on straight and routed days, fading,
play and pause), the elevation profile (axes, day spans, cursor sync,
scrubbing by pointer), recorded GPX (splitting by day, thinning, elevation from the
file, recorded-only days, planned GPX becoming the reference), the 3D view against generated terrain
and map tiles in software WebGL (decoding, draping, skirt, lines, walker
height, huts, both fallbacks), huts against a mocked Overpass (bounds query,
name and distance filters, persistence), persistence across reloads, the empty and malformed states, and the JPEG and HEIC Exif readers against fixtures it builds
byte by byte, including a HEIC whose Exif sits past the first megabyte. It
resolves Playwright from the global npm root if it is not installed locally.

Map tiles come from `tile.openstreetmap.org`, `opentopomap.org` and
`tile.waymarkedtrails.org` at view time under their usage policies; fine for
personal use. Terrain for the 3D view comes from the AWS Open Data terrain
tiles (Mapzen, various public sources, see their attribution). Route data fetched from
Overpass and trails from BRouter are © OpenStreetMap contributors, ODbL; BRouter's
elevation comes from public SRTM data.

## Hosting

GitHub Pages, deploying from the `main` branch, root folder. The repo must be
public for Pages on a free plan. Settings → Pages → *Build and deployment* →
Source **Deploy from a branch**, branch **main**, folder **/ (root)**. No
workflow file is needed.
