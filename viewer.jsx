/* global React */
/* eslint-disable */

// =====================================================================
// 3D Mailer Viewer — reads a config object describing the fold and
// renders an interactive preview of the mailer with that geometry.
// =====================================================================

const { useState, useRef, useEffect, useLayoutEffect, useMemo } = React;

const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));

const BG_PRESETS = {
  studio:   "radial-gradient(120% 80% at 50% 35%, #2a2e36 0%, #14171c 55%, #0a0c10 100%)",
  table:    "radial-gradient(120% 80% at 50% 70%, #6b5a40 0%, #382d1d 55%, #1c1610 100%)",
  void:     "radial-gradient(120% 80% at 50% 50%, #0a0c10 0%, #000 100%)",
  daylight: "linear-gradient(180deg, #d8e4ec 0%, #a8b5be 60%, #6e7882 100%)",
};

// Fold short of 180° so the flaps tilt forward into +Z. At/near 180° the
// flap is coplanar with the anchor, which (a) hides the visible 3D angle,
// (b) lets sub-pixel GPU jitter leak the face-front (interior) art through
// the face-back (exterior), AND (c) for tri-fold C-fold lets the outer
// wrap intersect the inner tuck panel because both flaps land in nearly
// the same plane. Capping at 165° keeps the mailer visibly closed without
// any panel-on-panel clipping. The world-space translateZ stack offset
// applied BEFORE the rotation handles the remaining separation.
const FOLD_MAX = 165;

// ---------------------------------------------------------------------
// Crease helpers — return fold positions and panel boundaries along the
// fold axis. creasePositions overrides equal divisions when set.
// ---------------------------------------------------------------------
function getCreases(config) {
  const n = config.numPanels - 1;
  const custom = config.creasePositions;
  if (Array.isArray(custom) && custom.length === n
      && custom.every(v => typeof v === 'number' && v > 0 && v < 1)) {
    return custom;
  }
  const out = [];
  for (let i = 1; i < config.numPanels; i++) out.push(i / config.numPanels);
  return out;
}

function getBoundaries(config) {
  return [0, ...getCreases(config), 1];
}

// ---------------------------------------------------------------------
// Geometry — sheet dimensions and per-panel layout from config
// ---------------------------------------------------------------------
function computeGeometry(config) {
  const { numPanels, orientation } = config;
  const DPI = 100;
  // Natural-portrait dimensions; orientation rotates them into the scene.
  const w = (config.pageWidth  ?? 11) * DPI;
  const h = (config.pageHeight ?? 17) * DPI;
  const pageShort = Math.min(w, h);
  const pageLong  = Math.max(w, h);

  const vertical = orientation === 'vertical';
  // Sheet dimensions (in scene-space px)
  const sheetW = vertical ? pageShort : pageLong;
  const sheetH = vertical ? pageLong  : pageShort;

  const boundaries = getBoundaries(config);
  const anchorIdx = Math.floor(numPanels / 2); // middle-ish

  const panels = [];
  for (let i = 0; i < numPanels; i++) {
    const start = boundaries[i];
    const end   = boundaries[i + 1];
    const size  = end - start;
    panels.push({
      i,
      start, end,
      x: vertical ? 0           : start * sheetW,
      y: vertical ? start * sheetH : 0,
      w: vertical ? sheetW       : size * sheetW,
      h: vertical ? size * sheetH : sheetH,
      isAnchor: i === anchorIdx,
      // Distance from anchor (-N..-1, 0, 1..N) — used to chain hinge transforms.
      offsetFromAnchor: i - anchorIdx,
    });
  }
  return { sheetW, sheetH, panels, anchorIdx, vertical };
}

// ---------------------------------------------------------------------
// Fold angle for each panel given fold progress 0..1
// ---------------------------------------------------------------------
function computeFoldAngles(config, fold) {
  const { numPanels, foldType } = config;
  const angles = new Array(numPanels).fill(0);
  if (numPanels === 1) return angles;

  const flapCount = numPanels - 1;
  // Staged progress: first flap unfolds in first 1/flapCount of the slider,
  // second flap in next slice, etc.
  const stage = (n) => clamp(fold * flapCount - n, 0, 1);

  // For tri-panel (numPanels=3): anchor=panel 1; flaps are 0 (top/left) and 2 (bottom/right).
  // For 2-panel: anchor=panel 1; flap is 0.
  // For 4-panel: anchor=panel 2; flaps are 0,1 (upper) and 3 (lower).

  if (numPanels === 3) {
    const flap0Progress = stage(0);  // top/left flap unfolds first
    const flap2Progress = stage(1);  // bottom/right second
    // C-fold: both flaps fold forward, opposite signs (default)
    // Z-fold: same signs → opposite physical direction (accordion)
    // Gate / half: visually like C-fold for 3-panel
    const zfold = foldType === 'zfold';
    angles[0] =  FOLD_MAX * (1 - flap0Progress);
    angles[2] = (zfold ? 1 : -1) * FOLD_MAX * (1 - flap2Progress);
  } else if (numPanels === 2) {
    // Half-fold (single hinge). Direction reverses for "zfold" so back side shows.
    const progress = stage(0);
    const sign = foldType === 'zfold' ? -1 : 1;
    angles[0] = sign * FOLD_MAX * (1 - progress);
  } else if (numPanels === 4) {
    // 0,1,2,3 — anchor=2. Three flaps.
    const p0 = stage(0), p1 = stage(1), p2 = stage(2);
    if (foldType === 'zfold') {
      angles[0] =  FOLD_MAX * (1 - p0);
      angles[1] = -FOLD_MAX * (1 - p1);
      angles[3] =  FOLD_MAX * (1 - p2);
    } else {
      // C-fold, gate, half — all collapse inward
      angles[0] =  FOLD_MAX * (1 - p0);
      angles[1] =  FOLD_MAX * (1 - p1) * 0.5;
      angles[3] = -FOLD_MAX * (1 - p2);
    }
  }
  return angles;
}

// Resolve a page orient ('normal' | 'rotate180' | 'flipH' | 'flipV') into
// the slice region (in source-space) and the per-slice mirror flags.
function resolveSlice(start, end, axis, orient) {
  let flipH = false, flipV = false;
  if (orient === 'rotate180') { flipH = true; flipV = true; }
  else if (orient === 'flipH') flipH = true;
  else if (orient === 'flipV') flipV = true;
  let s = start, e = end;
  if (axis === 'vertical' && flipV) { s = 1 - end; e = 1 - start; }
  if (axis === 'horizontal' && flipH) { s = 1 - end; e = 1 - start; }
  return { start: s, end: e, flipH, flipV };
}

// ---------------------------------------------------------------------
// PanelArt — draws the relevant slice of a PDF page canvas into a child
// canvas. start/end: normalized 0-1 positions along the fold axis.
// orient: per-page print orientation. extraFlip{H,V}: additional mirror
// applied AFTER the orient (used by back faces of horizontal/vertical
// folds to keep text readable when flipped over).
// ---------------------------------------------------------------------
// Per-panel orient as a CSS transform fragment (applied AFTER the
// page-level orient is already baked into the canvas content).
function panelOrientCss(panelOrient) {
  switch (panelOrient) {
    case 'rotate180': return 'rotate(180deg)';
    case 'flipH':     return 'scaleX(-1)';
    case 'flipV':     return 'scaleY(-1)';
    default:          return '';
  }
}

const PanelArt = ({ src, start, end, axis, orient = 'normal', extraFlipH = false, extraFlipV = false, scale = 1, offsetX = 0, offsetY = 0, panelOrient = 'normal' }) => {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !src) return;
    const sw = src.width, sh = src.height;
    const { start: s, end: e, flipH: oFlipH, flipV: oFlipV } = resolveSlice(start, end, axis, orient);
    let sx, sy, sliceW, sliceH;
    if (axis === 'vertical') {
      sliceW = sw;
      sliceH = sh * (e - s);
      sx = 0;
      sy = sh * s;
    } else {
      sliceW = sw * (e - s);
      sliceH = sh;
      sx = sw * s;
      sy = 0;
    }
    canvas.width = Math.max(1, Math.round(sliceW));
    canvas.height = Math.max(1, Math.round(sliceH));
    const ctx = canvas.getContext('2d');
    ctx.save();
    const flipH = oFlipH !== extraFlipH;
    const flipV = oFlipV !== extraFlipV;
    if (flipH) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    if (flipV) { ctx.translate(0, canvas.height); ctx.scale(1, -1); }
    ctx.drawImage(src, sx, sy, sliceW, sliceH, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }, [src, start, end, axis, orient, extraFlipH, extraFlipV]);
  if (!src) return null;
  // CSS transform applied to the rendered canvas for visual zoom/offset
  // and per-panel flip. Parent .face has overflow:hidden which letterboxes
  // anything that would otherwise spill past the panel.
  const orientCss = panelOrientCss(panelOrient);
  const needsTransform = scale !== 1 || offsetX !== 0 || offsetY !== 0 || orientCss;
  const style = needsTransform
    ? { transform: `translate(${offsetX * 100}%, ${offsetY * 100}%) scale(${scale}) ${orientCss}`.trim(),
        transformOrigin: 'center' }
    : undefined;
  return <canvas ref={ref} className="pdf-art" style={style} />;
};

// ---------------------------------------------------------------------
// PerforationOverlay — renders dashed red lines on a panel face based
// on config.perforations. Each line is in NORMALIZED 0-1 coords of
// the ORIGINAL OUTSIDE PAGE. We clip it to this panel's slice.
// ---------------------------------------------------------------------
const PerforationOverlay = ({ config, panel }) => {
  if (!config.showPerforation || !config.perforations?.length) return null;
  const vertical = config.orientation === 'vertical';
  const t0 = panel.start, t1 = panel.end;

  // Convert page-normalized coords to PANEL-LOCAL normalized coords
  const lines = [];
  for (const p of config.perforations) {
    let p1, p2;
    if (vertical) {
      const clipped = clipLineToYRange(p, t0, t1);
      if (!clipped) continue;
      const localY1 = (clipped.y1 - t0) / (t1 - t0);
      const localY2 = (clipped.y2 - t0) / (t1 - t0);
      p1 = { x: clipped.x1, y: localY1 };
      p2 = { x: clipped.x2, y: localY2 };
    } else {
      const clipped = clipLineToXRange(p, t0, t1);
      if (!clipped) continue;
      const localX1 = (clipped.x1 - t0) / (t1 - t0);
      const localX2 = (clipped.x2 - t0) / (t1 - t0);
      p1 = { x: localX1, y: clipped.y1 };
      p2 = { x: localX2, y: clipped.y2 };
    }
    lines.push({ p1, p2 });
  }
  if (!lines.length) return null;

  return (
    <svg className="perf-overlay" viewBox="0 0 1 1" preserveAspectRatio="none">
      {lines.map((l, i) => (
        <line
          key={i}
          x1={l.p1.x} y1={l.p1.y} x2={l.p2.x} y2={l.p2.y}
          stroke="#c8412e"
          strokeWidth="0.006"
          strokeDasharray="0.012 0.008"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
};

function clipLineToYRange(line, y0, y1) {
  let { x1, y1: ya, x2, y2: yb } = line;
  const minY = Math.min(ya, yb), maxY = Math.max(ya, yb);
  if (maxY < y0 || minY > y1) return null;
  // Parametric clip
  const clip = (yClip) => {
    if (ya === yb) return null;
    const t = (yClip - ya) / (yb - ya);
    return { x: x1 + t * (x2 - x1), y: yClip };
  };
  let a = { x: x1, y: ya }, b = { x: x2, y: yb };
  if (ya < y0) a = clip(y0);
  if (yb < y0) b = clip(y0);
  if (ya > y1) a = clip(y1);
  if (yb > y1) b = clip(y1);
  if (!a || !b) return null;
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}
function clipLineToXRange(line, x0, x1) {
  let { x1: xa, y1, x2: xb, y2 } = line;
  const minX = Math.min(xa, xb), maxX = Math.max(xa, xb);
  if (maxX < x0 || minX > x1) return null;
  const clip = (xClip) => {
    if (xa === xb) return null;
    const t = (xClip - xa) / (xb - xa);
    return { x: xClip, y: y1 + t * (y2 - y1) };
  };
  let a = { x: xa, y: y1 }, b = { x: xb, y: y2 };
  if (xa < x0) a = clip(x0);
  if (xb < x0) b = clip(x0);
  if (xa > x1) a = clip(x1);
  if (xb > x1) b = clip(x1);
  if (!a || !b) return null;
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

// ---------------------------------------------------------------------
// Compute the world-space Z component of a panel face's surface normal,
// given the panel's hinge angle, the fold axis, the side (inside/outside),
// and the current camera rotation. The face is facing the camera when
// this value is positive — used to hide pins on faces that are currently
// turned away from the viewer (e.g. an "inside" note when the mailer is
// closed and the cover is facing the camera).
// ---------------------------------------------------------------------
function faceNormalZ(side, panelAngleDeg, axis, cameraXDeg, cameraYDeg) {
  // Local face normal in panel-local coords. face-front = +Z, face-back
  // = -Z (the face-back element has a baked-in CSS rotate of 180°, so
  // its visible side faces opposite to face-front).
  let nx = 0, ny = 0, nz = side === 'outside' ? -1 : 1;

  // Step 1: panel hinge rotation. Vertical fold uses rotateX(-angle),
  // horizontal uses rotateY(angle). See the matching transforms in
  // renderPanel for the source-of-truth.
  if (axis === 'vertical') {
    const a = -panelAngleDeg * Math.PI / 180;
    const c = Math.cos(a), s = Math.sin(a);
    const ny2 = ny * c - nz * s;
    const nz2 = ny * s + nz * c;
    ny = ny2; nz = nz2;
  } else {
    const a = panelAngleDeg * Math.PI / 180;
    const c = Math.cos(a), s = Math.sin(a);
    const nx2 = nx * c + nz * s;
    const nz2 = -nx * s + nz * c;
    nx = nx2; nz = nz2;
  }

  // Step 2: scene rotation `rotateX(cx) rotateY(cy)` — applied to local
  // points as R_x * R_y * v, i.e. rotateY first, then rotateX.
  {
    const a = cameraYDeg * Math.PI / 180;
    const c = Math.cos(a), s = Math.sin(a);
    const nx2 = nx * c + nz * s;
    const nz2 = -nx * s + nz * c;
    nx = nx2; nz = nz2;
  }
  {
    const a = cameraXDeg * Math.PI / 180;
    const c = Math.cos(a), s = Math.sin(a);
    const ny2 = ny * c - nz * s;
    const nz2 = ny * s + nz * c;
    ny = ny2; nz = nz2;
  }
  return nz;
}

// Filter annotations down to those whose face is currently visible to
// the camera. Two checks combine:
//   1. Face normal must point toward the camera (eliminates pins on
//      faces that have rotated away — e.g. an inside pin viewed from
//      the cover side).
//   2. Occlusion: inside pins are also gated on the mailer being open
//      enough. The anchor's face-front is mathematically "facing the
//      camera" even when the cover flap is physically on top of it,
//      so we also require fold > 0.35 for any inside pin to show.
//      Outside pins don't need this — the cover panels are always
//      exposed from one side or the other.
function getCameraFacingAnnotations(annotations, panelAngles, vertical, camera, fold) {
  const axis = vertical ? 'vertical' : 'horizontal';
  const INSIDE_OCCLUSION_FOLD = 0.35;
  return annotations.filter(a => {
    const side = a.side || 'inside';
    if (side === 'inside' && fold < INSIDE_OCCLUSION_FOLD) return false;
    const angle = panelAngles[a.panelIdx] || 0;
    const z = faceNormalZ(side, angle, axis, camera.x, camera.y);
    return z > 0.15;
  });
}

// ---------------------------------------------------------------------
// PinAnchor — invisible 3D-positioned marker for an annotation. Lives
// inside the panel face so the browser computes its on-screen position
// every frame as the mailer folds/orbits/zooms. The PinOverlay reads
// its bounding rect to render the visible pin in screen space.
// ---------------------------------------------------------------------
const PinAnchor = ({ id, x, y }) => (
  <div
    data-pin-anchor={id}
    style={{
      position: 'absolute',
      left: `${x * 100}%`,
      top: `${y * 100}%`,
      width: 0,
      height: 0,
      pointerEvents: 'none',
    }}
  />
);

// ---------------------------------------------------------------------
// PinOverlay — renders all annotation pins + popups in a screen-space
// layer outside the 3D-scaled scene. Each frame, it polls the
// corresponding PinAnchor's bounding rect (which the browser computes
// after all 3D transforms) and places the visible pin at that point.
//
// This solves three things the in-scene pin couldn't:
//   • The pin is always at a fixed pixel size, never shrunk by the
//     scene-stage scale or rotated into oblivion by the fold angle.
//   • The popup escapes the panel's overflow:hidden — it can extend
//     anywhere on the screen.
//   • Pins stay right-side-up no matter how the panel is flipped.
// ---------------------------------------------------------------------
const PinOverlay = ({
  annotations, adminMode, viewportRef,
  editingId, setEditingId,
  activeId, setActiveId,
  onUpdate, onDelete,
}) => {
  // id → { x, y, visible } in viewport-local coords. Updated via rAF.
  const [positions, setPositions] = useState({});
  // Hover state lives here now so the screen-space pin can show/hide
  // its popup directly. Hover OR active (clicked) → popup visible.
  const [hoveredId, setHoveredId] = useState(null);

  useEffect(() => {
    if (!annotations.length) { setPositions({}); return; }
    let raf;
    const tick = () => {
      const vp = viewportRef.current;
      if (!vp) { raf = requestAnimationFrame(tick); return; }
      const vpRect = vp.getBoundingClientRect();
      const next = {};
      for (const ann of annotations) {
        const el = vp.querySelector(`[data-pin-anchor="${ann.id}"]`);
        // offsetParent === null when any ancestor has display:none, so this
        // cleanly hides pins on the tucked-away C-fold panel at fold≈0.
        if (!el || !el.offsetParent) { next[ann.id] = { visible: false }; continue; }
        const r = el.getBoundingClientRect();
        next[ann.id] = {
          x: r.x + r.width / 2 - vpRect.x,
          y: r.y + r.height / 2 - vpRect.y,
          visible: true,
        };
      }
      setPositions(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [annotations, viewportRef]);

  if (!annotations.length) return null;

  return (
    <div className="pin-overlay" style={{
      position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 40,
    }}>
      {annotations.map(ann => {
        const pos = positions[ann.id];
        if (!pos || !pos.visible) return null;
        const isEditing = editingId === ann.id;
        const isActive = activeId === ann.id;
        const isHovered = hoveredId === ann.id;
        const showPopup = (isHovered || isActive) && !isEditing;
        // Popup width is ~340; flip to the left if it would clip.
        const POPUP_W = 340;
        const GAP = 18;
        const fitsRight = pos.x + GAP + POPUP_W + 12 <= (viewportRef.current?.clientWidth ?? window.innerWidth);
        const fitsLeft  = pos.x - GAP - POPUP_W - 12 >= 0;
        const popupSide = !fitsRight && fitsLeft ? 'left' : 'right';
        return (
          <div
            key={ann.id}
            className={`ann-pin-wrap ${ann.isNeed ? 'need' : ''} ${(isActive || isHovered) ? 'active' : ''} popup-x-${popupSide}`}
            style={{ position: 'absolute', left: pos.x, top: pos.y, pointerEvents: 'auto' }}
            onPointerEnter={() => setHoveredId(ann.id)}
            onPointerLeave={() => setHoveredId(h => h === ann.id ? null : h)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (adminMode) setEditingId(ann.id);
              else setActiveId(prev => prev === ann.id ? null : ann.id);
            }}
          >
            <div className="ann-pin">{ann.isNeed ? '!' : 'i'}</div>
            {showPopup && (
              <div className="ann-popup">
                {ann.isNeed && <div className="ann-popup-flag">NEED</div>}
                {ann.content
                  ? <div className="ann-popup-body">{ann.content}</div>
                  : <div className="ann-popup-body ann-popup-empty">{adminMode ? 'Empty — click to edit' : ''}</div>}
              </div>
            )}
            {isEditing && adminMode && (
              <div className="ann-edit"
                   onClick={(e) => e.stopPropagation()}
                   onPointerDown={(e) => e.stopPropagation()}>
                <textarea
                  className="ann-textarea"
                  placeholder="What does the client need to know?"
                  value={ann.content}
                  autoFocus
                  onChange={(e) => onUpdate(ann.id, { content: e.target.value })}
                />
                <label className="ann-need-toggle">
                  <input type="checkbox" checked={!!ann.isNeed}
                         onChange={(e) => onUpdate(ann.id, { isNeed: e.target.checked })} />
                  Flag as a Need (red)
                </label>
                <div className="ann-edit-actions">
                  <button className="ctrl-btn" onClick={() => { onDelete(ann.id); setEditingId(null); }}>Delete</button>
                  <button className="ctrl-btn primary" onClick={() => setEditingId(null)}>Done</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------
// MailerViewer — main 3D component
// ---------------------------------------------------------------------
const DEFAULT_CAMERA = { x: -10, y: 0 };

// Toggle a side's page orient between 'rotate180' and 'normal'. Treats
// any mirror state (flipH/flipV) as "not rotated" so the button always
// performs a clean 180° flip on whatever's currently shown.
function toggleSideRotate180(current) {
  return current === 'rotate180' ? 'normal' : 'rotate180';
}

const MailerViewer = ({
  config, setConfig, pages, onOpenEditor,
  adminMode, onToggleAdmin, onShareLink, onSetDefaultCamera, onAddAnnotation, onUpdateAnnotation, onDeleteAnnotation,
  onZoomChange,
}) => {
  const geo = useMemo(() => computeGeometry(config), [config]);
  const { sheetW, sheetH, panels, vertical } = geo;

  // Initial camera angle — reads the marked front view from config on
  // mount. config.defaultCamera is set by the "Mark as front" button.
  const [camera, setCamera] = useState(() =>
    config.defaultCamera ? { ...config.defaultCamera } : { ...DEFAULT_CAMERA });
  const [fold, setFold] = useState(0);
  const [tear, setTear] = useState(0);
  const [tearOffset, setTearOffset] = useState({ x: 0, y: 0, rot: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragType, setDragType] = useState(null);
  const [scale, setScale] = useState(0.35);
  // User-controlled zoom multiplier on top of fit-to-viewport.
  const [userZoom, setUserZoom] = useState(1);
  // Scene pan in screen-pixels — used to keep a point under the cursor
  // when double-clicking to zoom in/out.
  const [sceneOffset, setSceneOffset] = useState({ x: 0, y: 0 });
  // Annotation interaction state
  const [placingAnnotation, setPlacingAnnotation] = useState(false);
  const [activeAnnotation, setActiveAnnotation] = useState(null); // id of opened popup
  const [editingAnnotation, setEditingAnnotation] = useState(null); // id being edited in admin
  const [shareToast, setShareToast] = useState(null);
  // Share modal: { link, kind: 'short'|'legacy', copied: bool, error?: string, loading?: bool }
  const [shareModal, setShareModal] = useState(null);
  const shareInputRef = useRef(null);

  const dragRef = useRef(null);
  const viewportRef = useRef(null);

  useEffect(() => {
    document.body.style.background = BG_PRESETS[config.background] || BG_PRESETS.studio;
  }, [config.background]);

  useEffect(() => {
    const recompute = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Match the scene-stage padding (80px top + 120px bottom = 200px total).
      // 80px horizontal each side (40px padding + breathing room).
      const fit = Math.min((vw - 160) / sheetW, (vh - 220) / sheetH);
      setScale(clamp(fit, 0.12, 1.0));
    };
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [sheetW, sheetH]);

  // Reset tear state when tearPanel changes
  useEffect(() => {
    setTear(0);
    setTearOffset({ x: 0, y: 0, rot: 0 });
  }, [config.tearPanel]);

  const angles = useMemo(() => computeFoldAngles(config, fold), [config, fold]);
  const torn = tear > 0.55;
  const tearT = useMemo(() => ({
    tx: tearOffset.x,
    ty: tearOffset.y - tear * (vertical ? 80 : 0),
    tx2: tearOffset.x - tear * (vertical ? 0 : 80),
    tz: tear * 260,
    rz: tearOffset.rot + tear * 10,
  }), [tear, tearOffset, vertical]);

  // Threshold above which background drag pans (translates) the scene
  // instead of orbiting the camera. Below this we keep the original
  // orbit-on-drag behavior so the 3D preview still feels interactive
  // at default zoom; above this the user is clearly trying to read
  // text on the PDF and wants to scroll around the zoomed-in artwork.
  const PAN_ZOOM_THRESHOLD = 1.2;

  // ---------- pointer handling ----------
  const onPointerDown = (e) => {
    if (e.target.closest('.no-orbit')) return;
    const role = e.target.closest('[data-grab]')?.getAttribute('data-grab');
    if (role === 'perforation') {
      dragRef.current = { type: 'tear', startX: e.clientX, startY: e.clientY, tearStart: tear };
    } else if (role === 'torn-piece') {
      dragRef.current = { type: 'move-piece', startX: e.clientX, startY: e.clientY, posStart: { ...tearOffset } };
    } else if (userZoom > PAN_ZOOM_THRESHOLD) {
      // When zoomed in, plain drag pans the scene so the user can read
      // across the whole PDF. Tracks the starting sceneOffset and updates
      // it in pointermove based on the cumulative cursor delta.
      dragRef.current = { type: 'pan', startX: e.clientX, startY: e.clientY, offsetStart: { ...sceneOffset } };
    } else {
      dragRef.current = { type: 'orbit', startX: e.clientX, startY: e.clientY, camStart: { ...camera } };
    }
    setDragType(dragRef.current.type);
    setIsDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.type === 'orbit') {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      setCamera({
        x: clamp(d.camStart.x - dy * 0.35, -85, 85),
        y: d.camStart.y + dx * 0.45,
      });
    } else if (d.type === 'pan') {
      // 1:1 pixel pan — drag exactly translates the scene under the cursor.
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      setSceneOffset({ x: d.offsetStart.x + dx, y: d.offsetStart.y + dy });
    } else if (d.type === 'tear') {
      // Drag perpendicular-to-perforation to tear: for vertical fold, that's vertical drag.
      const delta = vertical
        ? -(e.clientY - d.startY) / 220
        : (e.clientX - d.startX) / 220;
      setTear(clamp(d.tearStart + delta, 0, 1));
    } else if (d.type === 'move-piece') {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      setTearOffset(p => ({
        ...d.posStart,
        x: d.posStart.x + dx / scale,
        y: d.posStart.y + dy / scale,
      }));
    }
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    if (d?.type === 'tear') {
      setTear(prev => prev > 0.55 ? 1 : 0);
    }
    dragRef.current = null;
    setDragType(null);
    setIsDragging(false);
  };

  // View presets
  const setView = (view) => {
    if (view === 'address') setCamera({ x: -10, y: 0 });
    if (view === 'cover')   setCamera({ x: -10, y: 180 });
    if (view === 'iso')     setCamera({ x: -22, y: -28 });
    if (view === 'top')     setCamera({ x: -78, y: 0 });
  };

  // ---------- panel render helper ----------
  const renderPanel = (panel) => {
    const { i, x, y, w, h, isAnchor, offsetFromAnchor } = panel;
    const angle = angles[i] || 0;
    // Per-panel orient overrides, looked up separately for each side so an
    // upside-down cover can be corrected without flipping the inside.
    // Falls back to the legacy combined `panelOrients` array, then 'normal'.
    const pickOrient = (sideArr) =>
      (Array.isArray(sideArr) && sideArr[i])
      || (Array.isArray(config.panelOrients) && config.panelOrients[i])
      || 'normal';
    const outsidePanelOrient = pickOrient(config.panelOrientsOutside);
    const insidePanelOrient  = pickOrient(config.panelOrientsInside);

    // Z-lift to keep stacked panels in the right paint order when closed.
    // Each flap that lays over the anchor gets pushed forward in world Z;
    // flaps further from the anchor in fold order sit higher in the stack.
    // The ramp goes 0 → 1 as the panel folds, so unfolded panels aren't
    // visibly thick. The base STACK_GAP is in scene-space px and is large
    // enough to survive the .scene-stage scale + 3D rendering tolerance.
    const STACK_GAP = 18;
    const liftRamp = Math.abs(Math.sin(angle * Math.PI / 360));
    // For 3-panel C-fold both flaps stack on the same side, so the FAR
    // flap (panel 2, the outer wrap) needs MORE lift than the near one
    // (panel 0). For 4-panel folds the order is dictated by distance
    // from the anchor along the fold chain.
    const stackOrder = (() => {
      if (config.numPanels === 3 && config.foldType === 'cfold') {
        // Outer wrap = panel 2 (offsetFromAnchor=+1) sits ABOVE the inner
        // tuck = panel 0 (offsetFromAnchor=-1). Asymmetric.
        return i === 0 ? 1 : i === 2 ? 2 : 0;
      }
      return Math.abs(offsetFromAnchor);
    })();
    // Positive lift in world-Z (toward viewer) — applied BEFORE the hinge
    // rotation so the offset doesn't get rotated into a sideways direction
    // at mid-fold angles.
    const localZ = isAnchor ? 0 : stackOrder * STACK_GAP * liftRamp;

    // Tucked-flap fade: at fold≈0 the inner tuck of a 3-panel C-fold sits
    // sandwiched between the cover and the anchor — physically invisible
    // from outside, but in CSS-3D it can still leak through the cover from
    // sub-pixel jitter and create clipping artifacts. Fading its alpha to
    // 0 when the mailer is fully closed eliminates the leak entirely; once
    // the user starts to open, it ramps back in over a few percent of the
    // slider. Other folds are unaffected.
    //
    // Hide the inner tuck flap of a 3-panel C-fold near full fold. The
    // user's PDF has the cover artwork on the lower-Z (stackOrder=1)
    // flap, and the tucked-under flap is the higher-Z one. We only need
    // the tuck to disappear right at fold≈0 — by the time the user
    // starts to open, it ramps back to full opacity.
    let hingeOpacity = 1;
    if (config.numPanels === 3 && config.foldType === 'cfold' && !isAnchor) {
      if (stackOrder === 2) {
        const FADE_END = 0.06; // mailer "starts to open" threshold
        hingeOpacity = Math.min(1, fold / FADE_END);
      }
    }

    // Build hinge transform-origin: the side of the panel that is closest
    // to the anchor (so the panel pivots at the seam).
    let originStr, hingeStyle;
    // Transform order matters: translateZ FIRST shifts the panel forward in
    // the parent's world-Z frame (so the stack separation survives every
    // hinge angle), THEN the rotation pivots around the hinge origin. The
    // vertical axis uses a negated angle because rotateX has opposite
    // chirality from rotateY for the fold conventions in computeFoldAngles
    // — without the negation, vertical flaps would fold AWAY from the
    // viewer and end up behind the anchor at sub-180° angles.
    if (vertical) {
      // hinge along horizontal line
      if (offsetFromAnchor < 0) {
        // panel sits above anchor — hinge along its BOTTOM
        originStr = '50% 100%';
      } else if (offsetFromAnchor > 0) {
        originStr = '50% 0%'; // hinge along its TOP
      } else {
        originStr = '50% 50%';
      }
      hingeStyle = {
        position: 'absolute',
        left: x, top: y, width: w, height: h,
        transformOrigin: originStr,
        transform: isAnchor ? '' : `translateZ(${localZ}px) rotateX(${-angle}deg)`,
        opacity: hingeOpacity,
        // Fully-faded panels are dropped from layout entirely so they
        // can't contribute to depth-buffer clipping with the cover.
        display: hingeOpacity <= 0 ? 'none' : undefined,
      };
    } else {
      if (offsetFromAnchor < 0) originStr = '100% 50%';
      else if (offsetFromAnchor > 0) originStr = '0% 50%';
      else originStr = '50% 50%';
      hingeStyle = {
        position: 'absolute',
        left: x, top: y, width: w, height: h,
        transformOrigin: originStr,
        transform: isAnchor ? '' : `translateZ(${localZ}px) rotateY(${angle}deg)`,
        opacity: hingeOpacity,
        display: hingeOpacity <= 0 ? 'none' : undefined,
      };
    }

    // Add tear transform on the tear panel
    const isTearPanel = i === config.tearPanel;
    if (isTearPanel && tear > 0) {
      const extraTransform = vertical
        ? `translate3d(${tearT.tx}px, ${tearT.ty}px, ${tearT.tz}px) rotateZ(${tearT.rz}deg)`
        : `translate3d(${tearT.tx2}px, ${tearT.ty}px, ${tearT.tz}px) rotateZ(${tearT.rz}deg)`;
      hingeStyle.transform = `${hingeStyle.transform} ${extraTransform}`;
    }

    // Page assignment — outside on face-back, inside on face-front.
    const axis = vertical ? 'vertical' : 'horizontal';

    // crease classes
    const creaseClasses = [];
    if (config.showCreases) {
      if (offsetFromAnchor === 0) {
        // middle has both top and bottom (or left & right) creases
        if (vertical) creaseClasses.push('has-top-crease', 'has-bottom-crease');
        else creaseClasses.push('has-left-crease', 'has-right-crease');
      } else if (offsetFromAnchor < 0) {
        if (vertical) creaseClasses.push('has-bottom-crease');
        else creaseClasses.push('has-right-crease');
      } else {
        if (vertical) creaseClasses.push('has-top-crease');
        else creaseClasses.push('has-left-crease');
      }
    }

    return (
      <div
        key={i}
        className={`panel-hinge ${torn && isTearPanel ? 'torn-flight' : ''}`}
        style={hingeStyle}
      >
        <div className={`panel ${creaseClasses.join(' ')}`}>
          <div
            className={`face face-front ${placingAnnotation ? 'no-orbit' : ''}`}
            onPointerDown={(e) => {
              if (!placingAnnotation || !adminMode) return;
              e.stopPropagation();
              handlePanelClickForAnnotation(i, e);
            }}
            style={placingAnnotation ? { cursor: 'crosshair' } : undefined}
          >
            {pages && (
              <PanelArt
                src={pages[config.insidePageIdx]}
                start={panel.start}
                end={panel.end}
                axis={axis}
                orient={config.insidePageOrient || 'normal'}
                scale={config.insideScale ?? 1}
                offsetX={config.insideOffsetX ?? 0}
                offsetY={config.insideOffsetY ?? 0}
                panelOrient={insidePanelOrient}
              />
            )}
            <PerforationOverlay config={config} panel={panel} />
            {(config.annotations || []).filter(a => a.panelIdx === i && (a.side || 'inside') === 'inside').map(ann => (
              <PinAnchor key={ann.id} id={ann.id} x={ann.x} y={ann.y} />
            ))}
          </div>
          <div className={`face face-back ${vertical ? 'fb-vertical' : 'fb-horizontal'}`}>
            {pages && (
              <PanelArt
                src={pages[config.outsidePageIdx]}
                start={panel.start}
                end={panel.end}
                axis={axis}
                orient={config.outsidePageOrient || 'normal'}
                scale={config.outsideScale ?? 1}
                offsetX={config.outsideOffsetX ?? 0}
                offsetY={config.outsideOffsetY ?? 0}
                panelOrient={outsidePanelOrient}
              />
            )}
            {(config.annotations || []).filter(a => a.panelIdx === i && a.side === 'outside').map(ann => {
              // face-back is rendered with rotateX(180deg) (vertical fold)
              // or rotateY(180deg) (horizontal fold), which visually flips
              // child element coordinates along the rotation axis. Mirror
              // the anchor's coords so it lands where the admin placed it
              // on the unflipped editor view. Pin rendering happens in
              // screen-space (PinOverlay), so visual orientation is
              // always upright regardless of fold/flip.
              const mirroredY = vertical ? 1 - ann.y : ann.y;
              const mirroredX = vertical ? ann.x : 1 - ann.x;
              return (
                <PinAnchor key={ann.id} id={ann.id} x={mirroredX} y={mirroredY} />
              );
            })}
          </div>
          {torn && isTearPanel && <div className={`torn-edge ${vertical ? (offsetFromAnchor < 0 ? 'bottom' : 'top') : (offsetFromAnchor < 0 ? 'right' : 'left')}`} />}
        </div>

        {/* Perforation drag handle, when this panel is the tear-off panel and fully open */}
        {config.showPerforation && i === config.tearPanel && fold > 0.85 && !torn && (
          <div
            className={`perforation ${vertical ? (offsetFromAnchor < 0 ? 'bottom' : 'top') : (offsetFromAnchor < 0 ? 'right' : 'left')} no-orbit`}
            data-grab="perforation"
            title="Drag to tear"
          >
            <span className="perf-hint">{vertical ? '↑' : '←'} Drag to tear off</span>
          </div>
        )}
        {torn && i === config.tearPanel && (
          <div
            className="no-orbit"
            data-grab="torn-piece"
            style={{ position: 'absolute', inset: 0, cursor: 'grab' }}
          />
        )}
      </div>
    );
  };

  // Mouse-wheel zoom on the viewport. Cap raised to 8× now that the PDF
  // re-renders at higher resolution when zoomed in. Zoom is centered on
  // the cursor: the world point under the cursor stays put through the
  // zoom transition.
  const onWheel = (e) => {
    if (e.target?.closest?.('.no-orbit, .controls, .editor-overlay')) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAtPoint(e.clientX, e.clientY, factor);
  };

  // Apply a zoom factor with the world-point under (clientX, clientY)
  // held fixed on screen.
  //
  // The scene-stage transform is `translate3d(ox, oy) scale(s)` with the
  // default 50% 50% transformOrigin. A content point at offset (lx, ly)
  // from the stage's *box center* lands on screen at:
  //   screenX = boxCenterX + lx * s + ox
  // From the current screen position cx we can back out lx = (cx − bcx − ox)/s.
  // After zoom (s → s'), we want the same lx to project to cx again:
  //   ox' = cx − bcx − lx * s' = dx − (dx − ox) * (s'/s)
  // where dx = cx − bcx is the cursor offset from the stage box center.
  // bcx, bcy are pre-transform layout values from offsetLeft/Width.
  const zoomAtPoint = (clientX, clientY, factor) => {
    const vp = viewportRef.current;
    if (!vp) { setUserZoom(z => clamp(z * factor, 0.25, 8)); return; }
    const stage = vp.querySelector('.scene-stage');
    const vpRect = vp.getBoundingClientRect();
    const px = clientX - vpRect.x; // cursor in viewport-local
    const py = clientY - vpRect.y;
    // Pre-transform layout box center, in viewport-local coords.
    const bcx = (stage ? stage.offsetLeft + stage.offsetWidth / 2 : vpRect.width / 2);
    const bcy = (stage ? stage.offsetTop  + stage.offsetHeight / 2 : vpRect.height / 2);
    const dx = px - bcx;
    const dy = py - bcy;
    setUserZoom(oldZ => {
      const newZ = clamp(oldZ * factor, 0.25, 8);
      const oldScale = clamp(scale * oldZ, 0.05, 10);
      const newScale = clamp(scale * newZ, 0.05, 10);
      const r = newScale / oldScale;
      setSceneOffset(o => ({
        x: dx - (dx - o.x) * r,
        y: dy - (dy - o.y) * r,
      }));
      return newZ;
    });
  };

  // Double-click anywhere in the viewport zooms in (or back out) centered
  // on the cursor. Skips when the click hit a control or an annotation.
  const onDoubleClick = (e) => {
    if (e.target?.closest?.('.no-orbit, .controls, .ann-pin-wrap, .editor-overlay')) return;
    e.preventDefault();
    // If currently zoomed in (≥1.5×), pop back to 1×; otherwise zoom in 2×.
    const factor = userZoom >= 1.5 ? (1 / userZoom) : 2;
    zoomAtPoint(e.clientX, e.clientY, factor);
  };

  // Report zoom level upward so the app can bump PDF render resolution.
  useEffect(() => {
    onZoomChange?.(userZoom);
  }, [userZoom, onZoomChange]);

  const effectiveScale = clamp(scale * userZoom, 0.05, 10);

  // Annotation handlers
  const handleAnnotationClick = (ann, e) => {
    e.stopPropagation();
    if (adminMode) setEditingAnnotation(ann.id);
    else setActiveAnnotation(prev => prev === ann.id ? null : ann.id);
  };
  const handlePanelClickForAnnotation = (panelIdx, e) => {
    if (!placingAnnotation || !adminMode) return;
    const face = e.currentTarget;
    const r = face.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top)  / r.height;
    const id = 'a' + Math.random().toString(36).slice(2, 9);
    onAddAnnotation?.({ id, panelIdx, x, y, content: '', isNeed: false });
    setEditingAnnotation(id);
    setPlacingAnnotation(false);
  };

  return (
    <div
      ref={viewportRef}
      className={`viewport ${isDragging ? 'grabbing' : ''} ${placingAnnotation ? 'placing-annotation' : ''}`}
      style={{ background: BG_PRESETS[config.background] || BG_PRESETS.studio }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onWheel={onWheel}
    >
      <div className="scene-stage" style={{
        // translate3d offsets the (centered) stage in screen pixels, scale
        // pivots around the default 50% 50% origin. zoomAtPoint compensates
        // sceneOffset so the world-point under the cursor stays put.
        transform: `translate3d(${sceneOffset.x}px, ${sceneOffset.y}px, 0) scale(${effectiveScale})`,
      }}>
        <div
          className={`scene ${isDragging ? 'dragging' : ''}`}
          style={{
            width: sheetW,
            height: sheetH,
            transform: `rotateX(${camera.x}deg) rotateY(${camera.y}deg)`,
          }}
        >
          <div className="floor-shadow" />
          <div className="mailer" style={{ width: sheetW, height: sheetH }}>
            {panels.map(renderPanel)}
          </div>
        </div>
      </div>

      {/* Screen-space annotation overlay — pins/popups rendered outside
          the 3D scene so they stay crisp, never clip on panel edges, and
          remain upright regardless of fold or page-orient flips. Pins
          on back-facing panel faces are filtered out so an inside note
          doesn't bleed through to the closed cover. */}
      <PinOverlay
        annotations={getCameraFacingAnnotations(config.annotations || [], angles, vertical, camera, fold)}
        adminMode={adminMode}
        viewportRef={viewportRef}
        editingId={editingAnnotation}
        setEditingId={setEditingAnnotation}
        activeId={activeAnnotation}
        setActiveId={setActiveAnnotation}
        onUpdate={onUpdateAnnotation}
        onDelete={onDeleteAnnotation}
      />

      {/* HUD */}
      <div className="hud">
        <div className="hud-brand">
          <img className="hud-logo" src="/white-stacked.png" alt="Fog Signal Strategies" />
          <div className="hud-brand-text">
            <div className="hud-brand-name">Fog Signal Strategies</div>
            <div className="hud-brand-tag">Mailer Preview</div>
          </div>
        </div>
        <div className="hud-name">{config.pdfTitle || config.pdfName}</div>
        {config.pdfDescription && (
          <div className="hud-description">{config.pdfDescription}</div>
        )}
        <div className="hud-sub">
          {config.numPanels}-panel {config.foldType.toUpperCase()} ·
          {' '}{vertical ? 'vertical' : 'horizontal'} · drag to orbit
        </div>
      </div>

      {/* Admin toggle + Share — always visible, top-right */}
      <div className="admin-bar no-orbit">
        {adminMode && (
          <button
            className={`ctrl-btn ${(config.outsidePageOrient || 'normal') === 'rotate180' ? 'on' : ''}`}
            onClick={() => setConfig?.(c => ({
              ...c, outsidePageOrient: toggleSideRotate180(c.outsidePageOrient || 'normal'),
            }))}
            title="Rotate the outside artwork 180° (inside stays put)"
          >
            ⟳ Out
          </button>
        )}
        {adminMode && (
          <button
            className={`ctrl-btn ${(config.insidePageOrient || 'normal') === 'rotate180' ? 'on' : ''}`}
            onClick={() => setConfig?.(c => ({
              ...c, insidePageOrient: toggleSideRotate180(c.insidePageOrient || 'normal'),
            }))}
            title="Rotate the inside artwork 180° (outside stays put)"
          >
            ⟳ In
          </button>
        )}
        {adminMode && (
          <button className="ctrl-btn" onClick={() => {
            onSetDefaultCamera?.({ x: camera.x, y: camera.y });
            setShareToast('Front view saved — this is the angle recipients see first');
            setTimeout(() => setShareToast(null), 2400);
          }} title="Save the current camera angle as the initial view recipients see">
            Mark as front
          </button>
        )}
        {adminMode && (
          <button className="ctrl-btn" onClick={async () => {
            setShareModal({ loading: true });
            try {
              const result = await onShareLink?.();
              if (!result) { setShareModal(null); return; }
              const { link, kind, error } = result;
              // Best-effort clipboard write. Falls back to a visible input
              // the user can copy from manually (non-HTTPS contexts have
              // no clipboard API at all).
              let copied = false;
              try {
                if (navigator.clipboard?.writeText) {
                  await navigator.clipboard.writeText(link);
                  copied = true;
                }
              } catch {}
              setShareModal({ link, kind, error, copied });
            } catch (e) {
              setShareModal({ link: '', kind: 'error', error: e.message });
            }
          }}>Share link</button>
        )}
        {adminMode && (
          <button
            className={`ctrl-btn ${placingAnnotation ? 'primary' : ''}`}
            onClick={() => setPlacingAnnotation(v => !v)}
          >
            {placingAnnotation ? 'Click a panel…' : '+ Add note'}
          </button>
        )}
        <button className="ctrl-btn" onClick={onToggleAdmin}>
          {adminMode ? 'Client view' : 'Admin'}
        </button>
      </div>
      {shareToast && (
        <div className="share-toast">{shareToast}</div>
      )}

      {shareModal && (
        <div className="share-modal-backdrop no-orbit"
             onClick={() => setShareModal(null)}
             onPointerDown={(e) => e.stopPropagation()}>
          <div className="share-modal" onClick={(e) => e.stopPropagation()}>
            <div className="share-modal-title">Share this mailer</div>
            {shareModal.loading && (
              <div className="share-modal-body">Creating link…</div>
            )}
            {!shareModal.loading && shareModal.link && (
              <>
                <div className="share-modal-sub">
                  {shareModal.kind === 'short'
                    ? 'Anyone with this link opens the viewer in client view.'
                    : 'Server share not available — using a legacy hash link. Long, but works the same.'}
                </div>
                <div className="share-modal-row">
                  <input
                    ref={shareInputRef}
                    className="share-modal-input"
                    type="text"
                    readOnly
                    value={shareModal.link}
                    onFocus={(e) => e.target.select()}
                    onClick={(e) => e.target.select()}
                  />
                  <button
                    className="ctrl-btn primary"
                    onClick={async () => {
                      let ok = false;
                      try {
                        if (navigator.clipboard?.writeText) {
                          await navigator.clipboard.writeText(shareModal.link);
                          ok = true;
                        }
                      } catch {}
                      if (!ok) {
                        // execCommand fallback for non-HTTPS contexts.
                        const el = shareInputRef.current;
                        if (el) { el.focus(); el.select(); try { ok = document.execCommand('copy'); } catch {} }
                      }
                      setShareModal(m => m ? { ...m, copied: ok, copyError: !ok } : m);
                    }}
                  >
                    {shareModal.copied ? 'Copied ✓' : 'Copy'}
                  </button>
                </div>
                {shareModal.copyError && (
                  <div className="share-modal-warn">
                    Couldn't copy automatically — select the text above and copy manually.
                  </div>
                )}
                {shareModal.error && shareModal.kind !== 'short' && (
                  <div className="share-modal-warn">Note: {shareModal.error}</div>
                )}
              </>
            )}
            {!shareModal.loading && shareModal.kind === 'error' && (
              <div className="share-modal-warn">Couldn't create link: {shareModal.error}</div>
            )}
            <div className="share-modal-actions">
              <button className="ctrl-btn" onClick={() => setShareModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      <div className="stage-tag">
        <span className="dot" />
        {torn ? 'Tear-off detached'
          : fold < 0.05 ? 'As delivered'
          : fold < 0.5 ? 'Opening flap 1'
          : fold < 0.95 ? 'Opening flap 2'
          : 'Fully unfolded'}
      </div>

      {/* Bottom control bar */}
      <div className="controls no-orbit">
        <button className="ctrl-btn" onClick={() => { setFold(0); setTear(0); setTearOffset({x:0,y:0,rot:0}); }}>Fold</button>
        <div className="fold-slider">
          <span>Open</span>
          <input type="range" min="0" max="1" step="0.005" value={fold}
                 onChange={e => setFold(parseFloat(e.target.value))} />
        </div>
        <button className="ctrl-btn" onClick={() => setFold(1)}>Unfold</button>

        <div className="ctrl-divider" />

        <button className="ctrl-btn" onClick={() => setView('address')}>Front</button>
        <button className="ctrl-btn" onClick={() => setView('cover')}>Back</button>
        <button className="ctrl-btn" onClick={() => setView('iso')}>3/4</button>
        <button className="ctrl-btn" onClick={() => setView('top')}>Top</button>

        <div className="ctrl-divider" />

        <button
          className={`ctrl-btn ${torn ? '' : 'primary'}`}
          disabled={config.tearPanel == null || (fold < 0.85 && !torn)}
          onClick={() => {
            if (torn) { setTear(0); setTearOffset({x:0,y:0,rot:0}); }
            else { setFold(1); setTear(1); }
          }}
        >
          {torn ? 'Reattach' : 'Tear off'}
        </button>

        <button className="ctrl-btn" onClick={() => {
          setCamera(config.defaultCamera ? { ...config.defaultCamera } : { ...DEFAULT_CAMERA });
          setFold(0); setTear(0); setTearOffset({x:0,y:0,rot:0});
          setUserZoom(1); setSceneOffset({ x: 0, y: 0 });
        }}>Reset</button>

        <div className="ctrl-divider" />

        <button className="ctrl-btn" onClick={() => {
          // Zoom centered on the viewport — keeps the focal point stable
          // when using the buttons rather than the wheel/double-click.
          const vp = viewportRef.current;
          if (!vp) { setUserZoom(z => Math.max(0.25, z / 1.2)); return; }
          const r = vp.getBoundingClientRect();
          zoomAtPoint(r.x + r.width / 2, r.y + r.height / 2, 1 / 1.2);
        }} title="Zoom out">−</button>
        <span className="zoom-readout">{Math.round(userZoom * 100)}%</span>
        <button className="ctrl-btn" onClick={() => {
          const vp = viewportRef.current;
          if (!vp) { setUserZoom(z => Math.min(8, z * 1.2)); return; }
          const r = vp.getBoundingClientRect();
          zoomAtPoint(r.x + r.width / 2, r.y + r.height / 2, 1.2);
        }} title="Zoom in">+</button>
        <button className="ctrl-btn" onClick={() => {
          setUserZoom(1); setSceneOffset({ x: 0, y: 0 });
        }} title="Reset zoom">100%</button>

        {adminMode && (
          <>
            <div className="ctrl-divider" />
            <button className="ctrl-btn primary" onClick={onOpenEditor}>Configure</button>
          </>
        )}
      </div>

      {/* Hints */}
      <div className="hint">
        <div className="hint-row">
          <span className="hint-key">drag bg</span>
          <span>{userZoom > PAN_ZOOM_THRESHOLD ? 'pan' : 'orbit'}</span>
        </div>
        <div className="hint-row"><span className="hint-key">dbl-click</span><span>zoom here</span></div>
        <div className="hint-row"><span className="hint-key">slider</span><span>unfold</span></div>
        <div className="hint-row"><span className="hint-key">drop pdf</span><span>swap</span></div>
        {fold > 0.85 && !torn && config.showPerforation && config.tearPanel != null && (
          <div className="hint-row"><span className="hint-key">{vertical ? 'drag ↑' : 'drag ←'}</span><span>tear</span></div>
        )}
      </div>

      <div className={`tear-progress ${dragType === 'tear' ? 'visible' : ''}`}>
        Tearing… {Math.round(tear * 100)}%
      </div>
    </div>
  );
};

window.MailerViewer = MailerViewer;
