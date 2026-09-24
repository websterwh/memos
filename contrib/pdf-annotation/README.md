# Memos PDF Annotation + Handwriting (prototype)

A lightweight PDF reader/annotator and handwriting layer for Memos, built
entirely as injected **custom JavaScript + CSS** — it does not modify
Memos itself. This is the Phase 1/2 prototype described in the build spec;
see [Roadmap](#roadmap) for what's deliberately deferred.

## Install

1. Sign in as a Memos admin and open **Settings → General**.
2. Paste the contents of `memos-pdf-annotate.js` into **Additional Script**.
3. Paste the contents of `memos-pdf-annotate.css` into **Additional Style**.
4. Save. Reload any page that shows a memo with a PDF attachment.

Memos injects the script as a single classic `<script>` tag on every page
load (`web/src/App.tsx`), which is why this stays a self-contained IIFE
with no build step and no bundler-style `import` statements at the top
level (it does use a runtime `import()` to lazy-load PDF.js as an ES
module — that works fine from inside a classic script).

This is workspace-wide, admin-controlled, and affects every user's
browser. Because it runs with full page privileges, treat it the same as
any other admin-supplied script: don't paste it into an instance you don't
control, and review the source before installing.

## What it does today

- **Clicking a PDF attachment opens the annotator directly** — the
  attachment link itself is the trigger, not a separate button. A small
  icon-only download button sits next to it. A modified click
  (Ctrl/Cmd/Shift/Alt/middle-click) is left alone so "open in new tab" /
  "save link as" still behave normally.
- **Downloading gets you the annotated PDF, with no server changes at
  all.** Both the row's download button and the viewer's own download
  check IndexedDB first: no saved strokes yet → the plain original PDF is
  downloaded exactly as Memos always served it; once you've drawn
  something, the same button instead flattens your strokes into a fresh
  copy of the PDF (via [pdf-lib](https://pdf-lib.js.org/), entirely in the
  browser) and downloads *that* — Memos' stored attachment is never
  touched. See [Downloading the annotated PDF](#downloading-the-annotated-pdf).
- Opens a modal PDF viewer built on [PDF.js](https://mozilla.github.io/pdf.js/)
  (loaded from cdnjs, pinned to a specific version) with:
  page navigation, page number/count, zoom in/out, fit width, fit page,
  page-level search (collapsible search bar), fullscreen, download, close.
- Lets you draw with **Pen** or **Highlight**, erase with either the
  **precision eraser** (removes only what you actually drag over,
  splitting a stroke into whatever survives on either side — like a real
  eraser) or the **stroke eraser** (deletes a whole stroke in one touch),
  and navigate without drawing with **Select** or **Pan**.
- A curated 6-color palette plus a **custom color** swatch backed by the
  browser's native color picker, so any color is reachable — the native
  picker is touch- and mobile-friendly for free.
- Supports mouse, touch, and stylus via Pointer Events, with
  `touch-action: none` on the drawing surface so drawing doesn't scroll
  the page. On narrow/touch screens the drawing toolbar pins to the
  bottom of the screen (thumb reach) and every control grows to a
  44px-minimum touch target; the page/search bars scroll horizontally
  instead of wrapping into a cramped header.
- Icons are [Material Symbols](https://fonts.google.com/icons) (Google
  Fonts), loaded once and reused for every button.
- Undo/redo at the operation level — a single stroke, or a whole
  precision-eraser drag (which can touch several strokes) undoes in one
  step — plus color and pen-size choice, and keyboard shortcuts (below).
- Debounced autosave with a "Saving… / Saved / Unsaved changes" indicator.
- Persists annotations in **IndexedDB**, keyed by the attachment's stable
  resource id (`attachments/{uid}`, parsed from its `/file/...` URL) —
  never by filename — so two PDFs named `textbook.pdf` never collide, and
  reopening the same attachment (even after a full reload) shows the same
  strokes.
- Matches Memos' light/dark/system theme via `html[data-theme$="dark"]`.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `V` | Select tool |
| `H` | Highlight tool |
| `P` | Pen tool |
| `E` | Precision (area) eraser |
| `Shift` + `E` | Stroke eraser (deletes the whole stroke) |
| Hold `Space` | Temporary pan, restores previous tool on release |
| `Ctrl`/`Cmd` + `Z` | Undo |
| `Ctrl`/`Cmd` + `Shift` + `Z` | Redo |
| `Esc` | Cancel current tool (back to Select) and abort any in-progress stroke |

Shortcuts are ignored while focus is in a text input, textarea, or
contenteditable element.

## Architecture

```
bootstrap (MutationObserver over document.body)
    -> MemosAdapter        finds PDF attachment links, extracts id/url/filename
    -> PDFAnnotationViewer modal shell, toolbar, page virtualization, search
         -> PDFPageView    one <canvas> (PDF.js render) + one <svg> annotation layer per page
         -> AnnotationManager   in-memory annotation list, undo/redo stacks, autosave
              -> AnnotationStore   IndexedDB persistence keyed by attachment id
```

`MemosAdapter` is the only piece that knows anything about Memos' DOM.
Everything downstream of it only deals with a URL, a document id, and a
filename, so if Memos' markup changes, only `MemosAdapter` needs updating.

### Why this DOM selector

PDF attachments render as `<a download href="/file/attachments/{uid}/{filename}" title="Download {filename}">`
(`web/src/components/MemoMetadata/Attachment/AttachmentListView.tsx`,
`DocumentRow`). The adapter matches on `a[download][href*="/file/attachments/"]`
plus a `.pdf` check on the href/title — a `download` attribute and an
attachment URL are functional, not styling, so they're far less likely to
change across releases than a CSS class name.

### Coordinate system

Each page's SVG annotation layer has `viewBox="0 0 W H"` where `W,H` come
from `page.getViewport({ scale: 1 })` — the page's natural size. Stroke
points are stored in that same unscaled space
(`{"type":"ink","page":4,"style":{...},"data":{"points":[[x,y],...]}}`),
so zooming the viewer never requires rewriting stored coordinates — the
SVG's own scaling does the work.

### Storage format

Matches the build spec's versioned schema. One IndexedDB record per
attachment:

```json
{
  "version": 1,
  "document": "attachments/abc123",
  "annotations": [
    {
      "id": "a1b2c3",
      "page": 4,
      "type": "ink",
      "style": { "color": "#111827", "width": 2, "opacity": 1 },
      "data": { "points": [[120, 240], [125, 245]] }
    }
  ],
  "updatedAt": "2026-09-24T12:00:00.000Z"
}
```

`type` is `"ink"` for the Pen tool and `"highlight"` for the Highlight
tool (a wider, translucent, `mix-blend-mode: multiply` stroke — see
[Deferred](#deferred--known-limitations)). The stroke eraser deletes a
whole annotation outright. The precision eraser instead removes only the
points inside the eraser's radius and replaces the original annotation
with zero, one, or two new annotations (fresh ids) for whatever survives
on either side — the whole drag commits as a single `AnnotationManager`
operation (`applyErase`), so one undo restores the original stroke
regardless of how many fragments the drag produced.

### Downloading the annotated PDF

Both download buttons (the one next to the attachment link, and the one in
the viewer's topbar) go through the same check:

1. Load this attachment's annotations from IndexedDB.
2. None yet → download the original PDF exactly as before (a plain
   `<a download>` click, no extra work).
3. Some exist → fetch the original PDF's bytes, load them with
   [pdf-lib](https://pdf-lib.js.org/) (loaded from cdnjs as a classic
   `<script>`, exposing a `window.PDFLib` global — no bundler needed),
   draw every stored `ink`/`highlight` annotation onto the matching page
   as a real vector path via `page.drawSvgPath(...)` (reusing the exact
   same `d` string the SVG annotation layer already draws on screen), then
   hand the resulting bytes to the browser as a `Blob` download.

This is **entirely client-side** — Memos' stored attachment is never
written to, and no request goes anywhere except the existing, unmodified
same-origin GET for the attachment's own bytes. That also means it only
works from a browser that has this script loaded: a share link handed to
someone else, or a raw `/file/...` URL, still serves the plain original,
since there's nowhere else the annotated bytes could live without a real
server-side change (see [Deferred](#deferred--known-limitations)). If
pdf-lib fails to load or the flatten step throws for any reason, the
button falls back to downloading the plain original rather than failing
silently or blocking the download entirely.

Only `ink` and `highlight` annotations are flattened (the only types this
build produces). Highlight opacity renders as a translucent stroke in the
output PDF, not a true multiply blend (that needs pdf-lib's lower-level
graphics-state API, not attempted here).

### Performance

- Pages are virtualized: an `IntersectionObserver` (root margin ±100% of
  the viewport) renders a page's canvas only when it's near the visible
  area, and clears the canvas again once it scrolls far away. A 500-page
  PDF never renders more than a handful of pages at once.
- Adding a stroke only touches that page's `<svg>`; it never re-renders
  the PDF canvas.
- Only the first page is fetched from PDF.js up front (to size the
  scrollable list and compute fit-width/fit-page); other pages are
  fetched lazily as they're observed. PDFs with pages of very different
  sizes may show a brief layout shift the first time an oddly-sized page
  scrolls into view — see [Deferred](#deferred--known-limitations).

### Security

- PDF.js is loaded with `enableScripting: false` and `isEvalSupported: false`
  — embedded PDF JavaScript never executes.
- No `innerHTML` is used anywhere; every DOM node is built with
  `createElement`/`createElementNS` and `textContent`, so attachment
  filenames and search input can never be interpreted as markup.
- The PDF is fetched with `withCredentials: true` against the same-origin
  `/file/...` URL, so it's covered by Memos' existing session/attachment
  authorization — this script does not introduce a new way to reach a
  PDF's bytes.
- PDF.js itself is loaded from `cdnjs.cloudflare.com`, pinned to a single
  version (`4.7.76` — a stable v4 release chosen over the current v6 series,
  which relies on very recent JS engine features some browsers don't
  support yet); if you'd rather not depend on a CDN, vendor
  `pdf.min.mjs` and `pdf.worker.min.mjs` yourself and change `PDFJS_BASE`
  at the top of `memos-pdf-annotate.js`.
- Icons load one `<link>` stylesheet from `fonts.googleapis.com`
  (Material Symbols). Google Fonts has served this without setting
  tracking cookies since 2022; if you'd rather avoid the extra request
  entirely, self-host the font files and change `ICON_FONT_HREF`.
- pdf-lib is loaded from `cdnjs.cloudflare.com`, pinned to `1.17.1`. It
  only runs when a download actually has annotations to flatten, and only
  produces a client-side `Blob` for the browser to save — it never sends
  anything to Memos or anywhere else.

## Verification

This lives outside `web/` and `server/`, so it isn't covered by
`pnpm test`/`go test`. It was instead smoke-tested end-to-end with
headless-Chromium Playwright scripts against a static harness page (a
fake attachment link plus a locally generated 2-page PDF), covering:
clicking the attachment link itself to open the viewer, drawing with the
Pen tool, autosave reaching "Saved", the exact Phase 1 milestone (close
the viewer, reopen it, the stroke is still there), undo/redo, page-level
search, the Highlight tool storing a `"highlight"`-typed annotation, the
dark-mode CSS variable swap, the precision eraser splitting a stroke into
two fragments with a single compound undo restoring the original, the
stroke eraser deleting a whole stroke in one action, the custom color
picker updating the active drawing color, and — at a mobile-width,
touch-enabled viewport — the toolbar pinning to the bottom of the screen
with enlarged touch targets.

The download flattening was additionally verified with the real pdf-lib
build this script loads (not a mock): downloading with no annotations
yields the byte-identical original, downloading after drawing a stroke
(both from inside the open viewer and from the row's button with the
viewer closed) yields a larger, valid PDF of the same size both times.

## Roadmap

This intentionally does **not** try to build the whole spec at once (the
spec itself says not to). What's implemented is Phase 1 in full and the
low-risk parts of Phase 2. Deferred, in spec order:

- **Phase 2 remainder**: Underline, Strikeout, and real Text annotations.
  These need PDF.js's text layer for proper text-position anchoring;
  adding a half-working, non-text-anchored version wasn't worth the
  complexity for this pass.
- **Phase 3 — Memos persistence**: the annotation objects themselves (the
  individually editable strokes) still live in IndexedDB only, not behind
  a Memos API — that would need a real backend change (a way to persist
  annotation data, or to replace an attachment's stored bytes), which is
  out of scope for a JS/CSS-only prototype. `AnnotationManager` already
  treats storage as an interface (`load`/`save`), so pointing it at a real
  endpoint later should be a localized change if one is ever added.
- **Phase 4 — standalone handwriting canvas** (drawing not tied to a PDF).
- **Phase 5 — export annotated PDF**: the flattened download (above)
  covers this for "download it now"; there's no "save the flattened
  version back into Memos" mentioned in the spec's non-destructive vs.
  flattened distinction, since that's the Phase 3 backend gap above —
  a JS/CSS-only build can hand you the flattened bytes but can't make
  Memos' own copy of the attachment be those bytes.
- **Phase 6 — native Memos feature** (Go models, dedicated API endpoints,
  React components, migrations, tests) if this prototype proves out —
  that would be the point to properly close the Phase 3/5 gaps above.

### Deferred / known limitations

- Search is page-level (jumps to the first page whose text contains the
  query and lets you step through matching pages) rather than
  highlighting the exact matched text — that needs the text layer too.
- Highlighter is a freehand translucent stroke, not a text-selection-based
  highlight.
- Shapes (line, arrow, rectangle, circle), sticky notes, lasso, image,
  signature, and stamp tools from the spec's full toolbar are not built.
- Annotations only sync within the browser they were drawn in (IndexedDB
  is per-browser/per-device) until Phase 3 lands.
- **Select** and **Pan** currently behave identically: both simply turn
  off drawing on the SVG layer (`pointer-events: none`) so the browser's
  native scroll/drag/pinch handles navigation underneath. A dedicated
  click-and-drag pan (independent of native scroll gestures) isn't
  implemented yet.
