/* global React */
/* eslint-disable */

// =====================================================================
// Mailer Editor — sliding sheet that lets the user configure fold type,
// panel count, orientation, page assignment, tear-off panel, and DRAW
// perforation lines directly on a PDF preview.
// =====================================================================

const { useState, useEffect, useRef } = React;

const FOLD_TYPES = [
  { value: 'cfold',  label: 'C-fold (letter)' },
  { value: 'zfold',  label: 'Z-fold (accordion)' },
  { value: 'gate',   label: 'Gate-fold' },
  { value: 'half',   label: 'Half-fold' },
];

const ORIENTATIONS = [
  { value: 'vertical',   label: 'Vertical (opens up like a calendar)' },
  { value: 'horizontal', label: 'Horizontal (opens like a brochure)' },
];

// Paper-size presets, natural-portrait (w <= h) in inches.
const PAGE_PRESETS = [
  { id: 'tabloid',     label: 'Tabloid (11 × 17)',       w: 11,   h: 17 },
  { id: 'letter',      label: 'Letter (8.5 × 11)',        w: 8.5,  h: 11 },
  { id: 'legal',       label: 'Legal (8.5 × 14)',         w: 8.5,  h: 14 },
  { id: 'a4',          label: 'A4 (8.27 × 11.69)',        w: 8.27, h: 11.69 },
  { id: 'half-letter', label: 'Half-letter (5.5 × 8.5)',  w: 5.5,  h: 8.5 },
  { id: 'postcard',    label: 'Postcard (4 × 6)',         w: 4,    h: 6 },
];

function matchPagePreset(w, h) {
  return PAGE_PRESETS.find(p => Math.abs(p.w - w) < 0.02 && Math.abs(p.h - h) < 0.02);
}

// ---------------------------------------------------------------------
// Default crease positions per fold type.
// ---------------------------------------------------------------------
function getDefaultCreases(foldType, numPanels) {
  if (numPanels === 2) return [0.5];
  if (numPanels === 3) {
    // C-fold: tuck panel slightly smaller so it fits inside the others.
    if (foldType === 'cfold') return [0.32, 0.66];
    return [1/3, 2/3];
  }
  if (numPanels === 4) {
    // Roll fold: each panel slightly smaller than the next.
    if (foldType === 'cfold') return [0.27, 0.51, 0.75];
    return [0.25, 0.5, 0.75];
  }
  return Array.from({ length: numPanels - 1 }, (_, i) => (i + 1) / numPanels);
}

// Default perforation: a single line along the crease bordering the tear panel.
function getDefaultPerforations(numPanels, orientation, creases, tearPanel) {
  if (tearPanel == null || tearPanel < 0 || tearPanel >= numPanels) return [];
  const idx = tearPanel < numPanels - 1 ? tearPanel : tearPanel - 1;
  const pos = creases[idx];
  if (pos == null) return [];
  return orientation === 'vertical'
    ? [{ x1: 0, y1: pos, x2: 1, y2: pos }]
    : [{ x1: pos, y1: 0, x2: pos, y2: 1 }];
}

// ---------------------------------------------------------------------
// PDF page with perforation drawing overlay
// ---------------------------------------------------------------------
const PageWithPerforations = ({
  canvas, pageIdx, label,
  perforations, onAddPerf, onRemovePerf, onMovePerf,
  creases, onAddCrease, onRemoveCrease, onMoveCrease,
  orientation, placementMode, onConsumeMode,
  annotations = [], onAddAnnotation, onEditAnnotation, onUpdateAnnotation, onDeleteAnnotation,
  editingAnnotationId, onCloseEditAnnotation,
}) => {
  const wrapRef = useRef(null);
  const suppressClickRef = useRef(false);
  const perfDragRef = useRef(null); // { idx, startCoords, original, moved }
  const [drawingFrom, setDrawingFrom] = useState(null);
  const [hoverPoint, setHoverPoint] = useState(null);
  const [draggingCrease, setDraggingCrease] = useState(null);
  const [draggingPerf, setDraggingPerf] = useState(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !canvas) return;
    // Mount the source canvas inside our wrap as the background.
    // We don't directly insert the source canvas (that would steal it
    // from the viewer); instead draw it into a child canvas.
    const child = wrap.querySelector('canvas.page-bg') || document.createElement('canvas');
    child.className = 'page-bg';
    child.width = canvas.width;
    child.height = canvas.height;
    child.getContext('2d').drawImage(canvas, 0, 0);
    if (!child.parentElement) wrap.prepend(child);
  }, [canvas]);

  const eventCoords = (e) => {
    const rect = wrapRef.current.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top)  / rect.height,
    };
  };

  const handlePointerDown = (e) => {
    // Skip if the click started on a remove button.
    if (e.target?.closest?.('.grip-x')) return;
    const creaseEl = e.target?.closest?.('[data-crease-idx]');
    if (creaseEl) {
      setDraggingCrease(+creaseEl.getAttribute('data-crease-idx'));
      e.preventDefault();
      e.stopPropagation();
      wrapRef.current?.setPointerCapture?.(e.pointerId);
      return;
    }
    const perfEl = e.target?.closest?.('[data-perf-idx]');
    if (perfEl) {
      const idx = +perfEl.getAttribute('data-perf-idx');
      perfDragRef.current = {
        idx,
        startCoords: eventCoords(e),
        original: perforations[idx],
        moved: false,
      };
      e.preventDefault();
      e.stopPropagation();
      wrapRef.current?.setPointerCapture?.(e.pointerId);
    }
  };

  const handlePointerMove = (e) => {
    if (draggingCrease != null) {
      const { x, y } = eventCoords(e);
      const raw = orientation === 'vertical' ? y : x;
      const min = draggingCrease === 0 ? 0.05 : creases[draggingCrease - 1] + 0.05;
      const max = draggingCrease === creases.length - 1 ? 0.95 : creases[draggingCrease + 1] - 0.05;
      onMoveCrease(draggingCrease, Math.max(min, Math.min(max, raw)));
      return;
    }
    // Always track hover position while in placement mode for the guide line.
    if (placementMode === 'crease') {
      setHoverPoint(eventCoords(e));
    }
    if (perfDragRef.current) {
      const cur = eventCoords(e);
      const p = perfDragRef.current;
      const dx = cur.x - p.startCoords.x;
      const dy = cur.y - p.startCoords.y;
      if (!p.moved && Math.hypot(dx, dy) > 0.01) {
        p.moved = true;
        setDraggingPerf(p.idx);
      }
      if (p.moved) {
        const o = p.original;
        const c = (v) => Math.max(0, Math.min(1, v));
        onMovePerf(p.idx, { x1: c(o.x1 + dx), y1: c(o.y1 + dy), x2: c(o.x2 + dx), y2: c(o.y2 + dy) });
      }
      return;
    }
    if (drawingFrom) setHoverPoint(eventCoords(e));
  };

  const handlePointerUp = (e) => {
    if (draggingCrease != null) {
      setDraggingCrease(null);
      suppressClickRef.current = true;
      wrapRef.current?.releasePointerCapture?.(e.pointerId);
      return;
    }
    if (perfDragRef.current) {
      const { idx, moved } = perfDragRef.current;
      perfDragRef.current = null;
      setDraggingPerf(null);
      wrapRef.current?.releasePointerCapture?.(e.pointerId);
      if (moved) {
        suppressClickRef.current = true;
      } else {
        // Treat as a tap → remove this perforation
        suppressClickRef.current = true;
        onRemovePerf(idx);
      }
    }
  };

  const handleClick = (e) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    if (draggingCrease != null) return;
    if (draggingPerf != null) return;
    if (e.target?.closest?.('[data-crease-idx]')) return;
    if (e.target?.closest?.('[data-perf-idx]')) return;
    if (!wrapRef.current) return;
    const { x, y } = eventCoords(e);

    if (placementMode === 'crease') {
      const pos = orientation === 'vertical' ? y : x;
      onAddCrease?.(Math.max(0.05, Math.min(0.95, pos)));
      onConsumeMode?.();
      return;
    }

    if (placementMode === 'annotation') {
      onAddAnnotation?.(x, y);
      onConsumeMode?.();
      return;
    }

    if (placementMode === 'perf' || drawingFrom) {
      if (!drawingFrom) {
        setDrawingFrom({ x, y });
      } else {
        let x1 = drawingFrom.x, y1 = drawingFrom.y, x2 = x, y2 = y;
        const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
        if (dy < 0.04) { y2 = y1; }
        else if (dx < 0.04) { x2 = x1; }
        onAddPerf({ x1, y1, x2, y2 });
        setDrawingFrom(null);
        setHoverPoint(null);
        onConsumeMode?.();
      }
      return;
    }
    // Otherwise: click on empty page space does nothing.
  };

  const creaseLineCoords = (t) => orientation === 'vertical'
    ? { x1: 0, y1: t, x2: 1, y2: t }
    : { x1: t, y1: 0, x2: t, y2: 1 };
  const creaseResize = orientation === 'vertical' ? 'ns-resize' : 'ew-resize';

  // Midpoint of a perforation line, used to anchor the drag-handle badge.
  const perfMid = (p) => ({ x: (p.x1 + p.x2) / 2, y: (p.y1 + p.y2) / 2 });

  const wrapClasses = [
    'page-wrap',
    drawingFrom ? 'drawing' : '',
    placementMode ? `placing placing-${placementMode}` : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="page-card">
      <div className="page-label">{label}</div>
      <div
        ref={wrapRef}
        className={wrapClasses}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div className="page-legend">
          <span><span className="swatch fold" />{creases.length} fold{creases.length === 1 ? '' : 's'}</span>
          <span><span className="swatch perf" />{perforations.length} perf{perforations.length === 1 ? '' : 's'}</span>
        </div>
        <svg className="page-overlay" viewBox="0 0 1 1" preserveAspectRatio="none">
          {/* Placement guide: live preview of where a new fold will land */}
          {placementMode === 'crease' && hoverPoint && (() => {
            const t = orientation === 'vertical' ? hoverPoint.y : hoverPoint.x;
            const c = orientation === 'vertical'
              ? { x1: 0, y1: t, x2: 1, y2: t }
              : { x1: t, y1: 0, x2: t, y2: 1 };
            return (
              <g>
                <line {...c} stroke="#ffd23a" strokeOpacity="0.9" strokeWidth="0.006"
                      strokeDasharray="0.02 0.012" vectorEffect="non-scaling-stroke" />
                <line {...c} stroke="#ffd23a" strokeOpacity="0.15" strokeWidth="0.02"
                      vectorEffect="non-scaling-stroke" />
              </g>
            );
          })()}
          {/* Fold-line guides — bright dashed cyan */}
          {creases.map((c, i) => (
            <line
              key={`fold-vis-${i}`}
              {...creaseLineCoords(c)}
              className="crease-line"
              stroke={draggingCrease === i ? '#7bd1ff' : 'rgba(123,209,255,0.85)'}
              strokeWidth={draggingCrease === i ? '0.009' : '0.0055'}
              strokeDasharray="0.018 0.012"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* Wide invisible hit area for dragging the whole fold line */}
          {creases.map((c, i) => (
            <line
              key={`fold-hit-${i}`}
              {...creaseLineCoords(c)}
              stroke="transparent"
              strokeWidth="0.06"
              vectorEffect="non-scaling-stroke"
              data-crease-idx={i}
              className="crease-hit"
              style={{ cursor: creaseResize, pointerEvents: 'all' }}
            >
              <title>Drag to move fold</title>
            </line>
          ))}
          {/* Crease grip badges in the middle of each fold */}
          {creases.map((c, i) => {
            const cx = orientation === 'vertical' ? 0.5 : c;
            const cy = orientation === 'vertical' ? c : 0.5;
            const active = draggingCrease === i;
            return (
              <g
                key={`fold-grip-${i}`}
                transform={`translate(${cx} ${cy})`}
                data-crease-idx={i}
                className="crease-grip"
                style={{ cursor: creaseResize, pointerEvents: 'all' }}
              >
                <circle r="0.026"
                        fill={active ? '#7bd1ff' : 'rgba(20,22,27,0.92)'}
                        stroke="#7bd1ff" strokeWidth="0.005"
                        vectorEffect="non-scaling-stroke" />
                {/* Two short parallel bars perpendicular to the fold */}
                {orientation === 'vertical' ? (
                  <>
                    <line x1="-0.012" y1="-0.005" x2="0.012" y2="-0.005"
                          stroke={active ? '#14181f' : '#7bd1ff'} strokeWidth="0.005"
                          vectorEffect="non-scaling-stroke" strokeLinecap="round" />
                    <line x1="-0.012" y1="0.005"  x2="0.012" y2="0.005"
                          stroke={active ? '#14181f' : '#7bd1ff'} strokeWidth="0.005"
                          vectorEffect="non-scaling-stroke" strokeLinecap="round" />
                  </>
                ) : (
                  <>
                    <line x1="-0.005" y1="-0.012" x2="-0.005" y2="0.012"
                          stroke={active ? '#14181f' : '#7bd1ff'} strokeWidth="0.005"
                          vectorEffect="non-scaling-stroke" strokeLinecap="round" />
                    <line x1="0.005"  y1="-0.012" x2="0.005"  y2="0.012"
                          stroke={active ? '#14181f' : '#7bd1ff'} strokeWidth="0.005"
                          vectorEffect="non-scaling-stroke" strokeLinecap="round" />
                  </>
                )}
                <title>Drag to move fold {i + 1}</title>
              </g>
            );
          })}
          {/* Existing perforations */}
          {perforations.map((p, i) => {
            const active = draggingPerf === i;
            const mid = perfMid(p);
            return (
              <g key={i} className="perf-group">
                <line
                  x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2}
                  stroke={active ? '#ff9479' : '#e15a45'}
                  strokeWidth={active ? '0.011' : '0.0085'}
                  strokeDasharray="0.018 0.012"
                  vectorEffect="non-scaling-stroke"
                />
                {/* Wide invisible hit area */}
                <line
                  x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2}
                  stroke="transparent"
                  strokeWidth="0.06"
                  vectorEffect="non-scaling-stroke"
                  data-perf-idx={i}
                  className="perf-hit"
                  style={{ cursor: 'grab', pointerEvents: 'all' }}
                >
                  <title>Drag to move · click to remove</title>
                </line>
                {/* Grip badge in the middle */}
                <g
                  transform={`translate(${mid.x} ${mid.y})`}
                  data-perf-idx={i}
                  className="perf-grip"
                  style={{ cursor: 'grab', pointerEvents: 'all' }}
                >
                  <circle r="0.024"
                          fill={active ? '#ff9479' : 'rgba(20,22,27,0.92)'}
                          stroke="#e15a45" strokeWidth="0.005"
                          vectorEffect="non-scaling-stroke" />
                  <path d="M -0.008 -0.002 L 0.008 -0.002 M -0.008 0.002 L 0.008 0.002 M -0.008 0.006 L 0.008 0.006 M -0.008 -0.006 L 0.008 -0.006"
                        stroke={active ? '#14181f' : '#e15a45'} strokeWidth="0.003"
                        vectorEffect="non-scaling-stroke" fill="none" />
                  <title>Drag to move perforation</title>
                </g>
              </g>
            );
          })}
          {/* Live drawing preview */}
          {drawingFrom && hoverPoint && (
            <line
              x1={drawingFrom.x} y1={drawingFrom.y}
              x2={hoverPoint.x}  y2={hoverPoint.y}
              stroke="#c8412e" strokeOpacity="0.65"
              strokeWidth="0.006"
              strokeDasharray="0.012 0.008"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {drawingFrom && (
            <circle cx={drawingFrom.x} cy={drawingFrom.y} r="0.01"
                    fill="#c8412e" stroke="#fff" strokeWidth="0.003"
                    vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {/* HTML labels: numbered chip + × remove badge for each fold and perf.
            The chip itself participates in pointer events so dragging it
            starts a crease/perf drag (closest('[data-…]') finds it). */}
        <div className="grip-labels">
          {creases.map((c, i) => {
            const left = orientation === 'vertical' ? 50 : c * 100;
            const top  = orientation === 'vertical' ? c * 100 : 50;
            const canRemove = creases.length > 1;
            return (
              <div key={`fold-lbl-${i}`} className="grip-label crease"
                   style={{ left: `${left}%`, top: `${top}%` }}>
                <span
                  className="grip-num"
                  data-crease-idx={i}
                  style={{ cursor: orientation === 'vertical' ? 'ns-resize' : 'ew-resize' }}
                  title={`Drag fold ${i + 1}`}
                >{i + 1}</span>
                {canRemove && (
                  <button className="grip-x" title={`Remove fold ${i + 1}`}
                          onClick={(e) => { e.stopPropagation(); onRemoveCrease?.(i); }}>
                    ×
                  </button>
                )}
              </div>
            );
          })}
          {perforations.map((p, i) => {
            const mx = (p.x1 + p.x2) / 2, my = (p.y1 + p.y2) / 2;
            return (
              <div key={`perf-lbl-${i}`} className="grip-label perf"
                   style={{ left: `${mx * 100}%`, top: `${my * 100}%` }}>
                <span
                  className="grip-num"
                  data-perf-idx={i}
                  style={{ cursor: 'grab' }}
                  title={`Drag perforation ${i + 1}`}
                >{i + 1}</span>
                <button className="grip-x" title={`Remove perforation ${i + 1}`}
                        onClick={(e) => { e.stopPropagation(); onRemovePerf(i); }}>
                  ×
                </button>
              </div>
            );
          })}
          {/* Annotation pins for this page (positions are in page-normalized coords) */}
          {annotations.map((a, j) => {
            const boundaries = [0, ...creases, 1];
            const pSize = (boundaries[a.panelIdx + 1] ?? 1) - (boundaries[a.panelIdx] ?? 0);
            const pStart = boundaries[a.panelIdx] ?? 0;
            const pageX = orientation === 'vertical' ? a.x : pStart + a.x * pSize;
            const pageY = orientation === 'vertical' ? pStart + a.y * pSize : a.y;
            const isEditing = editingAnnotationId === a.id;
            // The 240px popup is anchored 18px to the right of the pin.
            // If the pin sits past ~60% of the page width it would clip
            // outside the page-card container — flip it to the left.
            const popupX = pageX > 0.6 ? 'left' : 'right';
            return (
              <div
                key={`ann-${a.id}`}
                className={`editor-ann ${a.isNeed ? 'need' : ''} ${isEditing ? 'editing' : ''} popup-x-${popupX}`}
                style={{ left: `${pageX * 100}%`, top: `${pageY * 100}%` }}
              >
                <button
                  className="editor-ann-pin"
                  title={a.content || 'Click to edit note'}
                  onClick={(e) => { e.stopPropagation(); onEditAnnotation?.(a.id); }}
                >
                  {a.isNeed ? '!' : (j + 1)}
                </button>
                {isEditing && (
                  <div className="editor-ann-edit" onClick={(e) => e.stopPropagation()}>
                    <textarea
                      className="ann-textarea"
                      placeholder="What does the client need to know?"
                      value={a.content}
                      autoFocus
                      onChange={(e) => onUpdateAnnotation?.(a.id, { content: e.target.value })}
                    />
                    <label className="ann-need-toggle">
                      <input type="checkbox" checked={!!a.isNeed}
                             onChange={(e) => onUpdateAnnotation?.(a.id, { isNeed: e.target.checked })} />
                      Flag as a Need (red)
                    </label>
                    <div className="ann-edit-actions">
                      <button className="ctrl-btn" onClick={() => onDeleteAnnotation?.(a.id)}>Delete</button>
                      <button className="ctrl-btn primary" onClick={() => onCloseEditAnnotation?.()}>Done</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="page-help">
        {placementMode === 'crease' ? 'Click anywhere on this page to place a new fold · Esc to cancel'
          : placementMode === 'perf' ? (drawingFrom ? 'Click the end point of the perforation' : 'Click the start point of the perforation · Esc to cancel')
          : draggingCrease != null ? 'Drag to reposition the fold · release to commit'
          : draggingPerf != null ? 'Drag to move the perforation · release to commit'
          : 'Drag a grip to move · click × to remove · use the + buttons above to add'}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------
// Editor sheet
// ---------------------------------------------------------------------
const MailerEditor = ({
  open, onClose, config, setConfig, pages, onResetSample,
  library = [], libraryError = null, serverAvailable = false,
  authRequired = false, adminToken = '',
  onSetAdminToken, onUploadFile, onSelectFromLibrary, onDeleteFromLibrary, onRefreshLibrary,
}) => {
  const fileRef = useRef(null);
  const [placementMode, setPlacementMode] = useState(null); // null | 'crease' | 'perf' | 'annotation'
  const [editingAnnotationId, setEditingAnnotationId] = useState(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  // ESC cancels placement mode if active; otherwise closes the editor.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (placementMode) setPlacementMode(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, placementMode]);

  if (!open) return null;

  const update = (patch) => setConfig(c => {
    const next = { ...c, ...patch };
    if ('numPanels' in patch) {
      next.tearPanel = clampTear(next.tearPanel, next.numPanels);
    }
    const creaseReset = 'foldType' in patch || 'numPanels' in patch;
    if (creaseReset) {
      next.creasePositions = getDefaultCreases(next.foldType, next.numPanels);
    }
    const perfReset = creaseReset || 'orientation' in patch || 'tearPanel' in patch;
    if (perfReset) {
      const creases = next.creasePositions
        || Array.from({ length: next.numPanels - 1 }, (_, i) => (i + 1) / next.numPanels);
      next.perforations = getDefaultPerforations(next.numPanels, next.orientation, creases, next.tearPanel);
    }
    return next;
  });

  // Library upload — POSTs to /api/uploads and switches the active mailer.
  // Falls back to local-only preview if the server isn't reachable.
  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // allow re-picking the same file
    setUploadError(null);
    if (serverAvailable && onUploadFile) {
      setUploadBusy(true);
      try {
        await onUploadFile(file);
      } catch (err) {
        setUploadError(err.message || 'Upload failed');
      } finally {
        setUploadBusy(false);
      }
      return;
    }
    // Fallback: local preview only — share-link recipients won't see this PDF.
    const r = new FileReader();
    r.onload = () => {
      setConfig(c => ({
        ...c,
        pdfUrl: null,
        pdfDataUrl: r.result,
        pdfName: file.name.replace(/\.pdf$/i, ''),
        perforations: [],
      }));
    };
    r.readAsDataURL(file);
  };

  // Save the current local-preview PDF to the library so it's shareable.
  const handleSaveLocalToLibrary = async () => {
    if (!config.pdfDataUrl || !onUploadFile) return;
    setUploadError(null);
    setUploadBusy(true);
    try {
      // Convert data URL back to a File for the upload API.
      const res = await fetch(config.pdfDataUrl);
      const blob = await res.blob();
      const filename = (config.pdfName || 'mailer').replace(/[^a-zA-Z0-9._-]+/g, '_') + '.pdf';
      const file = new File([blob], filename, { type: 'application/pdf' });
      await onUploadFile(file);
    } catch (err) {
      setUploadError(err.message || 'Save failed');
    } finally {
      setUploadBusy(false);
    }
  };

  const handleSelectLibrary = (url) => {
    if (!url) return;
    const item = library.find(i => i.url === url);
    if (item && onSelectFromLibrary) onSelectFromLibrary(item);
  };

  const handleDeleteCurrent = async () => {
    const item = library.find(i => i.url === config.pdfUrl);
    if (!item) return;
    if (!confirm(`Delete "${item.name}" from the library? Share links pointing at it will stop working.`)) return;
    try {
      await onDeleteFromLibrary?.(item.filename);
    } catch (err) {
      setUploadError(err.message || 'Delete failed');
    }
  };

  const currentLibraryItem = library.find(i => i.url === config.pdfUrl);
  const isLocalOnly = !!config.pdfDataUrl && !config.pdfUrl;

  const handleAddPerf = (perf) => {
    setConfig(c => ({ ...c, perforations: [...c.perforations, perf] }));
  };
  const handleRemovePerf = (idx) => {
    setConfig(c => ({ ...c, perforations: c.perforations.filter((_, i) => i !== idx) }));
  };
  const handleMovePerf = (idx, next) => {
    setConfig(c => ({
      ...c,
      perforations: c.perforations.map((p, i) => i === idx ? next : p),
    }));
  };

  // Equal-division creases for the current panel count
  const equalCreases = Array.from({ length: config.numPanels - 1 }, (_, i) => (i + 1) / config.numPanels);
  // Current creases used by the preview (custom or equal)
  const activeCreases = (Array.isArray(config.creasePositions)
    && config.creasePositions.length === config.numPanels - 1)
    ? config.creasePositions
    : equalCreases;
  const ensureCreaseArray = (c) => (Array.isArray(c.creasePositions)
      && c.creasePositions.length === c.numPanels - 1)
      ? [...c.creasePositions]
      : Array.from({ length: c.numPanels - 1 }, (_, i) => (i + 1) / c.numPanels);
  const handleMoveCrease = (idx, pos) => {
    setConfig(c => {
      const base = ensureCreaseArray(c);
      base[idx] = pos;
      return { ...c, creasePositions: base };
    });
  };
  const handleAddCrease = (pos) => {
    setConfig(c => {
      const base = ensureCreaseArray(c);
      const next = [...base, Math.max(0.05, Math.min(0.95, pos))].sort((a, b) => a - b);
      const newN = next.length + 1;
      return {
        ...c,
        creasePositions: next,
        numPanels: newN,
        tearPanel: clampTear(c.tearPanel, newN),
      };
    });
  };
  const handleRemoveCrease = (idx) => {
    setConfig(c => {
      const base = ensureCreaseArray(c);
      if (base.length <= 1) return c; // keep at least one fold (2 panels)
      const next = base.filter((_, i) => i !== idx);
      const newN = next.length + 1;
      return {
        ...c,
        creasePositions: next,
        numPanels: newN,
        tearPanel: clampTear(c.tearPanel, newN),
      };
    });
  };
  const resetCreases = () => setConfig(c => ({ ...c, creasePositions: null }));
  const creasesAreCustom = Array.isArray(config.creasePositions);

  // Annotation handlers (editor variants)
  const handleAddAnnotationFromPage = (pageIdx, x, y) => {
    const orientation = config.orientation;
    const boundaries = [0, ...activeCreases, 1];
    const t = orientation === 'vertical' ? y : x;
    let panelIdx = -1;
    for (let i = 0; i < boundaries.length - 1; i++) {
      if (t >= boundaries[i] && t < boundaries[i + 1]) { panelIdx = i; break; }
    }
    if (panelIdx < 0) panelIdx = activeCreases.length; // edge case → last panel
    const a = boundaries[panelIdx], b = boundaries[panelIdx + 1];
    const localT = Math.max(0, Math.min(1, (t - a) / (b - a)));
    const localX = orientation === 'vertical' ? x : localT;
    const localY = orientation === 'vertical' ? localT : y;
    const side = pageIdx === config.outsidePageIdx ? 'outside'
                : pageIdx === config.insidePageIdx ? 'inside'
                : 'inside';
    const id = 'a' + Math.random().toString(36).slice(2, 9);
    setConfig(c => ({
      ...c,
      annotations: [...(c.annotations || []), { id, panelIdx, x: localX, y: localY, content: '', isNeed: false, side }],
    }));
    setPlacementMode(null);
    setEditingAnnotationId(id);
  };
  const handleUpdateAnnotation = (id, patch) => {
    setConfig(c => ({
      ...c,
      annotations: (c.annotations || []).map(a => a.id === id ? { ...a, ...patch } : a),
    }));
  };
  const handleDeleteAnnotation = (id) => {
    setConfig(c => ({
      ...c,
      annotations: (c.annotations || []).filter(a => a.id !== id),
    }));
    setEditingAnnotationId(null);
  };

  // tear-panel options
  const tearOptions = [
    { value: -1, label: 'No tear-off' },
    ...Array.from({ length: config.numPanels }, (_, i) => ({
      value: i,
      label: config.orientation === 'vertical'
        ? `Panel ${i+1} (${i === 0 ? 'top' : i === config.numPanels-1 ? 'bottom' : 'middle'})`
        : `Panel ${i+1} (${i === 0 ? 'left' : i === config.numPanels-1 ? 'right' : 'middle'})`,
    })),
  ];

  return (
    <div className="editor-overlay" onClick={onClose}>
      <div className="editor-sheet" onClick={e => e.stopPropagation()}>
        <div className="editor-header">
          <div>
            <div className="editor-title">Configure Mailer</div>
            <div className="editor-sub">{config.pdfName}</div>
          </div>
          <button className="editor-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="editor-body">
          {/* LEFT — controls */}
          <div className="editor-controls">

            <section className="edt-section">
              <h4>Mailer library</h4>

              {serverAvailable && library.length > 0 && (
                <select
                  className="edt-field"
                  value={config.pdfUrl || ''}
                  onChange={e => handleSelectLibrary(e.target.value)}
                >
                  <option value="">— Pick a mailer —</option>
                  {library.map(item => (
                    <option key={item.url} value={item.url}>
                      {item.name} ({(item.size / 1024 / 1024).toFixed(1)} MB)
                    </option>
                  ))}
                </select>
              )}

              <button
                className="edt-btn"
                onClick={() => fileRef.current?.click()}
                disabled={uploadBusy}
              >
                {uploadBusy ? 'Uploading…' : (serverAvailable ? '+ Upload PDF to library' : 'Preview a PDF locally')}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf,.pdf"
                style={{ display: 'none' }}
                onChange={handleUpload}
              />

              {currentLibraryItem && (
                <button className="edt-btn ghost" onClick={handleDeleteCurrent} disabled={uploadBusy}>
                  Delete this mailer from library
                </button>
              )}

              {isLocalOnly && (
                <div className="lib-warn">
                  <strong>Local preview only.</strong> Share links won't show this
                  PDF to recipients — save it to the library to make it shareable.
                  {serverAvailable && (
                    <button
                      className="edt-btn primary"
                      style={{ marginTop: 8 }}
                      onClick={handleSaveLocalToLibrary}
                      disabled={uploadBusy}
                    >
                      {uploadBusy ? 'Saving…' : 'Save to library'}
                    </button>
                  )}
                </div>
              )}

              {!serverAvailable && (
                <div className="edt-hint">
                  Server library unavailable — running in local-preview-only mode.
                  Share links will fall back to the bundled sample for recipients.
                </div>
              )}

              {(uploadError || libraryError) && (
                <div className="lib-error">{uploadError || libraryError}</div>
              )}

              {authRequired && serverAvailable && (
                <div className="edt-row" style={{ marginTop: 8 }}>
                  <label className="edt-row-label">Admin token</label>
                  <input
                    className="edt-field"
                    type="password"
                    placeholder="Paste ADMIN_KEY"
                    value={adminToken}
                    onChange={e => onSetAdminToken?.(e.target.value)}
                  />
                </div>
              )}

              <button className="edt-btn ghost" onClick={onResetSample}>
                Reset to default sample
              </button>

              <div className="edt-hint">
                {serverAvailable
                  ? 'Drag & drop a PDF anywhere to upload it to the library.'
                  : 'Drag & drop a PDF anywhere to preview it locally.'}
              </div>
            </section>

            <section className="edt-section">
              <h4>Mailer details</h4>
              <div className="edt-hint">
                Shown to clients at the top of the share view. Saved per
                mailer — switching to a different PDF restores its own text.
              </div>
              <div className="edt-row">
                <label className="edt-row-label">Title</label>
                <input
                  className="edt-field"
                  type="text"
                  placeholder={config.pdfName || 'Mailer title'}
                  value={config.pdfTitle || ''}
                  onChange={e => update({ pdfTitle: e.target.value })}
                />
              </div>
              <div className="edt-row">
                <label className="edt-row-label">Description</label>
                <textarea
                  className="edt-field"
                  rows="3"
                  placeholder="A short note for the client — what this mailer is, the campaign, anything they should know."
                  value={config.pdfDescription || ''}
                  onChange={e => update({ pdfDescription: e.target.value })}
                />
              </div>
            </section>

            <section className="edt-section">
              <h4>Page size</h4>
              <select
                className="edt-field"
                value={matchPagePreset(config.pageWidth, config.pageHeight)?.id || 'custom'}
                onChange={e => {
                  const p = PAGE_PRESETS.find(x => x.id === e.target.value);
                  if (p) update({ pageWidth: p.w, pageHeight: p.h });
                }}
              >
                {PAGE_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                {!matchPagePreset(config.pageWidth, config.pageHeight) && (
                  <option value="custom">
                    Custom ({config.pageWidth} × {config.pageHeight})
                  </option>
                )}
              </select>
              <div className="edt-row">
                <label className="edt-row-label">W (in)</label>
                <input
                  className="edt-field" type="number" min="1" step="0.1"
                  value={config.pageWidth}
                  onChange={e => update({ pageWidth: Math.max(0.5, parseFloat(e.target.value) || 0) })}
                />
                <label className="edt-row-label">H (in)</label>
                <input
                  className="edt-field" type="number" min="1" step="0.1"
                  value={config.pageHeight}
                  onChange={e => update({ pageHeight: Math.max(0.5, parseFloat(e.target.value) || 0) })}
                />
              </div>
              <div className="edt-hint">
                Sheet rotates to match the fold orientation — long edge runs along the fold axis.
              </div>
            </section>

            <section className="edt-section">
              <h4>Fold type</h4>
              <select className="edt-field" value={config.foldType}
                      onChange={e => update({ foldType: e.target.value })}>
                {FOLD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <div className="edt-hint">
                Changing this re-applies typical crease and perforation positions for that fold style.
              </div>
            </section>

            <section className="edt-section">
              <h4>Orientation</h4>
              <div className="edt-radio-group">
                {ORIENTATIONS.map(o => (
                  <label key={o.value} className={`edt-radio ${config.orientation === o.value ? 'on' : ''}`}>
                    <input
                      type="radio"
                      name="orient"
                      checked={config.orientation === o.value}
                      onChange={() => update({ orientation: o.value })}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            </section>

            <section className="edt-section">
              <h4>Number of panels</h4>
              <div className="edt-seg">
                {[2,3,4].map(n => (
                  <button
                    key={n}
                    className={`edt-seg-btn ${config.numPanels === n ? 'on' : ''}`}
                    onClick={() => update({ numPanels: n })}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </section>

            <section className="edt-section">
              <h4>Fold positions</h4>
              <div className="edt-hint">
                {creasesAreCustom
                  ? `Custom: ${activeCreases.map(v => (v * 100).toFixed(0) + '%').join(' · ')}`
                  : 'Equal divisions — drag a dashed line in the preview to customize.'}
              </div>
              {creasesAreCustom && (
                <button className="edt-btn ghost" onClick={resetCreases}>
                  Reset to equal panels
                </button>
              )}
            </section>

            <section className="edt-section">
              <h4>Page assignment</h4>
              {pages && pages.length > 1 ? (
                <>
                  <div className="edt-row">
                    <label className="edt-row-label">Outside</label>
                    <select className="edt-field" value={config.outsidePageIdx}
                            onChange={e => update({ outsidePageIdx: +e.target.value })}>
                      {pages.map((_, i) => <option key={i} value={i}>Page {i+1}</option>)}
                    </select>
                  </div>
                  <div className="edt-row">
                    <label className="edt-row-label">Inside</label>
                    <select className="edt-field" value={config.insidePageIdx}
                            onChange={e => update({ insidePageIdx: +e.target.value })}>
                      {pages.map((_, i) => <option key={i} value={i}>Page {i+1}</option>)}
                    </select>
                  </div>
                </>
              ) : (
                <div className="edt-hint">PDF has only one page — both sides use it.</div>
              )}
              <label className="edt-check">
                <input
                  type="checkbox"
                  checked={(config.outsidePageOrient || 'normal') === 'rotate180'}
                  onChange={e => update({ outsidePageOrient: e.target.checked ? 'rotate180' : 'normal' })}
                />
                Flip outside 180°
              </label>
              <label className="edt-check">
                <input
                  type="checkbox"
                  checked={(config.insidePageOrient || 'normal') === 'rotate180'}
                  onChange={e => update({ insidePageOrient: e.target.checked ? 'rotate180' : 'normal' })}
                />
                Flip inside 180° (head-to-head)
              </label>
              <details className="edt-collapse">
                <summary>Advanced orientation</summary>
                <div className="edt-row">
                  <label className="edt-row-label">Outside</label>
                  <select className="edt-field" value={config.outsidePageOrient || 'normal'}
                          onChange={e => update({ outsidePageOrient: e.target.value })}>
                    <option value="normal">Normal</option>
                    <option value="rotate180">Rotate 180°</option>
                    <option value="flipH">Mirror horizontal</option>
                    <option value="flipV">Mirror vertical</option>
                  </select>
                </div>
                <div className="edt-row">
                  <label className="edt-row-label">Inside</label>
                  <select className="edt-field" value={config.insidePageOrient || 'normal'}
                          onChange={e => update({ insidePageOrient: e.target.value })}>
                    <option value="normal">Normal</option>
                    <option value="rotate180">Rotate 180°</option>
                    <option value="flipH">Mirror horizontal</option>
                    <option value="flipV">Mirror vertical</option>
                  </select>
                </div>
              </details>
            </section>

            <section className="edt-section">
              <h4>Per-panel flip</h4>
              <div className="edt-hint">Rotate or mirror an individual panel's outside or inside artwork. Use this when a single panel (e.g. the cover) was authored upside-down in the source PDF.</div>
              {Array.from({ length: config.numPanels }, (_, i) => {
                const pickOrient = (sideArr) =>
                  (Array.isArray(sideArr) && sideArr[i])
                  || (Array.isArray(config.panelOrients) && config.panelOrients[i])
                  || 'normal';
                const outsideCur = pickOrient(config.panelOrientsOutside);
                const insideCur  = pickOrient(config.panelOrientsInside);
                const updateSide = (key, value) => {
                  const sideArr = config[key];
                  const arr = Array.from({ length: config.numPanels }, (_, j) => {
                    if (j === i) return value;
                    return (Array.isArray(sideArr) && sideArr[j])
                      || (Array.isArray(config.panelOrients) && config.panelOrients[j])
                      || 'normal';
                  });
                  update({ [key]: arr });
                };
                return (
                  <div key={i} className="edt-panel-flip">
                    <div className="edt-panel-flip-label">Panel {i + 1}</div>
                    <div className="edt-row">
                      <label className="edt-row-label">Outside</label>
                      <select className="edt-field" value={outsideCur}
                              onChange={(e) => updateSide('panelOrientsOutside', e.target.value)}>
                        <option value="normal">Normal</option>
                        <option value="rotate180">Rotate 180°</option>
                        <option value="flipH">Mirror horizontal</option>
                        <option value="flipV">Mirror vertical</option>
                      </select>
                    </div>
                    <div className="edt-row">
                      <label className="edt-row-label">Inside</label>
                      <select className="edt-field" value={insideCur}
                              onChange={(e) => updateSide('panelOrientsInside', e.target.value)}>
                        <option value="normal">Normal</option>
                        <option value="rotate180">Rotate 180°</option>
                        <option value="flipH">Mirror horizontal</option>
                        <option value="flipV">Mirror vertical</option>
                      </select>
                    </div>
                  </div>
                );
              })}
              {((Array.isArray(config.panelOrientsOutside) && config.panelOrientsOutside.some(o => o && o !== 'normal'))
                || (Array.isArray(config.panelOrientsInside) && config.panelOrientsInside.some(o => o && o !== 'normal'))
                || (Array.isArray(config.panelOrients) && config.panelOrients.some(o => o && o !== 'normal'))) && (
                <button className="edt-btn ghost" onClick={() => update({ panelOrientsOutside: null, panelOrientsInside: null, panelOrients: null })}>
                  Reset all panel flips
                </button>
              )}
            </section>

            <section className="edt-section">
              <h4>Inside fit</h4>
              <div className="edt-slider">
                <label>Zoom</label>
                <input type="range" min="0.5" max="1.5" step="0.01"
                       value={config.insideScale ?? 1}
                       onChange={e => update({ insideScale: parseFloat(e.target.value) })} />
                <span className="edt-slider-val">{((config.insideScale ?? 1) * 100).toFixed(0)}%</span>
              </div>
              <div className="edt-slider">
                <label>Shift Y</label>
                <input type="range" min="-0.3" max="0.3" step="0.005"
                       value={config.insideOffsetY ?? 0}
                       onChange={e => update({ insideOffsetY: parseFloat(e.target.value) })} />
                <span className="edt-slider-val">{((config.insideOffsetY ?? 0) * 100).toFixed(0)}%</span>
              </div>
              <div className="edt-slider">
                <label>Shift X</label>
                <input type="range" min="-0.3" max="0.3" step="0.005"
                       value={config.insideOffsetX ?? 0}
                       onChange={e => update({ insideOffsetX: parseFloat(e.target.value) })} />
                <span className="edt-slider-val">{((config.insideOffsetX ?? 0) * 100).toFixed(0)}%</span>
              </div>
              {((config.insideScale ?? 1) !== 1 || (config.insideOffsetX ?? 0) !== 0 || (config.insideOffsetY ?? 0) !== 0) && (
                <button className="edt-btn ghost"
                        onClick={() => update({ insideScale: 1, insideOffsetX: 0, insideOffsetY: 0 })}>
                  Reset inside fit
                </button>
              )}
              <div className="edt-hint">Use if the inside artwork is slightly off-position relative to the outside.</div>
            </section>

            <section className="edt-section">
              <h4>Tear-off panel</h4>
              <select className="edt-field"
                      value={config.tearPanel == null ? -1 : config.tearPanel}
                      onChange={e => {
                        const v = +e.target.value;
                        update({ tearPanel: v === -1 ? null : v });
                      }}>
                {tearOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <div className="edt-hint">The marked panel detaches when the user drags the perforation.</div>
            </section>

            <section className="edt-section">
              <h4>Cosmetics</h4>
              <label className="edt-check">
                <input type="checkbox" checked={config.showPerforation}
                       onChange={e => update({ showPerforation: e.target.checked })} />
                Show perforation lines
              </label>
              <label className="edt-check">
                <input type="checkbox" checked={config.showCreases}
                       onChange={e => update({ showCreases: e.target.checked })} />
                Show fold creases
              </label>
              <div className="edt-row">
                <label className="edt-row-label">Background</label>
                <select className="edt-field" value={config.background}
                        onChange={e => update({ background: e.target.value })}>
                  <option value="studio">Studio</option>
                  <option value="table">Table</option>
                  <option value="void">Void</option>
                  <option value="daylight">Daylight</option>
                </select>
              </div>
              <div className="edt-row">
                <label className="edt-row-label">Resolution</label>
                <select className="edt-field" value={config.renderScale || 0.6}
                        onChange={e => update({ renderScale: parseFloat(e.target.value) })}>
                  <option value="0.6">Standard (0.6×)</option>
                  <option value="1">HD (1×)</option>
                  <option value="1.5">Ultra (1.5×)</option>
                  <option value="2">Print (2×) — slow</option>
                </select>
              </div>
              <div className="edt-hint">Higher resolution sharpens the artwork; reloads the PDF.</div>
            </section>

          </div>

          {/* RIGHT — PDF preview with perforation drawing */}
          <div className="editor-preview">
            <div className="edt-preview-title">
              Folds &amp; perforations
              <span className="edt-preview-sub">
                Drag grips to move · click × to remove · use the buttons to add new ones
              </span>
            </div>
            <div className="edt-tools">
              <button
                className={`edt-btn small ${placementMode === 'crease' ? 'primary' : ''}`}
                onClick={() => setPlacementMode(placementMode === 'crease' ? null : 'crease')}
              >
                + Add fold
              </button>
              <button
                className={`edt-btn small ${placementMode === 'perf' ? 'primary' : ''}`}
                onClick={() => setPlacementMode(placementMode === 'perf' ? null : 'perf')}
              >
                + Add perforation
              </button>
              <button
                className={`edt-btn small ${placementMode === 'annotation' ? 'primary' : ''}`}
                onClick={() => setPlacementMode(placementMode === 'annotation' ? null : 'annotation')}
              >
                + Add note
              </button>
              {placementMode && (
                <span className="edt-mode-hint">
                  Click a page below to place
                  {placementMode === 'crease' ? ' a fold'
                    : placementMode === 'perf' ? ' a perforation (2 clicks)'
                    : ' a note'} · Esc to cancel
                </span>
              )}
            </div>
            <div className="page-grid">
              {!pages && <div className="edt-hint">Loading PDF…</div>}
              {pages && pages.map((c, i) => {
                const side = i === config.outsidePageIdx ? 'outside'
                            : i === config.insidePageIdx ? 'inside'
                            : null;
                const pageAnnotations = (config.annotations || []).filter(a =>
                  (a.side || 'inside') === side
                );
                return (
                  <PageWithPerforations
                    key={i}
                    canvas={c}
                    pageIdx={i}
                    label={`Page ${i+1}${i === config.outsidePageIdx ? ' · Outside' : i === config.insidePageIdx ? ' · Inside' : ''}`}
                    perforations={config.perforations}
                    onAddPerf={handleAddPerf}
                    onRemovePerf={handleRemovePerf}
                    onMovePerf={handleMovePerf}
                    creases={activeCreases}
                    onAddCrease={handleAddCrease}
                    onRemoveCrease={handleRemoveCrease}
                    onMoveCrease={handleMoveCrease}
                    orientation={config.orientation}
                    placementMode={placementMode}
                    onConsumeMode={() => setPlacementMode(null)}
                    annotations={pageAnnotations}
                    onAddAnnotation={(x, y) => handleAddAnnotationFromPage(i, x, y)}
                    onEditAnnotation={(id) => setEditingAnnotationId(id)}
                    onUpdateAnnotation={handleUpdateAnnotation}
                    onDeleteAnnotation={handleDeleteAnnotation}
                    editingAnnotationId={editingAnnotationId}
                    onCloseEditAnnotation={() => setEditingAnnotationId(null)}
                  />
                );
              })}
            </div>
          </div>
        </div>

        <div className="editor-footer">
          <button className="edt-btn ghost" onClick={onResetSample}>Reset all to default</button>
          <button className="edt-btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
};

function clampTear(v, n) {
  if (v == null) return null;
  if (v < 0 || v >= n) return null;
  return v;
}

window.MailerEditor = MailerEditor;
