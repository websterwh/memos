# Memos PDF Annotation + Handwriting (prototype)

A lightweight PDF reader/annotator and handwriting layer for Memos. The
drawing/viewing UI is injected **custom JavaScript + CSS** and does not
touch Memos' own code. One feature — **saving the annotated PDF back over
the original attachment** — does require a small, real backend change
(see [Save annotated PDF to Memos](#save-annotated-pdf-to-memos)); it's
included in this same PR/branch under `server/` and `store/`. Everything
else works against a stock, unmodified Memos. This is the Phase 1/2
prototype described in the build spec, plus a slice of Phase 3/5; see
[Roadmap](#roadmap) for what's still deliberately deferred.

## Install

1. **Deploy this branch's backend** (only needed for the Save-to-Memos
   button — skip this step if you don't need it, everything else works
   against a stock Memos): build/run the server from this branch/PR so
   the `content` field is accepted by `UpdateAttachment` (see
   [Backend changes](#backend-changes)).
2. Sign in as a Memos admin and open **Settings → General**.
3. Paste the contents of `memos-pdf-annotate.js` into **Additional Script**.
4. Paste the contents of `memos-pdf-annotate.css` into **Additional Style**.
5. Save. Reload any page that shows a memo with a PDF attachment.

Memos injects the script as a single classic `<script>` tag on every page
load (`web/src/App.tsx`), which is why this stays a self-contained IIFE
with no build step and no bundler-style `import` statements at the top
level (it does use a runtime `import()` to lazy-load PDF.js as an ES
module, and a plain `<script src>` tag to load pdf-lib's UMD build — both
work fine from inside a classic script).

This is workspace-wide, admin-controlled, and affects every user's
browser. Because it runs with full page privileges, treat it the same as
any other admin-supplied script: don't paste it into an instance you don't
control, and review the source before installing.

## What it does today

- **Clicking a PDF attachment opens the annotator directly** — the
  attachment link itself is the trigger, not a separate button. A small
  icon-only download button sits next to it for grabbing the plain file.
  A modified click (Ctrl/Cmd/Shift/Alt/middle-click) is left alone so
  "open in new tab" / "save link as" still behave normally.
- Opens a modal PDF viewer built on [PDF.js](https://mozilla.github.io/pdf.js/)
  (loaded from cdnjs, pinned to a specific version) with:
  page navigation, page number/count, zoom in/out, fit width, fit page,
  page-level search (collapsible search bar), fullscreen, download
  original, close.
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
- **Save annotated PDF to Memos** (topbar cloud-upload icon): flattens
  every stroke into real vector graphics on a copy of the original PDF
  and replaces the attachment's stored bytes in place — a normal download
  of that same attachment then serves the annotated version. See
  [below](#save-annotated-pdf-to-memos) for how this works and what it
  requires.

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

### Save annotated PDF to Memos

Clicking the cloud-upload icon:

1. Confirms with the user (`window.confirm`) — this replaces the
   downloadable original, which cannot be recovered afterward, so it asks
   before doing it.
2. Fetches the original PDF bytes and loads them with
   [pdf-lib](https://pdf-lib.js.org/) (loaded from cdnjs as a classic
   `<script>`, exposing a `window.PDFLib` global — no bundler needed).
3. Draws every stored `ink`/`highlight` annotation onto the matching page
   as a real vector path via `page.drawSvgPath(...)`, reusing the exact
   same `d` string the SVG annotation layer already draws on screen, so
   what you see is what gets baked in.
4. Calls `pdfDoc.save()` to get the flattened PDF's bytes, then sends them
   to Memos as a hand-built Connect RPC request:

   ```
   POST /memos.api.v1.AttachmentService/UpdateAttachment
   Content-Type: application/json
   Authorization: Bearer <token from localStorage["memos_access_token"]>

   {"attachment": {"name": "attachments/{uid}", "content": "<base64>"},
    "updateMask": "content"}
   ```

   There's no generated TypeScript client available inside a plain
   injected script, but Connect's JSON codec is a normal unary POST any
   `fetch` can make — no protobuf binary framing needed. The access token
   is read directly from `localStorage`, the same place Memos' own
   frontend (`web/src/auth-state.ts`) keeps it; this script never mints or
   stores a token itself. If it's missing or expired, the request 401s and
   the status bar says to reload Memos and try again — this doesn't try to
   replicate Memos' own token-refresh flow.

The IndexedDB annotation objects (the individually editable strokes) are
untouched by this — "flattening" only affects the copy of the PDF that
gets uploaded. You can keep editing and re-save as many times as you like;
each save re-flattens the current state over the (by-then-already-
annotated) attachment.

**Only `ink` and `highlight` annotations are flattened today** (the only
types this build produces — see [Deferred](#deferred--known-limitations)).
Highlight opacity/blend renders as a translucent stroke in the output PDF,
not a true multiply blend (PDF blend modes need pdf-lib's lower-level
graphics-state API, not attempted here).

#### Backend changes

`UpdateAttachment` previously only supported renaming
(`server/api/v1/attachment_service.go`). This PR extends it to also accept
`content` in the update mask, replacing the attachment's stored bytes
*in place* — same id, same filename, same `/file/...` URL — across all
three storage backends:

| Storage | What happens |
| --- | --- |
| Database | New bytes go straight into `attachment.blob`/`attachment.size`. |
| Local disk | The file at the attachment's existing `Reference` path is overwritten atomically (temp file + rename), same as `saveAttachmentContent` on create. |
| S3 | `driver.UploadObject` re-PUTs the object at its existing key (`ResolveAttachmentS3Driver` resolves the same driver/credentials the create path uses). |

New/changed Go: `store.UpdateAttachment` gained `Blob`/`Size` fields; the
three `store/db/{sqlite,mysql,postgres}/attachment.go` drivers apply them
in their `SET` clause; `server/api/v1/attachment_service_storage.go` gained
`replaceAttachmentContent`, which does the local-file/S3 overwrite (or
just returns the blob for the database case); `UpdateAttachment`'s handler
wires `"content"` into the same upload-size check and per-user rate limit
(`ratelimit.ScopeUploadUser`) that `CreateAttachment` already uses. No
`.proto` changes were needed — `Attachment.content` already existed as an
`INPUT_ONLY` field for create; this just teaches update to honor it too.

This does **not** re-run the create-time processing pipeline (EXIF
stripping, motion-photo detection) — it's meant for already-finished
content like a flattened PDF, not raw uploads. It also doesn't re-sniff or
change the stored MIME type, so it's only meaningful for replacing content
of the same type.

Covered by `server/api/v1/test/attachment_service_test.go`
(`TestUpdateAttachmentContent`, database + local-disk cases) and
`attachment_service_s3_test.go` (`TestUpdateAttachmentContentS3`, using
the in-process `fakes3` test server — no Docker required). Also manually
verified against a real running `go run ./cmd/memos` instance: created a
real attachment, replaced its content through the exact request shape
above, and confirmed a plain `/file/...` download served the new bytes at
the same URL.

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
  only runs in the browser tab that clicks "Save to Memos"; it never
  touches PDF.js's rendering path or the on-screen viewer.
- Saving to Memos reuses Memos' own authorization (the same access token
  the app already holds), the same per-user upload rate limit, and the
  same upload size limit as a normal attachment upload — this doesn't add
  a new, less-guarded write path, just a new field on an existing,
  already-authorized RPC.
- Because replacing content is irreversible (the original bytes are gone
  once overwritten), the button confirms with the user first and never
  fires automatically alongside the debounced IndexedDB autosave.

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

The backend change (`UpdateAttachment` accepting `content`) *is* inside
`server/`/`store/`, so it's covered by real Go tests
(`go test ./server/... ./store/...`, all passing, including `-race`) for
the database, local-disk, and S3 (via the in-process `fakes3` fake, no
Docker needed) storage backends. The client-side flatten step was also
verified against a real running `go run ./cmd/memos` instance: fetched a
real attachment's bytes, flattened them with the actual pdf-lib build this
script loads (same `drawSvgPath` call shape), uploaded the result through
the real `UpdateAttachment` endpoint, and confirmed a plain file download
served the new, larger, still-valid PDF at the same URL.

## Roadmap

This intentionally does **not** try to build the whole spec at once (the
spec itself says not to). What's implemented is Phase 1 in full, the
low-risk parts of Phase 2, and a slice of Phases 3 and 5 (see
[Save annotated PDF to Memos](#save-annotated-pdf-to-memos)). Deferred, in
spec order:

- **Phase 2 remainder**: Underline, Strikeout, and real Text annotations.
  These need PDF.js's text layer for proper text-position anchoring;
  adding a half-working, non-text-anchored version wasn't worth the
  complexity for this pass.
- **Phase 3 — Memos persistence, remainder**: only the *flattened result*
  is saved to Memos (as the attachment's content); the live, individually
  editable annotation objects still live in IndexedDB only, not behind a
  Memos API. `AnnotationManager` already treats storage as an interface
  (`load`/`save`), so pointing it at a real annotations endpoint later
  should be a localized change, but that endpoint doesn't exist yet.
- **Phase 4 — standalone handwriting canvas** (drawing not tied to a PDF).
- **Phase 5 — export annotated PDF, remainder**: only the flattened
  variant is implemented, and it replaces the original rather than saving
  alongside it as `textbook-annotated.pdf`. A "keep both" export and a
  manual "download the flattened PDF without touching Memos" option
  aren't built.
- **Phase 6 — native Memos feature** (Go models, dedicated API endpoints,
  React components, migrations, tests) if this prototype proves out.

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
