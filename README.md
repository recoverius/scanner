# Paperwise Scanner

A mobile-first document scanner that runs entirely in the browser. Point your phone at a page and Paperwise finds the edges, flattens the perspective, removes shadows and cleans up the colours. You can then organise pages into documents and save them as PDF. Nothing is uploaded: scans are stored on the device in IndexedDB, and the app works offline once it has loaded.

## Features

**Capture**
- Live camera viewfinder with real-time page edge detection.
- Auto capture when the page is held steady, plus batch mode for multi-page scans.
- Torch toggle on devices that support it.
- Fallback to the phone's camera app, or import from the gallery, drag and drop, or paste.

**Flatten and crop**
- Automatic corner detection.
- Perspective correction, with draggable corner and edge handles and a magnifier loupe.
- Rotate the page, or keep the whole photo with "No crop".

**Enhance**
- Filter presets: Auto (shadow removal + white balance), Enhance, Grayscale, B&W (adaptive threshold), Lighten, Vivid, Invert.
- Manual brightness, contrast, colour (saturation), warmth, sharpness and B&W level.
- Hold to compare with the original.
- Apply to all pages.

**Organise**
- Documents (groups of pages) with rename, search and sort.
- Drag to reorder pages.
- Move pages between documents, merge documents, duplicate documents and pages.
- Undo for deletions.

**Export**
- PDF in Fit, A4, Letter or Legal sizes, with orientation picked automatically per page.
- JPEG or PNG images; several images can be saved as a ZIP.
- Three quality levels.
- Share to other apps through the Web Share API where it is available.

**Extras**
- Copy text from a page with on-device OCR (Tesseract.js, loaded on demand).
- Light and dark themes.
- Installable as a PWA.
- A sample page so you can try everything without a camera.

## Running locally

The app is a static site with no build step; it uses native ES modules.

```sh
npm start            # serves the folder on http://localhost:8080
npm test             # unit tests for the imaging engine, PDF writer and ZIP writer
```

The camera needs a secure context, so use `https://` or `http://localhost`.

## Installing on your phone

Every push to `main` deploys the app to GitHub Pages (`.github/workflows/pages.yml`) at `https://<owner>.github.io/<repo>/`. To switch it on once, open **Settings → Pages** and set **Source** to **GitHub Actions**. GitHub Pages on a private repository needs a paid plan; otherwise make the repository public.

Open the site on your phone, then:
- **Android (Chrome):** menu ⋮ → **Install app** (or **Add to Home screen**).
- **iPhone (Safari):** Share → **Add to Home Screen**.

It then opens full screen like a native app and works offline. When a new version is deployed, the app shows "A new version of Paperwise is ready" with a Reload button.

## Project layout

| Path | Purpose |
| --- | --- |
| `index.html`, `css/app.css` | App shell and styles (light and dark) |
| `js/app.js` | Routing, library and document views, import flows, OCR, settings |
| `js/camera.js` | Live viewfinder, edge overlay, auto capture |
| `js/crop.js` | Corner/edge crop editor with loupe |
| `js/editor.js` | Filters, adjustments, compare, page navigation |
| `js/export.js` | PDF / image / ZIP export and sharing |
| `js/imaging.js` | Pure image-processing engine (edge detection, homography warp, filters) |
| `js/worker.js`, `js/render.js` | Runs the engine in a Web Worker; decoding and caching |
| `js/pdf.js`, `js/zip.js` | Dependency-free PDF and ZIP writers |
| `js/db.js`, `js/store.js` | IndexedDB persistence and the document/page model |
| `sw.js`, `manifest.webmanifest` | Offline support and installability |

Edits are non-destructive. Each page keeps its original photo plus its crop corners, rotation, filter and adjustments, so any change can be revisited later.
