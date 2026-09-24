/*
 * Memos PDF Annotation + Handwriting (prototype)
 *
 * Paste this file's contents into Settings -> General -> Additional Script.
 * Paste memos-pdf-annotate.css into Settings -> General -> Additional Style.
 *
 * Implements Build Spec Phase 1 (ink drawing persisted across reloads) and
 * the low-risk parts of Phase 2 (highlighter, eraser, undo/redo, color,
 * size, autosave). See README.md in this folder for what is and is not
 * implemented, and the roadmap for later phases.
 *
 * Architecture (see README for details):
 *   bootstrap -> MemosAdapter -> PDFAnnotationViewer -> PDFPageView
 *                              -> AnnotationManager  -> AnnotationStore
 */
(function () {
  "use strict";

  if (window.__memosPdfAnnotate) {
    return;
  }
  window.__memosPdfAnnotate = { version: "0.2.0" };

  var PDFJS_VERSION = "4.7.76";
  var PDFJS_BASE = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + PDFJS_VERSION + "/";

  var DB_NAME = "memos-pdf-annotations";
  var DB_VERSION = 1;
  var STORE_NAME = "documents";

  var PAGE_GAP = 16;
  var SAVE_DEBOUNCE_MS = 800;
  var MIN_SCALE = 0.25;
  var MAX_SCALE = 4;

  var COLORS = ["#111827", "#dc2626", "#2563eb", "#16a34a", "#f59e0b", "#a855f7"];
  var SIZES = [1, 2, 4, 8, 14];

  var ICON_FONT_HREF =
    "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0&display=block";

  var ICONS = {
    prev: "chevron_left",
    next: "chevron_right",
    zoomOut: "zoom_out",
    zoomIn: "zoom_in",
    fitWidth: "swap_horiz",
    fitPage: "fit_screen",
    search: "search",
    searchClose: "close",
    fullscreen: "fullscreen",
    download: "download",
    close: "close",
    undo: "undo",
    redo: "redo",
    select: "arrow_selector_tool",
    pan: "pan_tool",
    pen: "draw",
    highlight: "ink_highlighter",
    eraserPrecision: "ink_eraser",
    eraserStroke: "backspace",
    palette: "palette",
  };

  function ensureIconFont() {
    if (document.getElementById("mpa-icon-font")) return;
    document.head.appendChild(
      el("link", {
        id: "mpa-icon-font",
        rel: "stylesheet",
        href: ICON_FONT_HREF,
      }),
    );
  }

  function icon(name) {
    return el("span", { class: "material-symbols-outlined mpa-icon", "aria-hidden": "true", text: name });
  }

  function iconButton(iconName, label, onclick, extraClass) {
    var btn = el("button", {
      class: "mpa-btn mpa-icon-btn" + (extraClass ? " " + extraClass : ""),
      type: "button",
      title: label,
      "aria-label": label,
      onclick: onclick,
    });
    btn.appendChild(icon(iconName));
    return btn;
  }

  function toolButton(tool, iconName, label, onclick) {
    var btn = iconButton(iconName, label, onclick, "mpa-tool-btn");
    btn.dataset.tool = tool;
    return btn;
  }

  // ---------------------------------------------------------------------
  // Small DOM helpers. No innerHTML is used anywhere in this file so that
  // attachment filenames, search text and annotation text can never be
  // interpreted as markup.
  // ---------------------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === undefined || value === null) return;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key.indexOf("on") === 0 && typeof value === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
          node.setAttribute(key, value);
        }
      });
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  var SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value !== undefined && value !== null) node.setAttribute(key, value);
      });
    }
    return node;
  }

  function uid() {
    return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // ---------------------------------------------------------------------
  // AnnotationStore: IndexedDB-backed persistence keyed by attachment id.
  // Prototype storage per the build spec (section 6); a real
  // implementation would swap this for Memos API calls without touching
  // AnnotationManager's interface.
  // ---------------------------------------------------------------------

  var AnnotationStore = (function () {
    var dbPromise = null;

    function openDB() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: "document" });
          }
        };
        req.onsuccess = function () {
          resolve(req.result);
        };
        req.onerror = function () {
          reject(req.error);
        };
      });
      return dbPromise;
    }

    function load(documentId) {
      return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE_NAME, "readonly");
          var req = tx.objectStore(STORE_NAME).get(documentId);
          req.onsuccess = function () {
            resolve(
              req.result || {
                version: 1,
                document: documentId,
                annotations: [],
                updatedAt: null,
              },
            );
          };
          req.onerror = function () {
            reject(req.error);
          };
        });
      });
    }

    function save(documentId, doc) {
      return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).put(doc);
          tx.oncomplete = function () {
            resolve();
          };
          tx.onerror = function () {
            reject(tx.error);
          };
        });
      });
    }

    return { load: load, save: save };
  })();

  // ---------------------------------------------------------------------
  // AnnotationManager: in-memory annotation state for one document, with
  // operation-level undo/redo and debounced autosave.
  // ---------------------------------------------------------------------

  function AnnotationManager(documentId) {
    this.documentId = documentId;
    this.annotations = [];
    this.undoStack = [];
    this.redoStack = [];
    this.saveTimer = null;
    this.saveState = "saved";
    this.onSaveStateChange = null;
    this.onChange = null;
  }

  AnnotationManager.prototype.load = function () {
    var self = this;
    return AnnotationStore.load(this.documentId).then(function (doc) {
      self.annotations = Array.isArray(doc.annotations) ? doc.annotations : [];
    });
  };

  AnnotationManager.prototype.getForPage = function (page) {
    return this.annotations.filter(function (a) {
      return a.page === page;
    });
  };

  AnnotationManager.prototype.add = function (annotation, opts) {
    this.annotations.push(annotation);
    if (!opts || opts.record !== false) {
      this.undoStack.push({ op: "add", annotation: annotation });
      this.redoStack = [];
    }
    this._notify(annotation.page);
    this._scheduleSave();
  };

  AnnotationManager.prototype.remove = function (id, opts) {
    var idx = -1;
    for (var i = 0; i < this.annotations.length; i++) {
      if (this.annotations[i].id === id) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return null;
    var removed = this.annotations.splice(idx, 1)[0];
    if (!opts || opts.record !== false) {
      this.undoStack.push({ op: "remove", annotation: removed });
      this.redoStack = [];
    }
    this._notify(removed.page);
    this._scheduleSave();
    return removed;
  };

  AnnotationManager.prototype.undo = function () {
    var entry = this.undoStack.pop();
    if (!entry) return;
    if (entry.op === "add") {
      this.remove(entry.annotation.id, { record: false });
    } else if (entry.op === "remove") {
      this.add(entry.annotation, { record: false });
    } else if (entry.op === "erase") {
      this._applyEraseWithoutRecording(entry.added, entry.removed);
    }
    this.redoStack.push(entry);
  };

  AnnotationManager.prototype.redo = function () {
    var entry = this.redoStack.pop();
    if (!entry) return;
    if (entry.op === "add") {
      this.add(entry.annotation, { record: false });
    } else if (entry.op === "remove") {
      this.remove(entry.annotation.id, { record: false });
    } else if (entry.op === "erase") {
      this._applyEraseWithoutRecording(entry.removed, entry.added);
    }
    this.undoStack.push(entry);
  };

  // Compound operation used by the precision eraser: one drag can remove
  // whole annotations and add back the surviving fragments split out of
  // them. This is recorded as a single undo/redo step, not one per point.
  AnnotationManager.prototype.applyErase = function (removed, added) {
    if (!removed.length && !added.length) return;
    this._applyEraseWithoutRecording(removed, added);
    this.undoStack.push({ op: "erase", removed: removed, added: added });
    this.redoStack = [];
  };

  AnnotationManager.prototype._applyEraseWithoutRecording = function (toRemove, toAdd) {
    var removedIds = {};
    toRemove.forEach(function (a) {
      removedIds[a.id] = true;
    });
    this.annotations = this.annotations.filter(function (a) {
      return !removedIds[a.id];
    });
    var self = this;
    toAdd.forEach(function (a) {
      self.annotations.push(a);
    });
    var pages = {};
    toRemove.concat(toAdd).forEach(function (a) {
      pages[a.page] = true;
    });
    Object.keys(pages).forEach(function (p) {
      self._notify(Number(p));
    });
    this._scheduleSave();
  };

  AnnotationManager.prototype._notify = function (page) {
    if (this.onChange) this.onChange(page);
  };

  AnnotationManager.prototype._setSaveState = function (state) {
    this.saveState = state;
    if (this.onSaveStateChange) this.onSaveStateChange(state);
  };

  AnnotationManager.prototype._scheduleSave = function () {
    var self = this;
    this._setSaveState("dirty");
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(function () {
      self._flush();
    }, SAVE_DEBOUNCE_MS);
  };

  AnnotationManager.prototype._flush = function () {
    var self = this;
    this._setSaveState("saving");
    var payload = {
      version: 1,
      document: this.documentId,
      annotations: this.annotations,
      updatedAt: new Date().toISOString(),
    };
    return AnnotationStore.save(this.documentId, payload)
      .then(function () {
        self._setSaveState("saved");
      })
      .catch(function (err) {
        console.error("[memos-pdf-annotate] failed to save annotations", err);
        self._setSaveState("dirty");
      });
  };

  AnnotationManager.prototype.flushNow = function () {
    clearTimeout(this.saveTimer);
    return this._flush();
  };

  // ---------------------------------------------------------------------
  // pdf.js loading (lazy singleton). Loaded as an ES module via dynamic
  // import() so this file itself can stay a plain classic script (that is
  // how Memos injects "Additional Script" into the page).
  // ---------------------------------------------------------------------

  var pdfjsLibPromise = null;

  function loadPdfJs() {
    if (!pdfjsLibPromise) {
      pdfjsLibPromise = import(/* @vite-ignore */ PDFJS_BASE + "pdf.min.mjs").then(function (mod) {
        var lib = mod.default || mod;
        lib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + "pdf.worker.min.mjs";
        return lib;
      });
    }
    return pdfjsLibPromise;
  }

  // ---------------------------------------------------------------------
  // PDFPageView: one page's canvas (rendered by pdf.js) plus an SVG
  // annotation layer on top of it. The SVG viewBox is fixed to the page's
  // unscaled (scale=1) size, so annotation coordinates are stored once in
  // PDF page space and stay correctly positioned at any zoom level.
  // ---------------------------------------------------------------------

  function PDFPageView(viewer, pageNumber) {
    this.viewer = viewer;
    this.pageNumber = pageNumber;
    this.pdfPage = null;
    this.baseViewport = null;
    this.renderTask = null;
    this.rendered = false;
    this.textContent = null;
    this.drawing = null;

    this.el = el("div", { class: "mpa-page", "data-page": String(pageNumber) });
    this.canvas = el("canvas", { class: "mpa-canvas" });
    this.svg = svgEl("svg", { class: "mpa-annot-layer" });
    this.el.appendChild(this.canvas);
    this.el.appendChild(this.svg);

    this._attachPointerHandlers();
  }

  PDFPageView.prototype.ensureLoaded = function () {
    var self = this;
    if (this.pdfPage) return Promise.resolve(this.pdfPage);
    return this.viewer.pdfDoc.getPage(this.pageNumber).then(function (page) {
      self.pdfPage = page;
      self.baseViewport = page.getViewport({ scale: 1 });
      self.svg.setAttribute("viewBox", "0 0 " + self.baseViewport.width + " " + self.baseViewport.height);
      self._applySize(self.baseViewport.width * self.viewer.scale, self.baseViewport.height * self.viewer.scale);
      return page;
    });
  };

  PDFPageView.prototype._applySize = function (width, height) {
    this.el.style.width = width + "px";
    this.el.style.height = height + "px";
    this.svg.style.width = width + "px";
    this.svg.style.height = height + "px";
  };

  PDFPageView.prototype.render = function (scale) {
    var self = this;
    return this.ensureLoaded().then(function (page) {
      if (self.renderTask) {
        self.renderTask.cancel();
      }
      var viewport = page.getViewport({ scale: scale });
      var outputScale = window.devicePixelRatio || 1;
      self.canvas.width = Math.floor(viewport.width * outputScale);
      self.canvas.height = Math.floor(viewport.height * outputScale);
      self._applySize(viewport.width, viewport.height);

      var ctx = self.canvas.getContext("2d");
      var transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
      self.renderTask = page.render({ canvasContext: ctx, viewport: viewport, transform: transform });
      return self.renderTask.promise
        .then(function () {
          self.rendered = true;
          self.drawAnnotations();
        })
        .catch(function (err) {
          if (err && err.name !== "RenderingCancelledException") {
            console.error("[memos-pdf-annotate] render failed", err);
          }
        });
    });
  };

  PDFPageView.prototype.unrender = function () {
    if (this.renderTask) {
      this.renderTask.cancel();
      this.renderTask = null;
    }
    if (this.canvas.width && this.canvas.height) {
      var ctx = this.canvas.getContext("2d");
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.rendered = false;
  };

  PDFPageView.prototype.getTextContent = function () {
    var self = this;
    if (this.textContent) return Promise.resolve(this.textContent);
    return this.ensureLoaded()
      .then(function (page) {
        return page.getTextContent();
      })
      .then(function (tc) {
        self.textContent = tc;
        return tc;
      });
  };

  PDFPageView.prototype.drawAnnotations = function () {
    var self = this;
    Array.prototype.slice.call(this.svg.querySelectorAll("[data-annotation-id]")).forEach(function (node) {
      self.svg.removeChild(node);
    });
    this.viewer.manager.getForPage(this.pageNumber).forEach(function (annotation) {
      self.svg.appendChild(self._buildStrokeNode(annotation));
    });
  };

  PDFPageView.prototype._buildStrokeNode = function (annotation) {
    var d = pointsToPath(annotation.data.points);
    var node = svgEl("path", {
      d: d,
      fill: "none",
      stroke: annotation.style.color,
      "stroke-width": annotation.style.width,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      opacity: annotation.style.opacity,
      "data-annotation-id": annotation.id,
      "pointer-events": "stroke",
    });
    if (annotation.type === "highlight") {
      node.style.mixBlendMode = "multiply";
    }
    return node;
  };

  function pointsToPath(points) {
    if (!points || !points.length) return "";
    var parts = ["M " + points[0][0] + " " + points[0][1]];
    for (var i = 1; i < points.length; i++) {
      parts.push("L " + points[i][0] + " " + points[i][1]);
    }
    return parts.join(" ");
  }

  function pointNearPolyline(points, center, radius) {
    for (var i = 0; i < points.length; i++) {
      var dx = points[i][0] - center[0];
      var dy = points[i][1] - center[1];
      if (dx * dx + dy * dy <= radius * radius) return true;
    }
    return false;
  }

  // Splits a stroke's points into the runs that fall outside the eraser
  // circle, dropping any point inside it. A circle in the middle of a
  // stroke produces two surviving runs either side of the gap.
  function splitPointsOutsideRadius(points, center, radius) {
    var r2 = radius * radius;
    var runs = [];
    var current = [];
    for (var i = 0; i < points.length; i++) {
      var dx = points[i][0] - center[0];
      var dy = points[i][1] - center[1];
      if (dx * dx + dy * dy <= r2) {
        if (current.length) {
          runs.push(current);
          current = [];
        }
      } else {
        current.push(points[i]);
      }
    }
    if (current.length) runs.push(current);
    return runs;
  }

  PDFPageView.prototype._clientToPagePoint = function (clientX, clientY) {
    var rect = this.svg.getBoundingClientRect();
    var vb = this.svg.viewBox.baseVal;
    var x = ((clientX - rect.left) / rect.width) * vb.width;
    var y = ((clientY - rect.top) / rect.height) * vb.height;
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
  };

  PDFPageView.prototype._attachPointerHandlers = function () {
    var self = this;

    this.svg.addEventListener("pointerdown", function (e) {
      var tool = self.viewer.tool;
      if (tool === "pen" || tool === "highlight") {
        e.preventDefault();
        self.svg.setPointerCapture(e.pointerId);
        var point = self._clientToPagePoint(e.clientX, e.clientY);
        var annotationType = tool === "highlight" ? "highlight" : "ink";
        self.drawing = {
          pointerId: e.pointerId,
          type: annotationType,
          points: [point],
          style: {
            color: self.viewer.color,
            width: tool === "highlight" ? Math.max(self.viewer.size * 4, 12) : self.viewer.size,
            opacity: tool === "highlight" ? 0.35 : 1,
          },
        };
        self.previewNode = self._buildStrokeNode({
          id: "preview",
          type: annotationType,
          data: { points: self.drawing.points },
          style: self.drawing.style,
        });
        self.svg.appendChild(self.previewNode);
      } else if (tool === "eraser-stroke") {
        e.preventDefault();
        self.svg.setPointerCapture(e.pointerId);
        self._erasing = e.pointerId;
        self._eraseAt(e.clientX, e.clientY);
      } else if (tool === "eraser-precision") {
        e.preventDefault();
        self.svg.setPointerCapture(e.pointerId);
        self._erasing = e.pointerId;
        self._beginPrecisionErase();
        self._precisionEraseAt(e.clientX, e.clientY);
      }
    });

    this.svg.addEventListener("pointermove", function (e) {
      if (self.drawing && self.drawing.pointerId === e.pointerId) {
        var point = self._clientToPagePoint(e.clientX, e.clientY);
        var last = self.drawing.points[self.drawing.points.length - 1];
        var dx = point[0] - last[0];
        var dy = point[1] - last[1];
        if (dx * dx + dy * dy < 1.5) return;
        self.drawing.points.push(point);
        self.previewNode.setAttribute("d", pointsToPath(self.drawing.points));
      } else if (self._erasing === e.pointerId) {
        if (self._eraseSession) self._precisionEraseAt(e.clientX, e.clientY);
        else self._eraseAt(e.clientX, e.clientY);
      }
    });

    function finishDrawing(e) {
      if (self.drawing && self.drawing.pointerId === e.pointerId) {
        var drawing = self.drawing;
        self.drawing = null;
        if (self.previewNode) {
          self.svg.removeChild(self.previewNode);
          self.previewNode = null;
        }
        if (drawing.points.length >= 2) {
          self.viewer.manager.add({
            id: uid(),
            page: self.pageNumber,
            type: drawing.type,
            style: drawing.style,
            data: { points: drawing.points },
          });
        }
      }
      if (self._erasing === e.pointerId) {
        if (self._eraseSession) self._finishPrecisionErase();
        self._erasing = null;
      }
    }

    this.svg.addEventListener("pointerup", finishDrawing);
    this.svg.addEventListener("pointercancel", finishDrawing);
  };

  PDFPageView.prototype._eraseAt = function (clientX, clientY) {
    var target = document.elementFromPoint(clientX, clientY);
    if (target && target.dataset && target.dataset.annotationId) {
      this.viewer.manager.remove(target.dataset.annotationId);
    }
  };

  // Precision (area) eraser: unlike the stroke eraser, this removes only
  // the part of a stroke under the cursor, splitting it into whatever
  // fragments survive on either side. The whole drag is one undo step,
  // built by tracking a live "session" of touched annotations and only
  // committing to AnnotationManager on pointerup.
  PDFPageView.prototype._eraserRadius = function () {
    return Math.max(this.viewer.size * 2.5, 8);
  };

  PDFPageView.prototype._beginPrecisionErase = function () {
    this._eraseSession = { entries: new Map() };
  };

  PDFPageView.prototype._precisionEraseAt = function (clientX, clientY) {
    var self = this;
    var radius = this._eraserRadius();
    var point = this._clientToPagePoint(clientX, clientY);
    var session = this._eraseSession;

    this.viewer.manager.getForPage(this.pageNumber).forEach(function (ann) {
      if (session.entries.has(ann.id)) return;
      if (ann.type !== "ink" && ann.type !== "highlight") return;
      if (!pointNearPolyline(ann.data.points, point, radius)) return;
      session.entries.set(ann.id, {
        original: ann,
        style: ann.style,
        type: ann.type,
        current: [ann.data.points.slice()],
      });
    });

    var touchedAny = false;
    session.entries.forEach(function (entry) {
      var fragments = [];
      entry.current.forEach(function (points) {
        var runs = splitPointsOutsideRadius(points, point, radius);
        if (runs.length !== 1 || runs[0].length !== points.length) touchedAny = true;
        runs.forEach(function (run) {
          if (run.length >= 2) fragments.push(run);
        });
      });
      entry.current = fragments;
    });

    if (touchedAny) this._renderErasePreview();
  };

  PDFPageView.prototype._renderErasePreview = function () {
    var self = this;
    Array.prototype.slice.call(this.svg.querySelectorAll("[data-erase-preview]")).forEach(function (n) {
      self.svg.removeChild(n);
    });
    this._eraseSession.entries.forEach(function (entry, id) {
      var orig = self.svg.querySelector('[data-annotation-id="' + id + '"]');
      if (orig) orig.style.display = "none";
      entry.current.forEach(function (points, idx) {
        var node = self._buildStrokeNode({
          id: id + "__erase" + idx,
          type: entry.type,
          style: entry.style,
          data: { points: points },
        });
        node.setAttribute("data-erase-preview", "1");
        self.svg.appendChild(node);
      });
    });
  };

  PDFPageView.prototype._finishPrecisionErase = function () {
    var self = this;
    var session = this._eraseSession;
    this._eraseSession = null;
    if (!session || session.entries.size === 0) return;

    var removed = [];
    var added = [];
    session.entries.forEach(function (entry) {
      removed.push(entry.original);
      entry.current.forEach(function (points) {
        added.push({
          id: uid(),
          page: self.pageNumber,
          type: entry.type,
          style: entry.style,
          data: { points: points },
        });
      });
    });
    Array.prototype.slice.call(this.svg.querySelectorAll("[data-erase-preview]")).forEach(function (n) {
      self.svg.removeChild(n);
    });
    this.viewer.manager.applyErase(removed, added);
  };

  PDFPageView.prototype._discardPrecisionErase = function () {
    var self = this;
    if (!this._eraseSession) return;
    Array.prototype.slice.call(this.svg.querySelectorAll("[data-erase-preview]")).forEach(function (n) {
      self.svg.removeChild(n);
    });
    Array.prototype.slice.call(this.svg.querySelectorAll("[data-annotation-id]")).forEach(function (n) {
      n.style.display = "";
    });
    this._eraseSession = null;
  };

  PDFPageView.prototype.cancelDrawing = function () {
    if (this.drawing) {
      if (this.previewNode) {
        this.svg.removeChild(this.previewNode);
        this.previewNode = null;
      }
      this.drawing = null;
    }
    this._discardPrecisionErase();
    this._erasing = null;
  };

  PDFPageView.prototype.setToolMode = function (tool) {
    if (tool === "select") {
      this.svg.style.pointerEvents = "none";
      this.svg.style.touchAction = "auto";
    } else if (tool === "pan") {
      this.svg.style.pointerEvents = "none";
      this.svg.style.touchAction = "auto";
    } else {
      this.svg.style.pointerEvents = "auto";
      this.svg.style.touchAction = "none";
    }
  };

  // ---------------------------------------------------------------------
  // PDFAnnotationViewer: the modal viewer + toolbar + virtualized page
  // list. One instance per open PDF.
  // ---------------------------------------------------------------------

  function PDFAnnotationViewer(url, documentId, filename) {
    this.url = url;
    this.documentId = documentId;
    this.filename = filename;
    this.pdfDoc = null;
    this.pages = [];
    this.scale = 1;
    this.tool = "select";
    this.color = COLORS[0];
    this.size = SIZES[1];
    this.manager = new AnnotationManager(documentId);
    this.searchResults = [];
    this.searchIndex = -1;
    this._prevBodyOverflow = "";
    this._spaceHeldTool = null;
  }

  PDFAnnotationViewer.prototype.open = function () {
    var self = this;
    this._buildChrome();
    document.body.appendChild(this.root);
    this._prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    this._setStatus("Loading PDF…");

    return Promise.all([loadPdfJs(), this.manager.load()])
      .then(function (results) {
        var pdfjsLib = results[0];
        return pdfjsLib
          .getDocument({
            url: self.url,
            withCredentials: true,
            enableScripting: false,
            isEvalSupported: false,
          })
          .promise.catch(function () {
            return pdfjsLib.getDocument({
              url: self.url,
              withCredentials: true,
              enableScripting: false,
              isEvalSupported: false,
              disableWorker: true,
            }).promise;
          });
      })
      .then(function (pdfDoc) {
        self.pdfDoc = pdfDoc;
        self.numPages = pdfDoc.numPages;
        self._setStatus("");
        self.manager.onChange = function (page) {
          var pv = self.pages[page - 1];
          if (pv && pv.rendered) pv.drawAnnotations();
        };
        self.manager.onSaveStateChange = function (state) {
          self._updateSaveIndicator(state);
        };
        return self._buildPages();
      })
      .then(function () {
        return self._layoutPage1AndFit();
      })
      .then(function () {
        self._attachObserver();
        self._attachKeyboard();
        self._attachResize();
        self._setTool("select");
        self._updatePageIndicator();
        self._updateSaveIndicator(self.manager.saveState);
      })
      .catch(function (err) {
        console.error("[memos-pdf-annotate] failed to open PDF", err);
        self._setStatus("Failed to load PDF: " + (err && err.message ? err.message : String(err)));
      });
  };

  PDFAnnotationViewer.prototype._buildPages = function () {
    this.pagesEl.textContent = "";
    this.pages = [];
    for (var n = 1; n <= this.numPages; n++) {
      var pv = new PDFPageView(this, n);
      pv.setToolMode(this.tool);
      this.pages.push(pv);
      this.pagesEl.appendChild(pv.el);
    }
    return Promise.resolve();
  };

  PDFAnnotationViewer.prototype._layoutPage1AndFit = function () {
    var self = this;
    var first = this.pages[0];
    if (!first) return Promise.resolve();
    return first.ensureLoaded().then(function () {
      self.defaultBaseViewport = first.baseViewport;
      self._sizeUnrenderedPlaceholders();
      self._fitWidth();
    });
  };

  PDFAnnotationViewer.prototype._sizeUnrenderedPlaceholders = function () {
    var self = this;
    if (!this.defaultBaseViewport) return;
    this.pages.forEach(function (pv) {
      if (!pv.rendered) {
        var base = pv.baseViewport || self.defaultBaseViewport;
        pv._applySize(base.width * self.scale, base.height * self.scale);
        if (pv.baseViewport) {
          pv.svg.setAttribute("viewBox", "0 0 " + base.width + " " + base.height);
        }
      }
    });
  };

  PDFAnnotationViewer.prototype._attachObserver = function () {
    var self = this;
    this.observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var pv = self._pageByEl(entry.target);
          if (!pv) return;
          if (entry.isIntersecting) {
            if (!pv.rendered) pv.render(self.scale);
          } else if (pv.rendered) {
            pv.unrender();
          }
        });
      },
      { root: this.scrollEl, rootMargin: "100% 0px 100% 0px" },
    );
    this.pages.forEach(function (pv) {
      self.observer.observe(pv.el);
    });
    this.scrollEl.addEventListener("scroll", function () {
      self._scheduleCurrentPageUpdate();
    });
  };

  PDFAnnotationViewer.prototype._pageByEl = function (target) {
    for (var i = 0; i < this.pages.length; i++) {
      if (this.pages[i].el === target) return this.pages[i];
    }
    return null;
  };

  PDFAnnotationViewer.prototype._scheduleCurrentPageUpdate = function () {
    var self = this;
    if (this._pageUpdateRaf) return;
    this._pageUpdateRaf = requestAnimationFrame(function () {
      self._pageUpdateRaf = null;
      self._updateCurrentPageFromScroll();
    });
  };

  PDFAnnotationViewer.prototype._updateCurrentPageFromScroll = function () {
    var mid = this.scrollEl.scrollTop + this.scrollEl.clientHeight / 2;
    var acc = 0;
    var current = 1;
    for (var i = 0; i < this.pages.length; i++) {
      var height = this.pages[i].el.offsetHeight + PAGE_GAP;
      if (mid >= acc && mid < acc + height) {
        current = i + 1;
        break;
      }
      acc += height;
    }
    this.currentPage = current;
    this._updatePageIndicator();
  };

  PDFAnnotationViewer.prototype._attachResize = function () {
    var self = this;
    this._resizeHandler = function () {
      if (self.fitMode === "width") self._fitWidth();
      else if (self.fitMode === "page") self._fitPage();
    };
    window.addEventListener("resize", this._resizeHandler);
  };

  PDFAnnotationViewer.prototype._attachKeyboard = function () {
    var self = this;
    this._keydownHandler = function (e) {
      self._onKeyDown(e);
    };
    this._keyupHandler = function (e) {
      self._onKeyUp(e);
    };
    document.addEventListener("keydown", this._keydownHandler, true);
    document.addEventListener("keyup", this._keyupHandler, true);
  };

  function isTypingTarget(e) {
    var t = e.target;
    return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  }

  PDFAnnotationViewer.prototype._onKeyDown = function (e) {
    if (isTypingTarget(e)) return;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      this.manager.undo();
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      this.manager.redo();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      this._cancelActiveDrawing();
      this._setTool("select");
      return;
    }
    if (e.code === "Space" && !e.repeat) {
      e.preventDefault();
      this._spaceHeldTool = this.tool;
      this._setTool("pan");
      return;
    }
    switch (e.key.toLowerCase()) {
      case "v":
        this._setTool("select");
        break;
      case "h":
        this._setTool("highlight");
        break;
      case "p":
        this._setTool("pen");
        break;
      case "e":
        this._setTool(e.shiftKey ? "eraser-stroke" : "eraser-precision");
        break;
      default:
        break;
    }
  };

  PDFAnnotationViewer.prototype._onKeyUp = function (e) {
    if (e.code === "Space" && this._spaceHeldTool) {
      this._setTool(this._spaceHeldTool);
      this._spaceHeldTool = null;
    }
  };

  PDFAnnotationViewer.prototype._cancelActiveDrawing = function () {
    this.pages.forEach(function (pv) {
      pv.cancelDrawing();
    });
  };

  PDFAnnotationViewer.prototype._setTool = function (tool) {
    this.tool = tool;
    this.pages.forEach(function (pv) {
      pv.setToolMode(tool);
    });
    Array.prototype.slice.call(this.toolButtons.children).forEach(function (btn) {
      btn.classList.toggle("mpa-active", btn.dataset.tool === tool);
    });
    this.scrollEl.classList.toggle("mpa-pan-cursor", tool === "pan");
  };

  PDFAnnotationViewer.prototype._fitWidth = function () {
    if (!this.defaultBaseViewport) return;
    this.fitMode = "width";
    var available = this.scrollEl.clientWidth - PAGE_GAP * 2;
    this._setScale(clamp(available / this.defaultBaseViewport.width, MIN_SCALE, MAX_SCALE));
  };

  PDFAnnotationViewer.prototype._fitPage = function () {
    if (!this.defaultBaseViewport) return;
    this.fitMode = "page";
    var availableW = this.scrollEl.clientWidth - PAGE_GAP * 2;
    var availableH = this.scrollEl.clientHeight - PAGE_GAP * 2;
    var scale = Math.min(availableW / this.defaultBaseViewport.width, availableH / this.defaultBaseViewport.height);
    this._setScale(clamp(scale, MIN_SCALE, MAX_SCALE));
  };

  PDFAnnotationViewer.prototype._setScale = function (scale) {
    this.scale = scale;
    this._sizeUnrenderedPlaceholders();
    this.pages.forEach(function (pv) {
      if (pv.rendered) pv.render(scale);
    });
    this.zoomLabel.textContent = Math.round(scale * 100) + "%";
  };

  PDFAnnotationViewer.prototype._zoomBy = function (factor) {
    this.fitMode = null;
    this._setScale(clamp(this.scale * factor, MIN_SCALE, MAX_SCALE));
  };

  PDFAnnotationViewer.prototype._updatePageIndicator = function () {
    this.pageInput.value = String(this.currentPage || 1);
    this.pageCountLabel.textContent = "/ " + (this.numPages || "?");
  };

  PDFAnnotationViewer.prototype.goToPage = function (n) {
    var pv = this.pages[clamp(n, 1, this.numPages) - 1];
    if (!pv) return;
    pv.el.scrollIntoView({ block: "start" });
  };

  PDFAnnotationViewer.prototype._updateSaveIndicator = function (state) {
    var label = state === "saving" ? "Saving…" : state === "dirty" ? "Unsaved changes" : "Saved";
    this.saveLabel.textContent = label;
    this.saveLabel.className = "mpa-save-indicator mpa-save-" + state;
  };

  PDFAnnotationViewer.prototype._setStatus = function (text) {
    this.statusEl.textContent = text || "";
    this.statusEl.style.display = text ? "" : "none";
  };

  PDFAnnotationViewer.prototype.search = function (query) {
    var self = this;
    query = (query || "").trim().toLowerCase();
    this.searchResults = [];
    this.searchIndex = -1;
    if (!query) {
      this._updateSearchStatus();
      return Promise.resolve();
    }
    var chain = Promise.resolve();
    this.pages.forEach(function (pv) {
      chain = chain.then(function () {
        return pv.getTextContent().then(function (tc) {
          var text = tc.items
            .map(function (item) {
              return item.str;
            })
            .join(" ")
            .toLowerCase();
          if (text.indexOf(query) !== -1) {
            self.searchResults.push(pv.pageNumber);
          }
        });
      });
    });
    return chain.then(function () {
      if (self.searchResults.length) {
        self.searchIndex = 0;
        self.goToPage(self.searchResults[0]);
      }
      self._updateSearchStatus();
    });
  };

  PDFAnnotationViewer.prototype._searchStep = function (dir) {
    if (!this.searchResults.length) return;
    this.searchIndex = (this.searchIndex + dir + this.searchResults.length) % this.searchResults.length;
    this.goToPage(this.searchResults[this.searchIndex]);
    this._updateSearchStatus();
  };

  PDFAnnotationViewer.prototype._updateSearchStatus = function () {
    if (!this.searchResults.length) {
      this.searchStatus.textContent = this.searchInput.value.trim() ? "No matches" : "";
    } else {
      this.searchStatus.textContent = this.searchIndex + 1 + " / " + this.searchResults.length + " pages";
    }
  };

  PDFAnnotationViewer.prototype._toggleFullscreen = function () {
    if (!document.fullscreenElement) {
      (this.root.requestFullscreen || function () {}).call(this.root);
    } else {
      document.exitFullscreen();
    }
  };

  PDFAnnotationViewer.prototype._download = function () {
    var a = el("a", { href: this.url, download: this.filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  PDFAnnotationViewer.prototype.close = function () {
    var self = this;
    this.manager.flushNow().finally(function () {
      if (self.observer) self.observer.disconnect();
      window.removeEventListener("resize", self._resizeHandler);
      document.removeEventListener("keydown", self._keydownHandler, true);
      document.removeEventListener("keyup", self._keyupHandler, true);
      document.body.style.overflow = self._prevBodyOverflow;
      if (self.root.parentNode) self.root.parentNode.removeChild(self.root);
      if (window.__memosPdfAnnotate.activeViewer === self) {
        window.__memosPdfAnnotate.activeViewer = null;
      }
    });
  };

  // ---------------------------------------------------------------------
  // Chrome (header + toolbar) construction.
  // ---------------------------------------------------------------------

  PDFAnnotationViewer.prototype._buildChrome = function () {
    var self = this;
    ensureIconFont();

    this.statusEl = el("div", { class: "mpa-status" });

    this.pageInput = el("input", {
      class: "mpa-page-input",
      type: "text",
      inputmode: "numeric",
      "aria-label": "Page number",
      onchange: function () {
        var n = parseInt(self.pageInput.value, 10);
        if (!isNaN(n)) self.goToPage(n);
      },
    });
    this.pageCountLabel = el("span", { class: "mpa-page-count" });
    this.zoomLabel = el("span", { class: "mpa-zoom-label", text: "100%" });

    this.searchInput = el("input", {
      class: "mpa-search-input",
      type: "search",
      placeholder: "Search…",
      onkeydown: function (e) {
        if (e.key === "Enter") {
          if (e.shiftKey) self._searchStep(-1);
          else if (self.searchResults.length) self._searchStep(1);
          else self.search(self.searchInput.value);
        } else if (e.key === "Escape") {
          self._toggleSearchBar(false);
        }
      },
      oninput: function () {
        if (!self.searchInput.value.trim()) self.search("");
      },
    });
    this.searchStatus = el("span", { class: "mpa-search-status" });
    this.saveLabel = el("span", { class: "mpa-save-indicator", text: "Saved" });

    this.searchBar = el("div", { class: "mpa-searchbar" }, [
      this.searchInput,
      this.searchStatus,
      iconButton(ICONS.searchClose, "Close search", function () {
        self._toggleSearchBar(false);
      }),
    ]);

    var topbar = el("div", { class: "mpa-topbar" }, [
      el("span", { class: "mpa-filename", text: this.filename }),
      this.saveLabel,
      iconButton(ICONS.search, "Search", function () {
        self._toggleSearchBar();
      }),
      iconButton(ICONS.fullscreen, "Fullscreen", function () {
        self._toggleFullscreen();
      }),
      iconButton(ICONS.download, "Download original PDF", function () {
        self._download();
      }),
      iconButton(ICONS.close, "Close", function () {
        self.close();
      }, "mpa-close"),
    ]);

    var pagebar = el("div", { class: "mpa-pagebar" }, [
      el("div", { class: "mpa-pagebar-group" }, [
        iconButton(ICONS.prev, "Previous page", function () {
          self.goToPage((self.currentPage || 1) - 1);
        }),
        this.pageInput,
        this.pageCountLabel,
        iconButton(ICONS.next, "Next page", function () {
          self.goToPage((self.currentPage || 1) + 1);
        }),
      ]),
      el("div", { class: "mpa-pagebar-group" }, [
        iconButton(ICONS.zoomOut, "Zoom out", function () {
          self._zoomBy(0.9);
        }),
        this.zoomLabel,
        iconButton(ICONS.zoomIn, "Zoom in", function () {
          self._zoomBy(1.1);
        }),
        iconButton(ICONS.fitWidth, "Fit width", function () {
          self._fitWidth();
        }),
        iconButton(ICONS.fitPage, "Fit page", function () {
          self._fitPage();
        }),
      ]),
    ]);

    this.toolButtons = el("div", { class: "mpa-tools" }, [
      toolButton("select", ICONS.select, "Select (V)", function () {
        self._setTool("select");
      }),
      toolButton("pan", ICONS.pan, "Pan (Space)", function () {
        self._setTool("pan");
      }),
      toolButton("pen", ICONS.pen, "Pen (P)", function () {
        self._setTool("pen");
      }),
      toolButton("highlight", ICONS.highlight, "Highlight (H)", function () {
        self._setTool("highlight");
      }),
      toolButton("eraser-precision", ICONS.eraserPrecision, "Eraser (E) — erases only what you drag over", function () {
        self._setTool("eraser-precision");
      }),
      toolButton("eraser-stroke", ICONS.eraserStroke, "Erase whole stroke (Shift+E)", function () {
        self._setTool("eraser-stroke");
      }),
    ]);

    var colorRow = el("div", { class: "mpa-colors" });
    var customSwatch = el("button", { class: "mpa-swatch mpa-swatch-custom", type: "button", title: "Custom color…" });
    var customIcon = icon(ICONS.palette);
    customSwatch.appendChild(customIcon);
    var customColorInput = el("input", {
      class: "mpa-color-native",
      type: "color",
      value: self.color,
      "aria-label": "Custom color",
      oninput: function () {
        self.color = customColorInput.value;
        customSwatch.style.background = self.color;
        if (customIcon.parentNode) customSwatch.removeChild(customIcon);
        markActiveSwatch(customSwatch);
      },
    });
    customSwatch.addEventListener("click", function () {
      customColorInput.click();
    });

    function markActiveSwatch(active) {
      Array.prototype.slice.call(colorRow.querySelectorAll(".mpa-swatch")).forEach(function (c) {
        c.classList.toggle("mpa-active", c === active);
      });
    }

    COLORS.forEach(function (color) {
      var swatch = el("button", {
        class: "mpa-swatch",
        type: "button",
        title: color,
        style: "background:" + color,
        onclick: function () {
          self.color = color;
          markActiveSwatch(swatch);
        },
      });
      if (color === self.color) swatch.classList.add("mpa-active");
      colorRow.appendChild(swatch);
    });
    colorRow.appendChild(customSwatch);
    colorRow.appendChild(customColorInput);

    var sizeRow = el("div", { class: "mpa-sizes" });
    SIZES.forEach(function (size) {
      var dot = el("button", {
        class: "mpa-size-btn",
        type: "button",
        title: size + "px",
        onclick: function () {
          self.size = size;
          Array.prototype.slice.call(sizeRow.children).forEach(function (c) {
            c.classList.toggle("mpa-active", c === dot);
          });
        },
      });
      dot.appendChild(el("span", { style: "width:" + Math.max(size, 3) + "px;height:" + Math.max(size, 3) + "px" }));
      if (size === self.size) dot.classList.add("mpa-active");
      sizeRow.appendChild(dot);
    });

    var toolbar = el("div", { class: "mpa-toolbar" }, [
      this.toolButtons,
      el("span", { class: "mpa-sep" }),
      iconButton(ICONS.undo, "Undo (Ctrl/Cmd+Z)", function () {
        self.manager.undo();
      }),
      iconButton(ICONS.redo, "Redo (Ctrl/Cmd+Shift+Z)", function () {
        self.manager.redo();
      }),
      el("span", { class: "mpa-sep" }),
      colorRow,
      el("span", { class: "mpa-sep" }),
      sizeRow,
    ]);

    this.scrollEl = el("div", { class: "mpa-scroll" });
    this.pagesEl = el("div", { class: "mpa-pages" });
    this.scrollEl.appendChild(this.pagesEl);

    this.root = el("div", { class: "mpa-root", role: "dialog", "aria-modal": "true" }, [
      topbar,
      pagebar,
      this.searchBar,
      toolbar,
      this.statusEl,
      this.scrollEl,
    ]);
  };

  PDFAnnotationViewer.prototype._toggleSearchBar = function (force) {
    var show = force !== undefined ? force : !this.root.classList.contains("mpa-search-open");
    this.root.classList.toggle("mpa-search-open", show);
    if (show) {
      this.searchInput.focus();
    } else {
      this.searchInput.value = "";
      this.search("");
    }
  };

  // ---------------------------------------------------------------------
  // MemosAdapter: the only part of this file that knows about Memos' DOM.
  // It looks for attachment download links (a stable, functional
  // attribute set by the app) rather than styling classes, so it should
  // keep working across Memos frontend releases. See README section
  // "Why this selector" for details.
  // ---------------------------------------------------------------------

  var MemosAdapter = {
    ATTACHMENT_SELECTOR: 'a[download][href*="/file/attachments/"]',
    ID_RE: /\/file\/(attachments\/[^/?#]+)\//,

    findPdfAttachmentLinks: function (root) {
      var links = (root || document).querySelectorAll(this.ATTACHMENT_SELECTOR);
      var result = [];
      for (var i = 0; i < links.length; i++) {
        if (this._isPdfLink(links[i])) result.push(links[i]);
      }
      return result;
    },

    _isPdfLink: function (anchor) {
      var href = anchor.getAttribute("href") || "";
      var title = anchor.getAttribute("title") || "";
      return /\.pdf(?:[?#]|$)/i.test(href) || /\.pdf$/i.test(title);
    },

    getAttachmentId: function (anchor) {
      var href = anchor.getAttribute("href") || "";
      var match = href.match(this.ID_RE);
      return match ? match[1] : null;
    },

    getAttachmentUrl: function (anchor) {
      return new URL(anchor.getAttribute("href"), window.location.origin).toString();
    },

    getFilename: function (anchor) {
      var title = anchor.getAttribute("title") || "";
      var stripped = title.replace(/^Download\s+/, "");
      return stripped || (this.getAttachmentId(anchor) || "document") + ".pdf";
    },
  };

  // Clicking a PDF attachment opens the annotator directly — that's the
  // "link the annotator to the attached file" behavior — while a small
  // icon button preserves the plain download Memos offered before. A
  // modified click (ctrl/cmd/shift/alt/middle-click) is left alone so
  // "open in new tab" / "save link as" still work as the browser expects.
  function decorateAttachmentLink(anchor) {
    if (anchor.dataset.mpaProcessed) return;
    var documentId = MemosAdapter.getAttachmentId(anchor);
    if (!documentId) return;
    anchor.dataset.mpaProcessed = "1";
    anchor.classList.add("mpa-linked-attachment");
    anchor.title = "Open " + MemosAdapter.getFilename(anchor) + " in the PDF viewer";

    anchor.addEventListener("click", function (e) {
      if (e.button === 1 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openViewer(MemosAdapter.getAttachmentUrl(anchor), documentId, MemosAdapter.getFilename(anchor));
    });

    var downloadBtn = iconButton(ICONS.download, "Download original PDF", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var a = el("a", { href: MemosAdapter.getAttachmentUrl(anchor), download: MemosAdapter.getFilename(anchor) });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }, "mpa-download-trigger");
    anchor.insertAdjacentElement("afterend", downloadBtn);
  }

  function openViewer(url, documentId, filename) {
    var store = window.__memosPdfAnnotate;
    if (store.activeViewer) {
      if (store.activeViewer.documentId === documentId) return;
      store.activeViewer.close();
    }
    var viewer = new PDFAnnotationViewer(url, documentId, filename);
    store.activeViewer = viewer;
    viewer.open();
  }

  function scanForAttachments() {
    MemosAdapter.findPdfAttachmentLinks(document).forEach(decorateAttachmentLink);
  }

  var scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanForAttachments, 150);
  }

  function bootstrap() {
    ensureIconFont();
    scanForAttachments();
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length) {
          scheduleScan();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
