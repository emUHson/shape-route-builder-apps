# Shape Route Builder Apps

Shape route builder apps. Code migrated from claude.ai development.

## Run Nav (`nav/`)

Turn-by-turn running navigation in the browser: no install, works from a link or QR code.

- **Open a route:** a link from Shape Route Builder's *Share to phone* (the route and its named turn cues travel inside the link, `#r=…`), or any GPX file. GPX files exported by Shape Route Builder carry named turn cues as waypoints; for other GPX files the turns are worked out from the track's shape.
- **While running:** a next-turn banner with distance, a "then" hint for quick double turns, spoken cues (about 400 ft ahead and at the turn), mile updates, an off-route warning, and done / to go / time / pace.
- **Pocket mode:** a near-black screen with voice cues and a touch lock (hold the circle to unlock). Browsers stop sharing GPS with web pages when the phone locks, so the screen stays on; on OLED phones a black screen costs little battery.
- **Open in another app:** hands the route (as GPX with cues) to a nav app such as OsmAnd for fully-locked-phone navigation.
- Works offline once opened; installable to the home screen. Map tiles © OpenStreetMap contributors.

### Building

The site is plain static files. Edit `src/nav/`, then run `python3 src/nav/build.py` to regenerate `nav/`.
The QR encoder (`qr.min.js`) is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase, MIT licence.

### Hosting

Served by GitHub Pages from the `gh-pages` branch: `https://emuhson.github.io/shape-route-builder-apps/nav/`.
