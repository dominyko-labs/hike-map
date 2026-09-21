# Hike Map

Turns the GPS metadata of your iPhone photos into a map of the hike: one pin per
photo, a line through them in the order they were taken, distance and duration,
and a GPX download. Nothing leaves your phone except the coordinates you choose
to share in the link.

Two parts:

1. **An iOS Shortcut** reads location and time from the photos you pick and opens
   Safari on this page with the points in the URL. Shortcuts has full access to
   photo metadata; Safari's photo picker does not (iOS strips location from
   photos picked from the library), which is why the Shortcut does the reading.
2. **`index.html`**, one static page served by GitHub Pages. No build, no server,
   no dependencies beyond a vendored copy of Leaflet 1.9.4.

Live page: `https://dominyko-labs.github.io/hike-map/`

## Link format

```
https://dominyko-labs.github.io/hike-map/#p=LAT,LON,TIME;LAT,LON,TIME;...&s=SKIPPED&n=NAME
```

* `p` is a `;`-separated list of `lat,lon,time`. `time` is either epoch seconds
  or anything `Date.parse` accepts, such as `2026-09-20T08:15:00` (read as
  local time). It may be omitted; points without a time sort last.
* `s` (optional) is how many photos had no GPS, shown in the stats line.
* `n` (optional) is a name for the hike, URL-encoded.

Points are sorted by time before drawing, so the order you pass does not matter.

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
15. **Ask for Input**, *Text*, prompt "Name this hike" (optional, delete this and
    the `&n=` part below if you do not want the question). Rename to **hname**.
16. **URL**: `https://dominyko-labs.github.io/hike-map/#p=plist&s=nskip&n=hname`
    (insert the variables; leave the literal characters exactly as written).
17. **Open URLs**.

Use: select photos in the Photos app → Share → **Hike map**. Safari opens with
the map. From there, **Download GPX** saves a `.gpx` file to Files and **Copy
link** puts the shareable URL on the clipboard.

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
Playwright, and checks parsing, time-sorting, the distance sum against an
independent haversine, GPX output, the empty and malformed states, and the JPEG
EXIF reader against a fixture it builds byte by byte. It resolves Playwright
from the global npm root if it is not installed locally.

Map tiles come from `tile.openstreetmap.org` at view time under the
[OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/);
fine for personal use.

## Hosting

GitHub Pages, deploying from the `main` branch, root folder. Settings → Pages →
*Build and deployment* → Source **Deploy from a branch**, branch **main**,
folder **/ (root)**. No workflow file is needed.
