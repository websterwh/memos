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

- Detects PDF attachments wherever Memos renders them (memo feed, memo
  detail, etc.) and adds an **Annotate** button next to the existing
  download link.
- Opens a modal PDF viewer built on [PDF.js](https://mozilla.github.io/pdf.js/)
  (loaded from cdnjs, pinned to a specific version) with:
  page navigation, page number/count, zoom in/out, fit width, fit page,
  page-level search, fullscreen, download original, close.
- Lets you draw on the page with **Pen** or **Highlight**, remove strokes
  with **Eraser**, and navigate without drawing with **Select** or **Pan**.
- Supports mouse, touch, and stylus via Pointer Events, with
  `touch-action: none` on the drawing surface so drawing doesn't scroll
  the page.
- Undo/redo at the stroke (operation) level, color and pen-size choice,
  and keyboard shortcuts (see below).
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
| `E` | Eraser tool |
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
[Deferred](#deferred--known-limitations)). Eraser deletes whole
annotations; it does not split strokes.

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

## Verification

This lives outside `web/` and `server/`, so it isn't covered by
`pnpm test`/`go test`. It was instead smoke-tested end-to-end with a
headless-Chromium Playwright script against a static harness page (a
fake attachment link plus a locally generated 2-page PDF), covering:
Annotate button injection, opening the viewer, drawing with the Pen tool,
autosave reaching "Saved", the exact Phase 1 milestone (close the viewer,
reopen it, the stroke is still there), undo/redo, page-level search,
the Eraser removing only the targeted stroke, the Highlight tool storing
a `"highlight"`-typed annotation, and the dark-mode CSS variable swap.

## Roadmap

This intentionally does **not** try to build the whole spec at once (the
spec itself says not to). What's implemented is Phase 1 in full and the
low-risk parts of Phase 2. Deferred, in spec order:

- **Phase 2 remainder**: Underline, Strikeout, and real Text annotations.
  These need PDF.js's text layer for proper text-position anchoring;
  adding a half-working, non-text-anchored version wasn't worth the
  complexity for this pass.
- **Phase 3 — Memos persistence**: swap `AnnotationStore`'s IndexedDB
  calls for real Memos API calls (once such an endpoint exists — see
  spec section 6/7). `AnnotationManager` already treats storage as an
  interface (`load`/`save`) with no other code depending on IndexedDB
  directly, so this should be a localized change.
- **Phase 4 — standalone handwriting canvas** (drawing not tied to a PDF).
- **Phase 5 — export annotated PDF** (non-destructive and flattened).
- **Phase 6 — native Memos feature** (Go models, API endpoints, React
  components, migrations, tests) if this prototype proves out.

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
