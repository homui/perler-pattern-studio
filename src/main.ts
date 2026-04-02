import "./style.css";

type StylePresetId = "none" | "average" | "realistic" | "anime" | "portrait";
type MatchingAlgorithmId = "ciede2000" | "cam16ucs";
type ReadyMessage = { type: "ready"; palettes: string[] };
type PaletteEntry = { key: string; title: string; hex: string };
type ResultMessage = {
  type: "result";
  width: number;
  height: number;
  previewBuffer: ArrayBuffer;
  cellIndexBuffer: ArrayBuffer;
  paletteEntries: PaletteEntry[];
  stats: Array<{ key: string; title: string; hex: string; count: number }>;
  uniqueColorCount: number;
  elapsedMs: number;
};
type ErrorMessage = { type: "error"; message: string };
type WorkerResponse = ReadyMessage | ResultMessage | ErrorMessage;
type PaletteUsage = { paletteIndex: number; key: string; title: string; hex: string; count: number };
type RenderState = {
  width: number;
  height: number;
  preview: Uint8ClampedArray;
  cellIndices: Uint16Array;
  paletteEntries: PaletteEntry[];
  paletteRgb: Array<[number, number, number] | null>;
  stats: PaletteUsage[];
  uniqueColorCount: number;
  elapsedMs: number;
};
type ViewMode = "preview" | "edit";
type PaletteScopeMode = "region" | "used" | "all";
type EditToolId = "paint" | "pick" | "select";
type StylePresetOption = { id: StylePresetId; label: string; hint: string; merge: number; cleanup: number };
type DraftLayout = { cellSize: number; axisSize: number; width: number; height: number };
type EditPatch = { label: string; indices: number[]; before: number[]; after: number[]; kind?: "paint" | "noise-remove"; noiseRecordId?: number; paletteIndex?: number };
type PendingPatch = { label: string; before: Map<number, number>; after: Map<number, number> };
type NoiseRemovalRecord = { id: number; paletteIndex: number; label: string; patch: EditPatch; count: number };

const TRANSPARENT_INDEX = 65535;
const PALETTE_PAGE_SIZE = 30;
const STYLE_PRESET_OPTIONS: StylePresetOption[] = [
  { id: "none", label: "不预设", hint: "不额外干预风格，保持你手动设置的颜色合并和去杂色参数。", merge: 0, cleanup: 0 },
  { id: "average", label: "平均", hint: "通用平衡，颜色自然，适合大多数图片。", merge: 44, cleanup: 38 },
  { id: "realistic", label: "真实", hint: "保留渐变和层次，更适合风景、照片和写实题材。", merge: 28, cleanup: 22 },
  { id: "anime", label: "动漫", hint: "强化色块和轮廓，让插画和二次元图更干净。", merge: 64, cleanup: 50 },
  { id: "portrait", label: "人物", hint: "更注重五官和边缘，适合头像、宠物和人物照片。", merge: 52, cleanup: 34 },
];

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App container not found");

app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <div class="hero-topbar">
        <div class="brand-lockup">
          <div class="brand-mark" aria-hidden="true">
            <div class="brand-beads">
              <span class="bead bead-a"></span>
              <span class="bead bead-b"></span>
              <span class="bead bead-c"></span>
              <span class="bead bead-d"></span>
              <span class="bead bead-e"></span>
              <span class="bead bead-f"></span>
              <span class="bead bead-g"></span>
              <span class="bead bead-h"></span>
              <span class="bead bead-i"></span>
            </div>
            <span class="brand-mark-tag">atelier</span>
          </div>
          <div class="brand-copy">
            <p class="brand-kicker">Pixel Bead Atelier</p>
            <h1>拼豆底稿工坊</h1>
            <p class="brand-subtitle">把图片变成更甜、更干净的拼豆底稿</p>
          </div>
        </div>
        <div class="hero-pills">
          <span>高精度</span>
          <span>CAM16-UCS</span>
          <span>前端本地处理</span>
        </div>
      </div>

      <section class="upload-panel panel">
        <div class="upload-layout">
          <div class="upload-main">
            <div class="upload-heading">
              <p class="eyebrow">Upload</p>
              <h2>上传图片并生成底稿</h2>
            </div>

            <input id="file-input" class="hidden-input" type="file" accept="image/png,image/jpeg,image/webp,image/bmp" />
            <button id="dropzone" class="dropzone" type="button">
              <span class="dropzone-icon">+</span>
              <strong>拖拽图片到这里</strong>
              <span>或点击选择文件，支持 PNG / JPG / WEBP / BMP</span>
            </button>

            <div class="control-stack">
              <div class="field">
                <label for="style-preset">风格预设</label>
                <select id="style-preset"></select>
                <small id="style-preset-hint"></small>
              </div>
              <div class="field">
                <label for="palette-select">色表</label>
                <select id="palette-select" disabled></select>
                <small id="palette-hint">正在加载 colorMap.json...</small>
              </div>
              <div class="field">
                <label for="matching-algorithm">匹配算法</label>
                <select id="matching-algorithm">
                  <option value="cam16ucs" selected>CAM16-UCS</option>
                  <option value="ciede2000">CIEDE2000</option>
                </select>
                <small id="matching-algorithm-hint">默认使用 CAM16-UCS，更贴近人眼感知，适合拼豆配色。</small>
              </div>
              <div class="inline-fields">
                <div class="field">
                  <label for="grid-width">像素宽度</label>
                  <input id="grid-width" type="range" min="10" max="200" step="1" value="100" />
                </div>
                <div class="field compact">
                  <label for="grid-width-number">精确数值</label>
                  <input id="grid-width-number" type="number" min="10" max="200" step="1" value="100" />
                </div>
              </div>
              <div class="field">
                <label for="merge-strength">相近颜色合并</label>
                <input id="merge-strength" type="range" min="0" max="100" step="1" value="0" />
                <small id="merge-strength-value">0 · 几乎不合并，尽量保留原始颜色层</small>
              </div>
              <div class="field">
                <label for="cleanup-strength">自动去杂色强度</label>
                <input id="cleanup-strength" type="range" min="0" max="100" step="1" value="0" />
                <small id="cleanup-strength-value">0 · 几乎不处理</small>
              </div>
              <div class="metrics-strip">
                <div><span class="metric-label">目标宽度</span><strong id="grid-width-value">100 格</strong></div>
                <div><span class="metric-label">当前文件</span><strong id="file-name">未选择</strong></div>
              </div>
              <div class="action-row">
                <button id="process-button" class="primary-button" disabled>生成像素图</button>
                <p id="status" class="status">等待图片和色表加载完成</p>
              </div>
            </div>
          </div>

          <div class="upload-reference">
            <div class="section-heading"><p class="mini-label">Original</p><h3>原图参考</h3></div>
            <div class="canvas-card original-card">
              <div class="canvas-card-head"><strong>原图</strong><span>上传后显示在这里</span></div>
              <div class="canvas-shell upload-original-shell"><canvas id="source-canvas" width="320" height="320"></canvas></div>
            </div>
          </div>
        </div>
      </section>
    </section>

    <section class="workbench">
      <div class="workbench-header">
        <div><p class="eyebrow">Workbench</p><h2>结果与图纸信息</h2></div>
        <div id="meta" class="meta"></div>
      </div>

      <div class="workbench-grid">
        <section class="result-stage panel">
          <div class="stage-header stage-header-stack">
            <div><p class="mini-label">Pattern</p><h3>生成结果</h3></div>
            <div class="result-toolbar">
              <div class="view-switch view-switch-wide">
                <button id="view-preview" class="switch-button is-active" type="button">像素预览</button>
                <button id="view-edit" class="switch-button" type="button">手动编辑</button>
                <button id="download-button" class="switch-button switch-button-secondary" type="button" disabled>下载图纸</button>
              </div>
              <div id="editor-controls" class="toggle-row is-hidden">
                <label class="check-chip"><input id="toggle-grid" type="checkbox" checked /><span>网格线</span></label>
                <label class="check-chip"><input id="toggle-labels" type="checkbox" checked /><span>色号编号</span></label>
                <label class="check-chip"><input id="toggle-coords" type="checkbox" checked /><span>坐标</span></label>
                <label class="section-control" for="section-size"><span>分区</span><select id="section-size"><option value="5">5</option><option value="10" selected>10</option><option value="20">20</option></select></label>
              </div>
              <div id="mobile-tools" class="mobile-tools is-hidden">
                <button class="mobile-tool-button is-active" type="button" data-edit-tool="paint">画笔</button>
                <button class="mobile-tool-button" type="button" data-edit-tool="pick">取色</button>
                <button class="mobile-tool-button" type="button" data-edit-tool="select">框选</button>
                <button id="mobile-palette-toggle" class="mobile-tool-button mobile-tool-button-accent" type="button">调色盘</button>
              </div>
            </div>
          </div>

          <p id="draft-note" class="draft-note">生成后默认显示像素预览，切换到手动编辑后会显示底稿和可修改像素。</p>

          <div class="canvas-card result-card">
            <div class="canvas-card-head"><strong id="result-card-title">像素预览</strong><span id="result-card-subtitle">查看整体颜色效果</span></div>
            <div id="result-shell" class="canvas-shell result-shell">
              <canvas id="pixel-canvas" class="pixel-canvas" width="320" height="320"></canvas>
              <div id="selection-overlay" class="selection-overlay is-hidden"></div>
            </div>
          </div>
        </section>

        <aside class="stats-stage panel">
          <div class="section-heading stats-heading">
            <div><h3 id="stats-title">色号统计</h3></div>
            <div class="stats-actions">
              <button id="noise-mode-button" class="ghost-button is-compact" type="button" disabled>去除杂色</button>
              <button id="undo-button" class="ghost-button is-compact" type="button" disabled>撤销</button>
              <button id="redo-button" class="ghost-button is-compact" type="button" disabled>重做</button>
            </div>
          </div>
          <p id="history-note" class="history-note">还没有手动修改</p>
          <div id="stats-root" class="empty-state"><strong>还没有生成结果</strong><span>生成后这里会列出当前底稿实际使用到的色号、数量和总珠数。</span></div>
        </aside>
      </div>
    </section>

    <div id="selection-popup" class="selection-popup is-hidden">
      <button id="selection-popup-backdrop" class="selection-popup-backdrop" type="button" aria-label="关闭局部编辑窗"></button>
      <div class="selection-popup-window">
        <div class="selection-popup-head">
          <div>
            <strong>局部编辑窗</strong>
            <span id="selection-popup-meta">右键框选一块区域后，会在这里放大显示。</span>
          </div>
          <button id="selection-popup-close" class="selection-popup-close" type="button">关闭</button>
        </div>
        <div class="selection-popup-body">
          <div class="selection-popup-canvas-shell">
            <canvas id="selection-canvas" class="pixel-canvas selection-canvas" width="320" height="320"></canvas>
          </div>
        </div>
      </div>
    </div>

    <div id="palette-window" class="palette-window is-hidden">
      <div id="palette-window-header" class="palette-window-header">
        <div class="palette-window-title">
          <strong>调色盘</strong>
          <span id="palette-window-caption">优先显示当前区域用到的颜色</span>
        </div>
        <span class="palette-window-drag">拖动</span>
        <button id="palette-window-close" class="palette-window-close" type="button">收起</button>
      </div>
      <div class="palette-window-body">
        <div class="palette-toolbar">
          <div class="palette-scope-switch">
            <button class="palette-scope-button" type="button" data-palette-scope="region">区域色</button>
            <button class="palette-scope-button" type="button" data-palette-scope="used">已用色</button>
            <button class="palette-scope-button" type="button" data-palette-scope="all">全色表</button>
          </div>
          <div class="palette-pagination">
            <button class="palette-page-button" type="button" data-palette-page="-1" aria-label="上一页">‹</button>
            <span id="palette-page-meta">1 / 1</span>
            <button class="palette-page-button" type="button" data-palette-page="1" aria-label="下一页">›</button>
          </div>
        </div>
        <div id="palette-window-summary" class="palette-window-summary"></div>
        <div id="editor-palette" class="editor-palette"></div>
      </div>
    </div>
  </main>
`;

const fileInput = document.querySelector<HTMLInputElement>("#file-input");
const dropzone = document.querySelector<HTMLButtonElement>("#dropzone");
const stylePresetSelect = document.querySelector<HTMLSelectElement>("#style-preset");
const stylePresetHint = document.querySelector<HTMLElement>("#style-preset-hint");
const paletteSelect = document.querySelector<HTMLSelectElement>("#palette-select");
const paletteHint = document.querySelector<HTMLElement>("#palette-hint");
const matchingAlgorithmSelect = document.querySelector<HTMLSelectElement>("#matching-algorithm");
const matchingAlgorithmHint = document.querySelector<HTMLElement>("#matching-algorithm-hint");
const widthRange = document.querySelector<HTMLInputElement>("#grid-width");
const widthNumber = document.querySelector<HTMLInputElement>("#grid-width-number");
const widthValue = document.querySelector<HTMLElement>("#grid-width-value");
const mergeStrengthInput = document.querySelector<HTMLInputElement>("#merge-strength");
const mergeStrengthValue = document.querySelector<HTMLElement>("#merge-strength-value");
const cleanupStrengthInput = document.querySelector<HTMLInputElement>("#cleanup-strength");
const cleanupStrengthValue = document.querySelector<HTMLElement>("#cleanup-strength-value");
const fileNameNode = document.querySelector<HTMLElement>("#file-name");
const processButton = document.querySelector<HTMLButtonElement>("#process-button");
const statusNode = document.querySelector<HTMLElement>("#status");
const sourceCanvas = document.querySelector<HTMLCanvasElement>("#source-canvas");
const pixelCanvas = document.querySelector<HTMLCanvasElement>("#pixel-canvas");
const statsRoot = document.querySelector<HTMLElement>("#stats-root");
const statsTitle = document.querySelector<HTMLElement>("#stats-title");
const noiseModeButton = document.querySelector<HTMLButtonElement>("#noise-mode-button");
const metaRoot = document.querySelector<HTMLElement>("#meta");
const draftNote = document.querySelector<HTMLElement>("#draft-note");
const viewPreviewButton = document.querySelector<HTMLButtonElement>("#view-preview");
const viewEditButton = document.querySelector<HTMLButtonElement>("#view-edit");
const downloadButton = document.querySelector<HTMLButtonElement>("#download-button");
const toggleGrid = document.querySelector<HTMLInputElement>("#toggle-grid");
const toggleLabels = document.querySelector<HTMLInputElement>("#toggle-labels");
const toggleCoords = document.querySelector<HTMLInputElement>("#toggle-coords");
const sectionSizeSelect = document.querySelector<HTMLSelectElement>("#section-size");
const editorControls = document.querySelector<HTMLElement>("#editor-controls");
const mobileTools = document.querySelector<HTMLElement>("#mobile-tools");
const mobilePaletteToggle = document.querySelector<HTMLButtonElement>("#mobile-palette-toggle");
const editorPalette = document.querySelector<HTMLElement>("#editor-palette");
const paletteWindow = document.querySelector<HTMLElement>("#palette-window");
const paletteWindowHeader = document.querySelector<HTMLElement>("#palette-window-header");
const paletteWindowClose = document.querySelector<HTMLButtonElement>("#palette-window-close");
const paletteWindowCaption = document.querySelector<HTMLElement>("#palette-window-caption");
const paletteWindowSummary = document.querySelector<HTMLElement>("#palette-window-summary");
const palettePageMeta = document.querySelector<HTMLElement>("#palette-page-meta");
const undoButton = document.querySelector<HTMLButtonElement>("#undo-button");
const redoButton = document.querySelector<HTMLButtonElement>("#redo-button");
const historyNote = document.querySelector<HTMLElement>("#history-note");
const selectionPopup = document.querySelector<HTMLElement>("#selection-popup");
const selectionPopupBackdrop = document.querySelector<HTMLButtonElement>("#selection-popup-backdrop");
const selectionPopupClose = document.querySelector<HTMLButtonElement>("#selection-popup-close");
const selectionPopupMeta = document.querySelector<HTMLElement>("#selection-popup-meta");
const selectionCanvas = document.querySelector<HTMLCanvasElement>("#selection-canvas");
const selectionPopupWindow = document.querySelector<HTMLElement>(".selection-popup-window");
const selectionPopupHead = document.querySelector<HTMLElement>(".selection-popup-head");
const resultShell = document.querySelector<HTMLElement>("#result-shell");
const selectionOverlay = document.querySelector<HTMLElement>("#selection-overlay");
const resultCardTitle = document.querySelector<HTMLElement>("#result-card-title");
const resultCardSubtitle = document.querySelector<HTMLElement>("#result-card-subtitle");

if (!fileInput || !dropzone || !stylePresetSelect || !stylePresetHint || !paletteSelect || !paletteHint || !matchingAlgorithmSelect || !matchingAlgorithmHint || !widthRange || !widthNumber || !widthValue || !mergeStrengthInput || !mergeStrengthValue || !cleanupStrengthInput || !cleanupStrengthValue || !fileNameNode || !processButton || !statusNode || !sourceCanvas || !pixelCanvas || !statsRoot || !statsTitle || !noiseModeButton || !metaRoot || !draftNote || !viewPreviewButton || !viewEditButton || !downloadButton || !toggleGrid || !toggleLabels || !toggleCoords || !sectionSizeSelect || !editorControls || !mobileTools || !mobilePaletteToggle || !editorPalette || !paletteWindow || !paletteWindowHeader || !paletteWindowClose || !paletteWindowCaption || !paletteWindowSummary || !palettePageMeta || !undoButton || !redoButton || !historyNote || !selectionPopup || !selectionPopupBackdrop || !selectionPopupClose || !selectionPopupMeta || !selectionCanvas || !selectionPopupWindow || !selectionPopupHead || !resultShell || !selectionOverlay || !resultCardTitle || !resultCardSubtitle) {
  throw new Error("UI nodes missing");
}

const worker = new Worker(new URL("./pixelWorker.ts", import.meta.url), { type: "module" });
let paletteReady = false;
let currentFile: File | null = null;
let sourceUrl: string | null = null;
let sourceBitmap: ImageBitmap | null = null;
let latestResult: RenderState | null = null;
let baseCellIndices: Uint16Array | null = null;
let currentView: ViewMode = "preview";
let selectedPaletteIndex: number | null = null;
let pointerPainting = false;
let lastPaintedCell = -1;
let lastDraftLayout: DraftLayout | null = null;
let renderFrame = 0;
let selectionDragStart: { row: number; col: number } | null = null;
let selectionDragCurrent: { row: number; col: number } | null = null;
let popupSelection: { startRow: number; endRow: number; startCol: number; endCol: number } | null = null;
let popupPainting = false;
let paletteWindowDragging = false;
let paletteWindowOffset = { x: 0, y: 0 };
let paletteWindowPositioned = false;
let paletteScopeMode: PaletteScopeMode = "used";
let palettePage = 0;
let popupWindowDragging = false;
let popupWindowOffset = { x: 0, y: 0 };
let popupWindowPositioned = false;
let undoStack: EditPatch[] = [];
let redoStack: EditPatch[] = [];
let pendingPatch: PendingPatch | null = null;
let noiseMode = false;
let activeNoiseRemovals: NoiseRemovalRecord[] = [];
let nextNoiseRemovalId = 1;
let activeEditTool: EditToolId = "paint";
let mobilePaletteVisible = false;

hydrateStylePresets();
applyStylePreset(stylePresetSelect.value as StylePresetId, false);
syncMatchingAlgorithmHint("cam16ucs");
syncViewButtons();
syncEditorUi();

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const message = event.data;
  if (message.type === "ready") {
    paletteReady = true;
    hydratePaletteOptions(message.palettes);
    updateActionState();
    return;
  }
  if (message.type === "error") {
    setStatus(message.message, true);
    processButton.disabled = false;
    return;
  }

  latestResult = createRenderState(message);
  baseCellIndices = new Uint16Array(latestResult.cellIndices);
  currentView = "preview";
  selectedPaletteIndex = latestResult.stats[0]?.paletteIndex ?? 0;
  syncViewButtons();
  renderResult(latestResult);
  processButton.disabled = false;
};

worker.postMessage({ type: "init" });

fileInput.addEventListener("change", async () => handleIncomingFile(fileInput.files?.[0] ?? null));
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("is-dragging"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragging"));
dropzone.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropzone.classList.remove("is-dragging");
  await handleIncomingFile(event.dataTransfer?.files?.[0] ?? null);
});
stylePresetSelect.addEventListener("change", () => applyStylePreset(stylePresetSelect.value as StylePresetId, true));
widthRange.addEventListener("input", () => syncWidthInputs(widthRange.value));
widthNumber.addEventListener("input", () => syncWidthNumberDraft(widthNumber.value));
widthNumber.addEventListener("change", () => syncWidthInputs(widthNumber.value));
widthNumber.addEventListener("blur", () => syncWidthInputs(widthNumber.value));
matchingAlgorithmSelect.addEventListener("change", () => syncMatchingAlgorithmHint(matchingAlgorithmSelect.value as MatchingAlgorithmId));
mergeStrengthInput.addEventListener("input", () => syncMergeStrength(mergeStrengthInput.value));
cleanupStrengthInput.addEventListener("input", () => syncCleanupStrength(cleanupStrengthInput.value));
viewPreviewButton.addEventListener("click", () => { currentView = "preview"; syncViewButtons(); syncEditorUi(); if (latestResult) renderStats(latestResult); renderActiveCanvas(); });
viewEditButton.addEventListener("click", () => {
  if (!latestResult) return;
  currentView = "edit";
  if (selectedPaletteIndex === null) selectedPaletteIndex = latestResult.stats[0]?.paletteIndex ?? 0;
  syncViewButtons();
  syncEditorUi();
  renderEditorPalette();
  renderStats(latestResult);
  renderActiveCanvas();
});
downloadButton.addEventListener("click", () => {
  if (!latestResult) return;
  downloadDraftPng(latestResult);
});
noiseModeButton.addEventListener("click", () => {
  if (!latestResult || currentView !== "edit") return;
  noiseMode = !noiseMode;
  renderStats(latestResult);
  syncEditorUi();
});
undoButton.addEventListener("click", () => undoLastEdit());
redoButton.addEventListener("click", () => redoLastEdit());
mobileTools.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const toolButton = target.closest<HTMLButtonElement>("[data-edit-tool]");
  if (toolButton) {
    activeEditTool = toolButton.dataset.editTool as EditToolId;
    syncEditorUi();
    return;
  }
});
mobilePaletteToggle.addEventListener("click", () => {
  mobilePaletteVisible = !mobilePaletteVisible;
  syncEditorUi();
});
paletteWindowClose.addEventListener("click", () => {
  if (!isCompactTouchUi()) return;
  mobilePaletteVisible = false;
  syncEditorUi();
});
[toggleGrid, toggleLabels, toggleCoords, sectionSizeSelect].forEach((element) => {
  element.addEventListener("change", () => { if (currentView === "edit") renderActiveCanvas(); });
});
paletteWindowHeader.addEventListener("pointerdown", (event) => {
  if (currentView !== "edit" || isCompactTouchUi()) return;
  const rect = paletteWindow.getBoundingClientRect();
  paletteWindowDragging = true;
  paletteWindowOffset = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
  paletteWindowHeader.setPointerCapture(event.pointerId);
});
selectionPopupHead.addEventListener("pointerdown", (event) => {
  if (currentView !== "edit" || selectionPopup.classList.contains("is-hidden") || isCompactTouchUi()) return;
  const target = event.target as HTMLElement;
  if (target.closest("#selection-popup-close")) return;
  const rect = selectionPopupWindow.getBoundingClientRect();
  popupWindowDragging = true;
  popupWindowOffset = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
  selectionPopupHead.setPointerCapture(event.pointerId);
});
paletteWindow.addEventListener("click", (event) => {
  if (!latestResult) return;
  const target = event.target as HTMLElement;
  const scopeButton = target.closest<HTMLButtonElement>("[data-palette-scope]");
  if (scopeButton) {
    paletteScopeMode = scopeButton.dataset.paletteScope as PaletteScopeMode;
    palettePage = 0;
    renderEditorPalette();
    return;
  }
  const pageButton = target.closest<HTMLButtonElement>("[data-palette-page]");
  if (pageButton) {
    const delta = Number(pageButton.dataset.palettePage);
    const totalItems = getPaletteCollection(latestResult, paletteScopeMode).indices.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / PALETTE_PAGE_SIZE));
    palettePage = clamp(palettePage + delta, 0, totalPages - 1);
    renderEditorPalette();
    return;
  }
  const colorButton = target.closest<HTMLButtonElement>("[data-palette-index]");
  if (!colorButton) return;
  selectedPaletteIndex = Number(colorButton.dataset.paletteIndex);
  if (isCompactTouchUi()) {
    activeEditTool = "paint";
    mobilePaletteVisible = false;
  }
  syncEditorUi();
  renderEditorPalette();
  renderStats(latestResult);
});
statsRoot.addEventListener("click", (event) => {
  if (!latestResult || currentView !== "edit") return;
  const restoreButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-restore-noise]");
  if (restoreButton) {
    restoreNoiseRemoval(Number(restoreButton.dataset.restoreNoise));
    return;
  }
  const restoreAllButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-restore-all]");
  if (restoreAllButton) {
    restoreAllNoiseRemovals();
    return;
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-palette-index]");
  if (!button) return;
  if (!noiseMode) return;
  removeNoiseColor(Number(button.dataset.paletteIndex));
});
pixelCanvas.addEventListener("contextmenu", (event) => { if (currentView === "edit") event.preventDefault(); });
pixelCanvas.addEventListener("pointerdown", (event) => {
  if (!latestResult || currentView !== "edit") return;
  const cell = getCellFromPointer(event);
  if (!cell) return;
  const touchToolMode = isTouchEditingPointer(event);
  if (event.button === 2 || (touchToolMode && activeEditTool === "select")) {
    selectionDragStart = cell;
    selectionDragCurrent = cell;
    pixelCanvas.setPointerCapture(event.pointerId);
    updateSelectionOverlay();
    return;
  }
  if (event.altKey || (touchToolMode && activeEditTool === "pick")) { pickColorFromCell(cell.row, cell.col); return; }
  if (event.button !== 0) return;
  startPendingPatch("手动修改像素");
  pointerPainting = true;
  lastPaintedCell = -1;
  pixelCanvas.setPointerCapture(event.pointerId);
  paintCell(cell.row, cell.col);
});
pixelCanvas.addEventListener("pointermove", (event) => {
  const cell = getCellFromPointer(event);
  if (!cell) return;
  if (selectionDragStart && currentView === "edit") {
    selectionDragCurrent = cell;
    updateSelectionOverlay();
    return;
  }
  if (!pointerPainting || currentView !== "edit") return;
  paintCell(cell.row, cell.col);
});
selectionCanvas.addEventListener("contextmenu", (event) => { if (currentView === "edit") event.preventDefault(); });
selectionCanvas.addEventListener("pointerdown", (event) => {
  if (!latestResult || currentView !== "edit" || !popupSelection) return;
  const cell = getPopupCellFromPointer(event);
  if (!cell) return;
  if (event.button === 2 || event.altKey || (isTouchEditingPointer(event) && activeEditTool === "pick")) { pickColorFromCell(cell.row, cell.col); return; }
  if (event.button !== 0) return;
  startPendingPatch("局部编辑像素");
  popupPainting = true;
  lastPaintedCell = -1;
  selectionCanvas.setPointerCapture(event.pointerId);
  paintCell(cell.row, cell.col);
});
selectionCanvas.addEventListener("pointermove", (event) => {
  if (!popupPainting || currentView !== "edit") return;
  const cell = getPopupCellFromPointer(event);
  if (!cell) return;
  paintCell(cell.row, cell.col);
});
selectionPopupBackdrop.addEventListener("click", () => closeSelectionPopup());
selectionPopupClose.addEventListener("click", () => closeSelectionPopup());
window.addEventListener("pointermove", (event) => {
  if (!paletteWindowDragging) return;
  const left = clamp(event.clientX - paletteWindowOffset.x, 12, Math.max(12, window.innerWidth - paletteWindow.offsetWidth - 12));
  const top = clamp(event.clientY - paletteWindowOffset.y, 12, Math.max(12, window.innerHeight - paletteWindow.offsetHeight - 12));
  paletteWindow.style.left = `${left}px`;
  paletteWindow.style.top = `${top}px`;
  paletteWindowPositioned = true;
});
window.addEventListener("pointermove", (event) => {
  if (!popupWindowDragging) return;
  const visibleWidth = Math.min(280, Math.max(180, selectionPopupWindow.offsetWidth * 0.28));
  const visibleHeight = Math.min(96, Math.max(72, selectionPopupWindow.offsetHeight * 0.24));
  const left = clamp(event.clientX - popupWindowOffset.x, -selectionPopupWindow.offsetWidth + visibleWidth, window.innerWidth - visibleWidth);
  const top = clamp(event.clientY - popupWindowOffset.y, 10, window.innerHeight - visibleHeight);
  selectionPopupWindow.style.left = `${left}px`;
  selectionPopupWindow.style.top = `${top}px`;
  popupWindowPositioned = true;
});
const stopPainting = () => {
  const hadSelectionDrag = Boolean(selectionDragStart && selectionDragCurrent);
  if (selectionDragStart && selectionDragCurrent) {
    openSelectionPopup(selectionDragStart, selectionDragCurrent);
  }
  if (pointerPainting) {
    finalizePendingPatch();
  }
  pointerPainting = false;
  selectionDragStart = null;
  selectionDragCurrent = null;
  lastPaintedCell = -1;
  if (hadSelectionDrag) {
    updateSelectionOverlay();
  }
};
const stopPaletteWindowDrag = () => { paletteWindowDragging = false; };
const stopPopupWindowDrag = () => { popupWindowDragging = false; };
pixelCanvas.addEventListener("pointerup", stopPainting);
pixelCanvas.addEventListener("pointercancel", stopPainting);
const stopPopupPainting = () => { if (popupPainting) finalizePendingPatch(); popupPainting = false; lastPaintedCell = -1; };
selectionCanvas.addEventListener("pointerup", stopPopupPainting);
selectionCanvas.addEventListener("pointercancel", stopPopupPainting);
window.addEventListener("pointerup", stopPainting);
window.addEventListener("pointerup", stopPopupPainting);
window.addEventListener("pointerup", stopPaletteWindowDrag);
window.addEventListener("pointerup", stopPopupWindowDrag);
window.addEventListener("resize", () => {
  syncEditorUi();
  renderActiveCanvas();
});

processButton.addEventListener("click", async () => {
  if (!currentFile || !paletteReady) return;
  processButton.disabled = true;
  setStatus("正在后台处理图片并生成像素图...", false);
  try {
    const bitmap = await createImageBitmap(currentFile);
    worker.postMessage({
      type: "process",
      bitmap,
      paletteTitle: paletteSelect.value,
      targetWidth: Number(widthNumber.value),
      stylePresetId: stylePresetSelect.value as StylePresetId,
      matchingAlgorithmId: matchingAlgorithmSelect.value as MatchingAlgorithmId,
      colorMergeStrength: Number(mergeStrengthInput.value),
      cleanupStrength: Number(cleanupStrengthInput.value),
    }, [bitmap]);
  } catch (error) {
    processButton.disabled = false;
    setStatus(error instanceof Error ? error.message : "无法创建位图", true);
  }
});

window.addEventListener("beforeunload", () => { worker.terminate(); revokeSourceUrl(); sourceBitmap?.close(); });

async function handleIncomingFile(file: File | null): Promise<void> {
  currentFile = file;
  fileNameNode.textContent = file?.name ?? "未选择";
  clearResultState();
  if (!file) { clearSourcePreview(); updateActionState(); return; }

  try {
    await drawSourcePreview(file);
    setStatus("图片已就绪，点击生成像素图。", false);
  } catch (error) {
    clearSourcePreview();
    currentFile = null;
    fileNameNode.textContent = "未选择";
    setStatus(error instanceof Error ? error.message : "图片读取失败", true);
  }

  updateActionState();
}

function hydrateStylePresets(): void {
  stylePresetSelect.innerHTML = STYLE_PRESET_OPTIONS.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join("");
  stylePresetSelect.value = "none";
}
function syncMatchingAlgorithmHint(id: MatchingAlgorithmId): void {
  matchingAlgorithmSelect.value = id;
  matchingAlgorithmHint.textContent = id === "cam16ucs"
    ? "默认使用 CAM16-UCS，更贴近人眼感知，适合拼豆配色、肤色和低饱和色。"
    : "CIEDE2000 更偏经典工业色差模型，结果稳定，适合和标准模式做对比。";
}
function applyStylePreset(id: StylePresetId, updateSliders: boolean): void {
  const preset = STYLE_PRESET_OPTIONS.find((item) => item.id === id) ?? STYLE_PRESET_OPTIONS[0];
  stylePresetSelect.value = preset.id;
  stylePresetHint.textContent = preset.hint;
  if (updateSliders) {
    syncMergeStrength(String(preset.merge));
    syncCleanupStrength(String(preset.cleanup));
  } else {
    syncMergeStrength(mergeStrengthInput.value);
    syncCleanupStrength(cleanupStrengthInput.value);
  }
}
function hydratePaletteOptions(palettes: string[]): void {
  paletteSelect.innerHTML = palettes.map((palette) => `<option value="${escapeHtml(palette)}">${escapeHtml(palette)}</option>`).join("");
  const preferred = palettes.find((item) => item === "Mard-221") ?? palettes.find((item) => item.startsWith("Mard-")) ?? palettes[0];
  paletteSelect.value = preferred;
  paletteSelect.disabled = false;
  paletteHint.textContent = `已加载 ${palettes.length} 套色表`;
}
function syncWidthInputs(rawValue: string): void {
  const value = clamp(Math.round(Number(rawValue) || 100), 10, 200);
  widthRange.value = String(value);
  widthNumber.value = String(value);
  widthValue.textContent = `${value} 格`;
}
function syncWidthNumberDraft(rawValue: string): void {
  widthNumber.value = rawValue;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return;
  const previewValue = clamp(Math.round(parsed), 10, 200);
  widthRange.value = String(previewValue);
  widthValue.textContent = `${previewValue} 格`;
}
function syncCleanupStrength(rawValue: string): void {
  const value = clamp(Math.round(Number(rawValue) || 0), 0, 100);
  cleanupStrengthInput.value = String(value);
  cleanupStrengthValue.textContent = `${value} · ${describeCleanupStrength(value)}`;
}
function syncMergeStrength(rawValue: string): void {
  const value = clamp(Math.round(Number(rawValue) || 0), 0, 100);
  mergeStrengthInput.value = String(value);
  mergeStrengthValue.textContent = `${value} · ${describeMergeStrength(value)}`;
}
function syncViewButtons(): void {
  viewPreviewButton.classList.toggle("is-active", currentView === "preview");
  viewEditButton.classList.toggle("is-active", currentView === "edit");
}
function syncEditorUi(): void {
  const editing = currentView === "edit" && latestResult;
  editorControls.classList.toggle("is-hidden", !editing);
  mobileTools.classList.toggle("is-hidden", !(editing && isCompactTouchUi()));
  const shouldShowPaletteWindow = Boolean(editing && (!isCompactTouchUi() || mobilePaletteVisible));
  paletteWindow.classList.toggle("is-hidden", !shouldShowPaletteWindow);
  resultShell.classList.toggle("is-editing", Boolean(editing));
  pixelCanvas.classList.toggle("is-editing", Boolean(editing));
  downloadButton.disabled = !latestResult;
  syncMobileToolButtons();
  if (!editing || !latestResult) {
    resultCardTitle.textContent = "像素预览";
    resultCardSubtitle.textContent = "查看整体颜色效果";
    selectionPopupMeta.textContent = "框选一块区域后，会在这里放大显示。";
    paletteWindowCaption.textContent = "优先显示当前区域用到的颜色";
    paletteWindowSummary.innerHTML = "";
    palettePageMeta.textContent = "1 / 1";
    statsTitle.textContent = "色号统计";
    noiseModeButton.disabled = true;
    noiseModeButton.textContent = "去除杂色";
    noiseModeButton.classList.remove("is-active");
    undoButton.disabled = true;
    redoButton.disabled = true;
    historyNote.textContent = "还没有手动修改";
    mobilePaletteVisible = false;
    closeSelectionPopup(true);
    hideSelectionOverlay();
    return;
  }

  resultCardTitle.textContent = "手动编辑底稿";
  resultCardSubtitle.textContent = isCompactTouchUi()
    ? "手机端可用工具按钮切换画笔、取色和框选。"
    : "左键改色，右键拖动框选局部编辑";
  statsTitle.textContent = noiseMode ? "去除杂色" : "色号统计";
  noiseModeButton.disabled = false;
  noiseModeButton.textContent = noiseMode ? "返回统计" : "去除杂色";
  noiseModeButton.classList.toggle("is-active", noiseMode);
  undoButton.disabled = undoStack.length === 0;
  redoButton.disabled = redoStack.length === 0;
  historyNote.textContent = undoStack[undoStack.length - 1]?.label ?? "还没有手动修改";
  if (isCompactTouchUi()) {
    paletteWindowPositioned = false;
  }
  ensurePaletteWindowPosition();
}
async function drawSourcePreview(file: File): Promise<void> {
  sourceBitmap?.close();
  sourceBitmap = await createImageBitmap(file);
  revokeSourceUrl();
  sourceUrl = URL.createObjectURL(file);
  const context = sourceCanvas.getContext("2d");
  if (!context) throw new Error("无法创建原图画布");
  const side = 320;
  sourceCanvas.width = side;
  sourceCanvas.height = side;
  context.clearRect(0, 0, side, side);
  const ratio = Math.min(side / sourceBitmap.width, side / sourceBitmap.height);
  const drawWidth = sourceBitmap.width * ratio;
  const drawHeight = sourceBitmap.height * ratio;
  const offsetX = (side - drawWidth) / 2;
  const offsetY = (side - drawHeight) / 2;
  context.fillStyle = "#f4efe5";
  context.fillRect(0, 0, side, side);
  context.drawImage(sourceBitmap, offsetX, offsetY, drawWidth, drawHeight);
}
function clearSourcePreview(): void { sourceCanvas.getContext("2d")?.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height); }
function clearResultState(): void {
  latestResult = null;
  baseCellIndices = null;
  selectedPaletteIndex = null;
  currentView = "preview";
  paletteScopeMode = "used";
  palettePage = 0;
  noiseMode = false;
  lastDraftLayout = null;
  selectionDragStart = null;
  selectionDragCurrent = null;
  popupSelection = null;
  undoStack = [];
  redoStack = [];
  pendingPatch = null;
  activeNoiseRemovals = [];
  nextNoiseRemovalId = 1;
  syncViewButtons();
  syncEditorUi();
  pixelCanvas.getContext("2d")?.clearRect(0, 0, pixelCanvas.width, pixelCanvas.height);
  pixelCanvas.width = 320;
  pixelCanvas.height = 320;
  pixelCanvas.style.width = "320px";
  pixelCanvas.style.height = "320px";
  statsRoot.className = "empty-state";
  statsRoot.innerHTML = "<strong>还没有生成结果</strong><span>生成后这里会列出当前底稿实际使用到的色号、数量和总珠数。</span>";
  metaRoot.innerHTML = "";
  editorPalette.innerHTML = "";
  draftNote.textContent = "生成后默认显示像素预览，切换到手动编辑后会显示底稿和可修改像素。";
}
function createRenderState(message: ResultMessage): RenderState {
  const paletteRgb = message.paletteEntries.map((entry) => hexToRgb(entry.hex));
  const result: RenderState = {
    width: message.width,
    height: message.height,
    preview: new Uint8ClampedArray(message.previewBuffer),
    cellIndices: new Uint16Array(message.cellIndexBuffer),
    paletteEntries: message.paletteEntries,
    paletteRgb,
    stats: [],
    uniqueColorCount: 0,
    elapsedMs: message.elapsedMs,
  };
  rebuildDerivedState(result);
  return result;
}
function rebuildDerivedState(result: RenderState): void {
  const preview = new Uint8ClampedArray(result.width * result.height * 4);
  const counts = new Uint32Array(result.paletteEntries.length);
  for (let cellIndex = 0; cellIndex < result.cellIndices.length; cellIndex += 1) {
    const paletteIndex = result.cellIndices[cellIndex];
    const offset = cellIndex * 4;
    if (paletteIndex === TRANSPARENT_INDEX) {
      preview[offset] = 255; preview[offset + 1] = 255; preview[offset + 2] = 255; preview[offset + 3] = 0; continue;
    }
    const rgb = result.paletteRgb[paletteIndex];
    if (!rgb) continue;
    preview[offset] = rgb[0]; preview[offset + 1] = rgb[1]; preview[offset + 2] = rgb[2]; preview[offset + 3] = 255;
    counts[paletteIndex] += 1;
  }
  result.preview = preview;
  result.stats = Array.from(counts, (count, paletteIndex) => ({ count, paletteIndex }))
    .filter((item) => item.count > 0)
    .sort((left, right) => right.count - left.count)
    .map((item) => ({ ...result.paletteEntries[item.paletteIndex], paletteIndex: item.paletteIndex, count: item.count }));
  result.uniqueColorCount = result.stats.length;
}
function renderResult(result: RenderState): void {
  renderMeta(result);
  renderStats(result);
  renderEditorPalette();
  syncEditorUi();
  renderActiveCanvas();
  setStatus("像素图已生成，可以继续调整参数或进入手动编辑。", false);
}
function renderMeta(result: RenderState): void {
  const totalBeads = result.stats.reduce((sum, item) => sum + item.count, 0);
  const presetLabel = STYLE_PRESET_OPTIONS.find((item) => item.id === stylePresetSelect.value)?.label ?? "平均";
  const algorithmLabel = matchingAlgorithmSelect.value === "cam16ucs" ? "CAM16-UCS" : "CIEDE2000";
  metaRoot.innerHTML = [
    makeTag(`尺寸 ${result.width} × ${result.height}`),
    makeTag(`风格 ${presetLabel}`),
    makeTag(`算法 ${algorithmLabel}`),
    makeTag(`颜色数 ${result.uniqueColorCount}`),
    makeTag(`总珠数 ${totalBeads}`),
    makeTag(`耗时 ${result.elapsedMs.toFixed(1)} ms`),
    makeTag(escapeHtml(paletteSelect.value)),
  ].join("");
}
function renderStats(result: RenderState): void {
  const totalBeads = result.stats.reduce((sum, item) => sum + item.count, 0);
  const candidateLimit = Math.max(1, Math.min(12, Math.ceil(totalBeads * 0.0025)));
  const orderedStats = noiseMode
    ? [...result.stats].sort((left, right) => left.count - right.count || left.paletteIndex - right.paletteIndex)
    : result.stats;
  statsRoot.className = "stats-panel";
  statsRoot.innerHTML = `
    <div class="stats-summary">
      <div><span class="metric-label">总珠数</span><strong>${totalBeads}</strong></div>
      <div><span class="metric-label">颜色数</span><strong>${result.uniqueColorCount}</strong></div>
    </div>
    <p class="stats-hint">${noiseMode ? `已进入去除杂色模式，点击任意色号即可将该颜色并入更自然的邻近主色。建议优先处理 ${candidateLimit} 颗以内的低频颜色。` : "这里仅显示统计信息。手动编辑选色请使用左侧调色盘；进入去除杂色模式后，再点对应色号即可整体清理这个颜色。"}</p>
    <div class="stats-list">
      ${orderedStats.map((item) => `
        <button class="stats-item${noiseMode && item.count <= candidateLimit ? " is-noise-candidate" : ""}" type="button" data-palette-index="${item.paletteIndex}">
          <span class="swatch" style="background:${escapeHtml(item.hex)}"></span>
          <span class="stats-name"><strong>${escapeHtml(item.key)}</strong><span>${escapeHtml(item.title)} · ${escapeHtml(item.hex)}</span></span>
          ${noiseMode && item.count <= candidateLimit ? `<span class="stats-badge">建议</span>` : ""}
          <span class="stats-count">${item.count}</span>
        </button>
      `).join("")}
    </div>
    ${activeNoiseRemovals.length === 0 ? "" : `
      <div class="removed-panel">
        <div class="removed-panel-head">
          <strong>已移除的颜色 (${activeNoiseRemovals.length})</strong>
          <button class="ghost-button is-compact" type="button" data-restore-all>一键恢复所有颜色</button>
        </div>
        <div class="removed-list">
          ${activeNoiseRemovals.map((record) => {
            const entry = result.paletteEntries[record.paletteIndex];
            return `
              <div class="removed-item">
                <span class="swatch" style="background:${escapeHtml(entry?.hex ?? "#ffffff")}"></span>
                <span class="removed-name"><strong>${escapeHtml(entry?.key ?? record.label)}</strong><span>${escapeHtml(entry?.title ?? "")}</span></span>
                <span class="stats-count">${record.count}</span>
                <button class="ghost-button is-compact" type="button" data-restore-noise="${record.id}">恢复</button>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `}
  `;
}
function renderEditorPalette(): void {
  if (!latestResult || currentView !== "edit") {
    editorPalette.innerHTML = "";
    paletteWindowSummary.innerHTML = "";
    palettePageMeta.textContent = "1 / 1";
    paletteWindow.querySelectorAll<HTMLElement>("[data-palette-scope]").forEach((button) => button.classList.remove("is-active"));
    paletteWindow.querySelectorAll<HTMLButtonElement>("[data-palette-page]").forEach((button) => { button.disabled = true; });
    return;
  }
  const collection = getPaletteCollection(latestResult, paletteScopeMode);
  const totalPages = Math.max(1, Math.ceil(collection.indices.length / PALETTE_PAGE_SIZE));
  palettePage = clamp(palettePage, 0, totalPages - 1);
  const pageStart = palettePage * PALETTE_PAGE_SIZE;
  const visibleIndices = collection.indices.slice(pageStart, pageStart + PALETTE_PAGE_SIZE);

  paletteWindowCaption.textContent = collection.caption;
  palettePageMeta.textContent = `${palettePage + 1} / ${totalPages}`;
  paletteWindow.querySelectorAll<HTMLElement>("[data-palette-scope]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.paletteScope === paletteScopeMode);
  });
  paletteWindow.querySelectorAll<HTMLButtonElement>("[data-palette-page]").forEach((button) => {
    const delta = Number(button.dataset.palettePage);
    button.disabled = delta < 0 ? palettePage === 0 : palettePage >= totalPages - 1;
  });
  paletteWindowSummary.innerHTML = `
    <span class="palette-summary-chip">${escapeHtml(collection.summary)}</span>
    ${selectedPaletteIndex === null ? "<strong>未选择颜色</strong>" : `<strong>${escapeHtml(latestResult.paletteEntries[selectedPaletteIndex]?.key ?? "未选择颜色")}</strong>`}
    <span>${selectedPaletteIndex === null ? "点击下方颜色块即可切换当前画笔" : escapeHtml(`${latestResult.paletteEntries[selectedPaletteIndex]?.title ?? ""} · ${latestResult.paletteEntries[selectedPaletteIndex]?.hex ?? ""}`)}</span>
  `;

  if (visibleIndices.length === 0) {
    editorPalette.innerHTML = `<div class="palette-empty">当前没有可显示的颜色</div>`;
    return;
  }

  editorPalette.innerHTML = visibleIndices.map((paletteIndex) => {
    const entry = latestResult.paletteEntries[paletteIndex];
    const usedCount = collection.counts.get(paletteIndex) ?? 0;
    return `
      <button class="palette-chip${selectedPaletteIndex === paletteIndex ? " is-active" : ""}${usedCount ? " is-used" : ""}" style="--palette-accent:${escapeHtml(entry.hex)}" type="button" data-palette-index="${paletteIndex}" title="${escapeHtml(`${entry.key} ${entry.title} ${entry.hex}`)}">
        <span class="palette-chip-fill" aria-hidden="true"></span>
      </button>
    `;
  }).join("");
}
function renderActiveCanvas(): void {
  if (!latestResult) return;
  if (currentView === "preview") {
    hideSelectionOverlay();
    renderPixelPreview(latestResult);
    draftNote.textContent = "默认显示像素预览，方便先看整体颜色和结构。";
    return;
  }
  const labelVisible = renderPatternDraft(latestResult);
  renderSelectionPopup();
  updateSelectionOverlay();
  draftNote.textContent = labelVisible ? "当前是手动编辑模式，左键改色，右键拖动框选区域后会弹出局部编辑窗。" : "当前是手动编辑模式，右键拖动框选区域后会弹出局部编辑窗。";
}
function renderPixelPreview(result: RenderState): void {
  const context = pixelCanvas.getContext("2d");
  if (!context) return;
  lastDraftLayout = null;
  const imageData = new ImageData(result.preview, result.width, result.height);
  pixelCanvas.width = result.width;
  pixelCanvas.height = result.height;
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, result.width, result.height);
  context.putImageData(imageData, 0, 0);
  const maxPreviewSize = window.innerWidth < 860 ? 420 : 620;
  const scale = Math.max(1, Math.floor(maxPreviewSize / Math.max(result.width, result.height)));
  pixelCanvas.style.width = `${result.width * scale}px`;
  pixelCanvas.style.height = `${result.height * scale}px`;
}
function renderPatternDraft(result: RenderState): boolean {
  const context = pixelCanvas.getContext("2d");
  if (!context) return false;
  const wantsLabels = toggleLabels.checked;
  const longestSide = Math.max(result.width, result.height);
  const stageBase = window.innerWidth < 860 ? 420 : 730;
  const densityFactor = longestSide >= 112 ? 0.68 : longestSide >= 88 ? 0.78 : longestSide >= 64 ? 0.9 : 1;
  const maxPatternSize = Math.round(stageBase * densityFactor);
  const minCellSize = wantsLabels ? (window.innerWidth < 860 ? 10 : 11) : 8;
  const maxCellSize = wantsLabels ? 20 : 24;
  const cellSize = clamp(Math.floor(maxPatternSize / longestSide), minCellSize, maxCellSize);
  const sectionSize = clamp(Number(sectionSizeSelect.value) || 10, 2, 50);
  const showGrid = toggleGrid.checked;
  const showCoords = toggleCoords.checked;
  const axisSize = showCoords ? Math.max(24, cellSize + 6) : 0;
  const canvasWidth = (result.width * cellSize) + (axisSize * 2);
  const canvasHeight = (result.height * cellSize) + (axisSize * 2);
  const availableDisplayWidth = Math.max(280, resultShell.clientWidth - 24);
  const displayScale = Math.min(1, availableDisplayWidth / canvasWidth);
  lastDraftLayout = { cellSize, axisSize, width: result.width, height: result.height };
  pixelCanvas.width = canvasWidth;
  pixelCanvas.height = canvasHeight;
  pixelCanvas.style.width = `${Math.floor(canvasWidth * displayScale)}px`;
  pixelCanvas.style.height = `${Math.floor(canvasHeight * displayScale)}px`;
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, canvasWidth, canvasHeight);
  context.fillStyle = "#fffdfa";
  context.fillRect(0, 0, canvasWidth, canvasHeight);
  if (showCoords) {
    context.fillStyle = "#f4ede3";
    context.fillRect(axisSize, 0, result.width * cellSize, axisSize);
    context.fillRect(axisSize, axisSize + (result.height * cellSize), result.width * cellSize, axisSize);
    context.fillRect(0, axisSize, axisSize, result.height * cellSize);
    context.fillRect(axisSize + (result.width * cellSize), axisSize, axisSize, result.height * cellSize);
  }
  for (let row = 0; row < result.height; row += 1) {
    for (let col = 0; col < result.width; col += 1) {
      const x = axisSize + (col * cellSize);
      const y = axisSize + (row * cellSize);
      const entry = getPaletteEntry(result, row, col);
      context.fillStyle = entry?.hex ?? "#ffffff";
      context.fillRect(x, y, cellSize, cellSize);
      if (wantsLabels && entry) {
        context.fillStyle = getContrastText(entry.hex);
        context.font = `700 ${Math.max(6, Math.floor(cellSize * 0.26))}px "Space Grotesk", "Noto Sans SC", sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(entry.key, x + (cellSize / 2), y + (cellSize / 2), cellSize - 4);
      }
      if (showGrid) {
        context.strokeStyle = "rgba(102, 83, 58, 0.24)";
        context.lineWidth = 1;
        context.strokeRect(x + 0.5, y + 0.5, cellSize, cellSize);
      }
    }
  }
  context.strokeStyle = "rgba(73, 53, 32, 0.72)";
  context.lineWidth = 1.6;
  context.strokeRect(axisSize + 0.5, axisSize + 0.5, result.width * cellSize, result.height * cellSize);
  context.strokeStyle = "rgba(229, 107, 47, 0.72)";
  context.lineWidth = Math.max(1.4, cellSize * 0.1);
  for (let col = sectionSize; col < result.width; col += sectionSize) {
    const x = axisSize + (col * cellSize); context.beginPath(); context.moveTo(x, axisSize); context.lineTo(x, axisSize + (result.height * cellSize)); context.stroke();
  }
  for (let row = sectionSize; row < result.height; row += sectionSize) {
    const y = axisSize + (row * cellSize); context.beginPath(); context.moveTo(axisSize, y); context.lineTo(axisSize + (result.width * cellSize), y); context.stroke();
  }
  if (showCoords) {
    context.fillStyle = "#4b3b2a";
    context.font = `600 ${Math.max(10, Math.floor(cellSize * 0.42))}px "Space Grotesk", "Noto Sans SC", sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (let col = 0; col < result.width; col += 1) {
      if (!shouldDrawCoordinate(col, result.width, sectionSize)) continue;
      const x = axisSize + (col * cellSize) + (cellSize / 2); const label = String(col + 1); context.fillText(label, x, axisSize / 2); context.fillText(label, x, axisSize + (result.height * cellSize) + (axisSize / 2));
    }
    for (let row = 0; row < result.height; row += 1) {
      if (!shouldDrawCoordinate(row, result.height, sectionSize)) continue;
      const y = axisSize + (row * cellSize) + (cellSize / 2); const label = String(row + 1); context.fillText(label, axisSize / 2, y); context.fillText(label, axisSize + (result.width * cellSize) + (axisSize / 2), y);
    }
  }
  return wantsLabels;
}
function downloadDraftPng(result: RenderState): void {
  const exportCanvas = document.createElement("canvas");
  const context = exportCanvas.getContext("2d");
  if (!context) {
    setStatus("无法创建导出画布。", true);
    return;
  }

  const pagePadding = 28;
  const headerHeight = 46;
  const statsTopGap = 28;
  const gridCellSize = chooseExportCellSize(result.width, result.height);
  const gridWidth = result.width * gridCellSize;
  const gridHeight = result.height * gridCellSize;
  const pageWidth = Math.max(gridWidth + (pagePadding * 2), 1360);
  const statsColumns = chooseExportStatsColumns(pageWidth, result.stats.length);
  const statRowHeight = 30;
  const statRows = Math.max(1, Math.ceil(result.stats.length / statsColumns));
  const statsHeight = 72 + (statRows * statRowHeight);
  const pageHeight = headerHeight + pagePadding + gridHeight + statsTopGap + statsHeight + pagePadding;
  const exportScale = chooseExportScale(result.width, result.height);

  exportCanvas.width = Math.round(pageWidth * exportScale);
  exportCanvas.height = Math.round(pageHeight * exportScale);
  context.imageSmoothingEnabled = false;
  context.scale(exportScale, exportScale);

  context.fillStyle = "#fbfaf7";
  context.fillRect(0, 0, pageWidth, pageHeight);

  drawDraftExportHeader(context, pageWidth, headerHeight, result);

  const gridX = Math.round((pageWidth - gridWidth) / 2);
  const gridY = headerHeight + pagePadding;
  drawDraftExportGrid(context, result, gridX, gridY, gridCellSize);

  const statsY = gridY + gridHeight + statsTopGap;
  drawDraftExportStats(context, result, pagePadding, statsY, pageWidth - (pagePadding * 2), statsColumns, statRowHeight);

  const link = document.createElement("a");
  link.href = exportCanvas.toDataURL("image/png");
  link.download = buildExportFilename(result);
  link.click();
  setStatus("图纸 PNG 已生成并开始下载。", false);
}
function chooseExportCellSize(width: number, height: number): number {
  const longest = Math.max(width, height);
  if (longest <= 48) return 28;
  if (longest <= 72) return 22;
  if (longest <= 100) return 16;
  if (longest <= 140) return 13;
  if (longest <= 180) return 12;
  return 10;
}
function chooseExportScale(width: number, height: number): number {
  const longest = Math.max(width, height);
  if (longest <= 100) return 2;
  if (longest <= 160) return 1.6;
  return 1.3;
}
function chooseExportStatsColumns(pageWidth: number, statCount: number): number {
  if (statCount <= 12) return 3;
  if (pageWidth < 1200) return 3;
  return 4;
}
function drawDraftExportHeader(context: CanvasRenderingContext2D, pageWidth: number, headerHeight: number, result: RenderState): void {
  context.fillStyle = "#232b3a";
  context.fillRect(0, 0, pageWidth, headerHeight);

  context.fillStyle = "#8f6bff";
  context.fillRect(10, 10, 18, 18);
  context.fillStyle = "#ffffff";
  context.fillRect(14, 14, 4, 4);
  context.fillRect(20, 14, 4, 4);
  context.fillRect(14, 20, 4, 4);
  context.fillRect(20, 20, 4, 4);

  context.fillStyle = "#ffffff";
  context.font = '700 14px "Space Grotesk", "Noto Sans SC", sans-serif';
  context.textBaseline = "middle";
  context.fillText("拼豆底稿工坊", 38, 20);

  context.fillStyle = "rgba(255,255,255,0.75)";
  context.font = '500 10px "Space Grotesk", "Noto Sans SC", sans-serif';
  context.fillText(`${result.width}×${result.height} · ${paletteSelect.value}`, 38, 32);

  const badgeText = `总计 ${result.stats.reduce((sum, item) => sum + item.count, 0)} 颗`;
  const badgeWidth = Math.ceil(context.measureText(badgeText).width) + 18;
  const badgeX = pageWidth - badgeWidth - 10;
  context.fillStyle = "#ffffff";
  context.fillRect(badgeX, 9, badgeWidth, 24);
  context.strokeStyle = "rgba(35, 43, 58, 0.12)";
  context.strokeRect(badgeX + 0.5, 9.5, badgeWidth - 1, 23);
  context.fillStyle = "#232b3a";
  context.font = '700 11px "Space Grotesk", "Noto Sans SC", sans-serif';
  context.fillText(badgeText, badgeX + 9, 21);
}
function drawDraftExportGrid(context: CanvasRenderingContext2D, result: RenderState, startX: number, startY: number, cellSize: number): void {
  context.fillStyle = "#ffffff";
  context.fillRect(startX, startY, result.width * cellSize, result.height * cellSize);

  for (let row = 0; row < result.height; row += 1) {
    for (let col = 0; col < result.width; col += 1) {
      const x = startX + (col * cellSize);
      const y = startY + (row * cellSize);
      const entry = getPaletteEntry(result, row, col);
      context.fillStyle = entry?.hex ?? "#ffffff";
      context.fillRect(x, y, cellSize, cellSize);
      context.strokeStyle = "rgba(120, 110, 110, 0.18)";
      context.lineWidth = 1;
      context.strokeRect(x + 0.5, y + 0.5, cellSize, cellSize);
      if (entry && cellSize >= 8) {
        context.fillStyle = getContrastText(entry.hex);
        const keyLength = entry.key.length;
        const fontSize = Math.max(5, Math.floor(cellSize * (keyLength >= 4 ? 0.28 : keyLength === 3 ? 0.34 : 0.44)));
        context.font = `700 ${fontSize}px "Space Grotesk", "Noto Sans SC", sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.save();
        context.beginPath();
        context.rect(x + 1, y + 1, cellSize - 2, cellSize - 2);
        context.clip();
        context.fillText(entry.key, x + (cellSize / 2), y + (cellSize / 2), cellSize - 3);
        context.restore();
      }
    }
  }

  context.strokeStyle = "rgba(72, 61, 61, 0.82)";
  context.lineWidth = 1.4;
  context.strokeRect(startX + 0.5, startY + 0.5, result.width * cellSize, result.height * cellSize);

  context.strokeStyle = "rgba(168, 145, 133, 0.9)";
  context.lineWidth = Math.max(1.4, cellSize * 0.12);
  for (let col = 10; col < result.width; col += 10) {
    const x = startX + (col * cellSize);
    context.beginPath();
    context.moveTo(x, startY);
    context.lineTo(x, startY + (result.height * cellSize));
    context.stroke();
  }
  for (let row = 10; row < result.height; row += 10) {
    const y = startY + (row * cellSize);
    context.beginPath();
    context.moveTo(startX, y);
    context.lineTo(startX + (result.width * cellSize), y);
    context.stroke();
  }
}
function drawDraftExportStats(
  context: CanvasRenderingContext2D,
  result: RenderState,
  startX: number,
  startY: number,
  availableWidth: number,
  columns: number,
  rowHeight: number,
): void {
  const totalBeads = result.stats.reduce((sum, item) => sum + item.count, 0);
  const columnGap = 18;
  const columnWidth = Math.floor((availableWidth - (columnGap * (columns - 1))) / columns);
  const panelHeight = 54 + (Math.ceil(result.stats.length / columns) * rowHeight);

  context.fillStyle = "rgba(255, 255, 255, 0.94)";
  context.fillRect(startX, startY, availableWidth, panelHeight);
  context.strokeStyle = "rgba(83, 67, 61, 0.16)";
  context.strokeRect(startX + 0.5, startY + 0.5, availableWidth - 1, panelHeight - 1);

  context.fillStyle = "#55413e";
  context.font = '700 12px "Space Grotesk", "Noto Sans SC", sans-serif';
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText("色号统计", startX + 12, startY + 18);

  context.fillStyle = "#55413e";
  context.font = '700 11px "Space Grotesk", "Noto Sans SC", sans-serif';
  context.textBaseline = "middle";

  result.stats.forEach((item, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = startX + (column * (columnWidth + columnGap));
    const y = startY + 42 + (row * rowHeight);

    context.fillStyle = item.hex;
    context.fillRect(x, y - 7, 14, 14);
    context.strokeStyle = "rgba(43, 29, 14, 0.14)";
    context.strokeRect(x + 0.5, y - 6.5, 13, 13);

    context.fillStyle = "#4d3c39";
    context.textAlign = "left";
    context.fillText(item.key, x + 20, y);
    context.textAlign = "right";
    context.fillText(`${item.count} 颗`, x + columnWidth - 6, y);
  });

  context.fillStyle = "#4d3c39";
  context.font = '700 12px "Space Grotesk", "Noto Sans SC", sans-serif';
  context.textAlign = "right";
  context.fillText(`总计 ${totalBeads} 颗`, startX + availableWidth - 12, startY + panelHeight - 18);
}
function buildExportFilename(result: RenderState): string {
  const paletteName = paletteSelect.value.replaceAll(/\s+/g, "_");
  return `bead-grid-${result.width}x${result.height}-keys-palette_${paletteName}.png`;
}
function getCellFromPointer(event: PointerEvent): { row: number; col: number } | null {
  if (!latestResult || !lastDraftLayout) return null;
  const rect = pixelCanvas.getBoundingClientRect();
  const scaleX = pixelCanvas.width / rect.width;
  const scaleY = pixelCanvas.height / rect.height;
  const canvasX = (event.clientX - rect.left) * scaleX;
  const canvasY = (event.clientY - rect.top) * scaleY;
  const localX = canvasX - lastDraftLayout.axisSize;
  const localY = canvasY - lastDraftLayout.axisSize;
  if (localX < 0 || localY < 0) return null;
  const col = Math.floor(localX / lastDraftLayout.cellSize);
  const row = Math.floor(localY / lastDraftLayout.cellSize);
  if (col < 0 || row < 0 || col >= latestResult.width || row >= latestResult.height) return null;
  return { row, col };
}
function getPopupCellFromPointer(event: PointerEvent): { row: number; col: number } | null {
  if (!latestResult || !popupSelection) return null;
  const rect = selectionCanvas.getBoundingClientRect();
  const scaleX = selectionCanvas.width / rect.width;
  const scaleY = selectionCanvas.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  if (x < 0 || y < 0 || x > selectionCanvas.width || y > selectionCanvas.height) return null;
  const cols = (popupSelection.endCol - popupSelection.startCol) + 1;
  const rows = (popupSelection.endRow - popupSelection.startRow) + 1;
  const cellWidth = selectionCanvas.width / cols;
  const cellHeight = selectionCanvas.height / rows;
  return {
    row: popupSelection.startRow + Math.floor(y / cellHeight),
    col: popupSelection.startCol + Math.floor(x / cellWidth),
  };
}
function normalizeCellRect(start: { row: number; col: number }, end: { row: number; col: number }) {
  return {
    startRow: Math.min(start.row, end.row),
    endRow: Math.max(start.row, end.row),
    startCol: Math.min(start.col, end.col),
    endCol: Math.max(start.col, end.col),
  };
}
function getHighlightedRegion(result: RenderState) {
  if (selectionDragStart && selectionDragCurrent) {
    return normalizeCellRect(selectionDragStart, selectionDragCurrent);
  }
  if (popupSelection) {
    return popupSelection;
  }
  return null;
}
function hideSelectionOverlay(): void {
  selectionOverlay.classList.add("is-hidden");
}
function updateSelectionOverlay(): void {
  if (!latestResult || currentView !== "edit" || !lastDraftLayout) {
    hideSelectionOverlay();
    return;
  }

  const region = getHighlightedRegion(latestResult);
  if (!region) {
    hideSelectionOverlay();
    return;
  }

  const displayScaleX = pixelCanvas.width > 0 ? pixelCanvas.offsetWidth / pixelCanvas.width : 1;
  const displayScaleY = pixelCanvas.height > 0 ? pixelCanvas.offsetHeight / pixelCanvas.height : 1;
  const axisDisplayWidth = lastDraftLayout.axisSize * displayScaleX;
  const axisDisplayHeight = lastDraftLayout.axisSize * displayScaleY;
  const cellDisplayWidth = lastDraftLayout.cellSize * displayScaleX;
  const cellDisplayHeight = lastDraftLayout.cellSize * displayScaleY;

  const left = pixelCanvas.offsetLeft + axisDisplayWidth + (region.startCol * cellDisplayWidth);
  const top = pixelCanvas.offsetTop + axisDisplayHeight + (region.startRow * cellDisplayHeight);
  const width = ((region.endCol - region.startCol) + 1) * cellDisplayWidth;
  const height = ((region.endRow - region.startRow) + 1) * cellDisplayHeight;

  selectionOverlay.style.left = `${left}px`;
  selectionOverlay.style.top = `${top}px`;
  selectionOverlay.style.width = `${width}px`;
  selectionOverlay.style.height = `${height}px`;
  selectionOverlay.classList.remove("is-hidden");
}
function openSelectionPopup(start: { row: number; col: number }, end: { row: number; col: number }): void {
  popupSelection = normalizeCellRect(start, end);
  paletteScopeMode = "region";
  palettePage = 0;
  if (isCompactTouchUi()) {
    mobilePaletteVisible = false;
  }
  selectionPopup.classList.remove("is-hidden");
  popupWindowPositioned = false;
  ensureSelectionPopupPosition();
  renderSelectionPopup();
  renderEditorPalette();
}
function closeSelectionPopup(silent = false): void {
  popupSelection = null;
  selectionPopup.classList.add("is-hidden");
  clearSelectionCanvas();
  if (paletteScopeMode === "region") {
    paletteScopeMode = "used";
    palettePage = 0;
    renderEditorPalette();
  }
  updateSelectionOverlay();
  if (!silent) {
    renderActiveCanvas();
  }
}
function clearSelectionCanvas(): void {
  const context = selectionCanvas.getContext("2d");
  if (!context) return;
  selectionCanvas.width = 320;
  selectionCanvas.height = 320;
  context.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
}
function ensureSelectionPopupPosition(): void {
  if (popupWindowPositioned) return;
  const maxLeft = Math.max(12, window.innerWidth - selectionPopupWindow.offsetWidth - 12);
  const maxTop = Math.max(16, window.innerHeight - selectionPopupWindow.offsetHeight - 16);
  const left = clamp(Math.round((window.innerWidth - selectionPopupWindow.offsetWidth) / 2), 12, maxLeft);
  const top = clamp(Math.round((window.innerHeight - selectionPopupWindow.offsetHeight) / 2), 16, maxTop);
  selectionPopupWindow.style.left = `${left}px`;
  selectionPopupWindow.style.top = `${top}px`;
  popupWindowPositioned = true;
}
function renderSelectionPopup(): void {
  const context = selectionCanvas.getContext("2d");
  if (!context) return;
  if (!latestResult || !popupSelection || currentView !== "edit") {
    clearSelectionCanvas();
    return;
  }

  const cols = (popupSelection.endCol - popupSelection.startCol) + 1;
  const rows = (popupSelection.endRow - popupSelection.startRow) + 1;
  const popupWidth = Math.min(window.innerWidth - 12, 1320);
  const shellPadding = 20;
  const popupPadding = 24;
  const availableWidth = Math.max(360, popupWidth - shellPadding - popupPadding);
  const availableHeight = Math.max(320, Math.min(window.innerHeight - 128, 780));
  const fitWidthCellSize = Math.floor(availableWidth / cols);
  const fitHeightCellSize = Math.floor(availableHeight / rows);
  const cellSize = clamp(Math.min(fitWidthCellSize, fitHeightCellSize, 64), 12, 64);
  const canvasWidth = cols * cellSize;
  const canvasHeight = rows * cellSize;
  const showLabelsInPopup = toggleLabels.checked && cellSize >= 18;

  selectionCanvas.width = canvasWidth;
  selectionCanvas.height = canvasHeight;
  selectionCanvas.style.width = `${canvasWidth}px`;
  selectionCanvas.style.height = `${canvasHeight}px`;
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, canvasWidth, canvasHeight);
  context.fillStyle = "#fffdfa";
  context.fillRect(0, 0, canvasWidth, canvasHeight);

  for (let row = popupSelection.startRow; row <= popupSelection.endRow; row += 1) {
    for (let col = popupSelection.startCol; col <= popupSelection.endCol; col += 1) {
      const x = (col - popupSelection.startCol) * cellSize;
      const y = (row - popupSelection.startRow) * cellSize;
      const entry = getPaletteEntry(latestResult, row, col);
      context.fillStyle = entry?.hex ?? "#f7efe4";
      context.fillRect(x, y, cellSize, cellSize);
      context.strokeStyle = "rgba(102, 83, 58, 0.22)";
      context.lineWidth = 1;
      context.strokeRect(x + 0.5, y + 0.5, cellSize, cellSize);
      if (showLabelsInPopup && entry) {
        context.fillStyle = getContrastText(entry.hex);
        context.font = `700 ${Math.max(9, Math.floor(cellSize * 0.28))}px "Space Grotesk", "Noto Sans SC", sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(entry.key, x + (cellSize / 2), y + (cellSize / 2), cellSize - 6);
      }
    }
  }

  selectionPopupMeta.textContent = `当前区域：第 ${popupSelection.startRow + 1}-${popupSelection.endRow + 1} 行，第 ${popupSelection.startCol + 1}-${popupSelection.endCol + 1} 列。已自动横向铺满${showLabelsInPopup ? "，保留色号显示" : "，宽区域会自动隐藏编号以便完整显示"}。`;
}
function ensurePaletteWindowPosition(): void {
  if (paletteWindowPositioned) return;
  if (isCompactTouchUi()) {
    paletteWindow.style.left = "12px";
    paletteWindow.style.right = "12px";
    paletteWindow.style.top = "auto";
    paletteWindow.style.bottom = "10px";
    paletteWindowPositioned = true;
    return;
  }
  paletteWindow.style.right = "auto";
  paletteWindow.style.bottom = "auto";
  const left = 14;
  const top = Math.max(92, Math.min(window.innerHeight - 420, 118));
  paletteWindow.style.left = `${left}px`;
  paletteWindow.style.top = `${top}px`;
  paletteWindowPositioned = true;
}
function getPaletteCollection(result: RenderState, scope: PaletteScopeMode): { indices: number[]; counts: Map<number, number>; caption: string; summary: string } {
  const usageCounts = new Map(result.stats.map((item) => [item.paletteIndex, item.count]));

  if (scope === "region" && popupSelection) {
    const regionCounts = new Map<number, number>();
    for (let row = popupSelection.startRow; row <= popupSelection.endRow; row += 1) {
      for (let col = popupSelection.startCol; col <= popupSelection.endCol; col += 1) {
        const paletteIndex = result.cellIndices[(row * result.width) + col];
        if (paletteIndex === TRANSPARENT_INDEX) continue;
        regionCounts.set(paletteIndex, (regionCounts.get(paletteIndex) ?? 0) + 1);
      }
    }
    if (regionCounts.size > 0) {
      const indices = [...regionCounts.entries()]
        .sort((left, right) => right[1] - left[1] || (usageCounts.get(right[0]) ?? 0) - (usageCounts.get(left[0]) ?? 0))
        .map(([paletteIndex]) => paletteIndex);
      return {
        indices,
        counts: regionCounts,
        caption: "当前框选区域用到的颜色，方便局部精修时直接切换。",
        summary: `区域色 ${regionCounts.size} 种`,
      };
    }
  }

  if (scope === "all") {
    const indices = [
      ...result.stats.map((item) => item.paletteIndex),
      ...result.paletteEntries.map((_, index) => index).filter((index) => !usageCounts.has(index)),
    ];
    return {
      indices,
      counts: usageCounts,
      caption: "完整色表，已用色会排在前面，不需要上下长滚动查找。",
      summary: `完整色表 ${result.paletteEntries.length} 色`,
    };
  }

  const indices = result.stats.map((item) => item.paletteIndex);
  return {
    indices,
    counts: usageCounts,
    caption: "当前底稿已经用到的颜色，适合直接照着修改。",
    summary: `已用色 ${result.stats.length} 种`,
  };
}
function startPendingPatch(label: string): void {
  pendingPatch = { label, before: new Map(), after: new Map() };
}
function finalizePendingPatch(): void {
  if (!pendingPatch) return;
  const indices = [...pendingPatch.after.keys()];
  if (indices.length === 0) {
    pendingPatch = null;
    return;
  }
  const patch: EditPatch = {
    label: pendingPatch.label,
    indices,
    before: indices.map((index) => pendingPatch!.before.get(index) ?? TRANSPARENT_INDEX),
    after: indices.map((index) => pendingPatch!.after.get(index) ?? TRANSPARENT_INDEX),
    kind: "paint",
  };
  undoStack.push(patch);
  redoStack = [];
  pendingPatch = null;
  syncEditorUi();
  renderStats(latestResult!);
}
function replayFromBase(): void {
  if (!latestResult || !baseCellIndices) return;
  latestResult.cellIndices = new Uint16Array(baseCellIndices);
  for (const patch of undoStack) {
    patch.indices.forEach((index, position) => {
      latestResult!.cellIndices[index] = patch.after[position];
    });
  }
  scheduleResultRefresh();
}
function undoLastEdit(): void {
  const patch = undoStack.pop();
  if (!patch) return;
  redoStack.push(patch);
  if (patch.kind === "noise-remove" && patch.noiseRecordId !== undefined) {
    activeNoiseRemovals = activeNoiseRemovals.filter((record) => record.id !== patch.noiseRecordId);
  }
  replayFromBase();
  setStatus(`已撤销：${patch.label}`, false);
  syncEditorUi();
}
function redoLastEdit(): void {
  const patch = redoStack.pop();
  if (!patch) return;
  undoStack.push(patch);
  if (patch.kind === "noise-remove" && patch.noiseRecordId !== undefined && patch.paletteIndex !== undefined && !activeNoiseRemovals.some((record) => record.id === patch.noiseRecordId)) {
    activeNoiseRemovals.unshift({
      id: patch.noiseRecordId,
      paletteIndex: patch.paletteIndex,
      label: patch.label,
      patch,
      count: patch.indices.length,
    });
  }
  replayFromBase();
  setStatus(`已重做：${patch.label}`, false);
  syncEditorUi();
}
function removeNoiseColor(paletteIndex: number): void {
  if (!latestResult) return;
  const targetCells: number[] = [];
  for (let index = 0; index < latestResult.cellIndices.length; index += 1) {
    if (latestResult.cellIndices[index] === paletteIndex) {
      targetCells.push(index);
    }
  }
  if (targetCells.length === 0) return;

  const changedIndices: number[] = [];
  const before: number[] = [];
  const after: number[] = [];
  for (const cellIndex of targetCells) {
    const replacement = getBestReplacementForNoise(latestResult, cellIndex, paletteIndex);
    if (replacement === paletteIndex) continue;
    changedIndices.push(cellIndex);
    before.push(paletteIndex);
    after.push(replacement);
  }
  if (after.length === 0) {
    setStatus("这个颜色附近没有合适的替换主色，暂时未处理。", true);
    return;
  }

  const recordId = nextNoiseRemovalId;
  nextNoiseRemovalId += 1;
  const patch: EditPatch = {
    label: `去除杂色 ${latestResult.paletteEntries[paletteIndex]?.key ?? paletteIndex}`,
    indices: changedIndices,
    before,
    after,
    kind: "noise-remove",
    noiseRecordId: recordId,
    paletteIndex,
  };

  undoStack.push(patch);
  redoStack = [];
  activeNoiseRemovals.unshift({
    id: recordId,
    paletteIndex,
    label: patch.label,
    patch,
    count: patch.indices.length,
  });
  replayFromBase();
  syncEditorUi();
  setStatus(`已去除杂色 ${latestResult.paletteEntries[paletteIndex]?.key ?? paletteIndex}，可随时撤销。`, false);
}
function restoreNoiseRemoval(recordId: number): void {
  const record = activeNoiseRemovals.find((item) => item.id === recordId);
  if (!record || !latestResult) return;
  activeNoiseRemovals = activeNoiseRemovals.filter((item) => item.id !== recordId);
  undoStack = undoStack.filter((patch) => patch.noiseRecordId !== recordId);
  redoStack = redoStack.filter((patch) => patch.noiseRecordId !== recordId);
  replayFromBase();
  syncEditorUi();
  setStatus(`已恢复颜色 ${latestResult.paletteEntries[record.paletteIndex]?.key ?? record.label}。`, false);
}
function restoreAllNoiseRemovals(): void {
  if (!latestResult || activeNoiseRemovals.length === 0) return;
  const removedIds = new Set(activeNoiseRemovals.map((record) => record.id));
  activeNoiseRemovals = [];
  undoStack = undoStack.filter((patch) => !removedIds.has(patch.noiseRecordId ?? -1));
  redoStack = redoStack.filter((patch) => !removedIds.has(patch.noiseRecordId ?? -1));
  replayFromBase();
  syncEditorUi();
  setStatus("已一键恢复所有已移除颜色。", false);
}
function getBestReplacementForNoise(result: RenderState, cellIndex: number, targetPaletteIndex: number): number {
  const row = Math.floor(cellIndex / result.width);
  const col = cellIndex % result.width;
  const neighborCounts = new Map<number, number>();
  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
      if (rowOffset === 0 && colOffset === 0) continue;
      const nextRow = row + rowOffset;
      const nextCol = col + colOffset;
      if (nextRow < 0 || nextCol < 0 || nextRow >= result.height || nextCol >= result.width) continue;
      const nextIndex = result.cellIndices[(nextRow * result.width) + nextCol];
      if (nextIndex === TRANSPARENT_INDEX || nextIndex === targetPaletteIndex) continue;
      neighborCounts.set(nextIndex, (neighborCounts.get(nextIndex) ?? 0) + 1);
    }
  }

  if (neighborCounts.size > 0) {
    return [...neighborCounts.keys()].sort((left, right) => {
      const neighborDelta = (neighborCounts.get(right) ?? 0) - (neighborCounts.get(left) ?? 0);
      if (neighborDelta !== 0) return neighborDelta;
      return colorDistance(result, targetPaletteIndex, left) - colorDistance(result, targetPaletteIndex, right);
    })[0];
  }

  return result.stats
    .filter((item) => item.paletteIndex !== targetPaletteIndex)
    .sort((left, right) => {
      const countDelta = right.count - left.count;
      if (countDelta !== 0) return countDelta;
      return colorDistance(result, targetPaletteIndex, left.paletteIndex) - colorDistance(result, targetPaletteIndex, right.paletteIndex);
    })[0]?.paletteIndex ?? targetPaletteIndex;
}
function colorDistance(result: RenderState, leftIndex: number, rightIndex: number): number {
  const left = result.paletteRgb[leftIndex];
  const right = result.paletteRgb[rightIndex];
  if (!left || !right) return Number.MAX_SAFE_INTEGER;
  const red = left[0] - right[0];
  const green = left[1] - right[1];
  const blue = left[2] - right[2];
  return (red * red) + (green * green) + (blue * blue);
}
function pickColorFromCell(row: number, col: number): void { if (!latestResult) return; const paletteIndex = latestResult.cellIndices[(row * latestResult.width) + col]; if (paletteIndex === TRANSPARENT_INDEX) return; selectedPaletteIndex = paletteIndex; if (isCompactTouchUi()) activeEditTool = "paint"; syncEditorUi(); renderEditorPalette(); renderStats(latestResult); }
function paintCell(row: number, col: number): void {
  if (!latestResult || selectedPaletteIndex === null) return;
  const cellIndex = (row * latestResult.width) + col;
  if (cellIndex === lastPaintedCell) return;
  lastPaintedCell = cellIndex;
  const previous = latestResult.cellIndices[cellIndex];
  if (previous === selectedPaletteIndex) return;
  if (pendingPatch && !pendingPatch.before.has(cellIndex)) {
    pendingPatch.before.set(cellIndex, previous);
  }
  if (pendingPatch) {
    pendingPatch.after.set(cellIndex, selectedPaletteIndex);
  }
  latestResult.cellIndices[cellIndex] = selectedPaletteIndex;
  scheduleResultRefresh();
}
function scheduleResultRefresh(): void {
  if (renderFrame) return;
  renderFrame = window.requestAnimationFrame(() => {
    renderFrame = 0;
    if (!latestResult) return;
    rebuildDerivedState(latestResult);
    renderMeta(latestResult);
    renderStats(latestResult);
    renderEditorPalette();
    syncEditorUi();
    renderActiveCanvas();
    renderSelectionPopup();
  });
}
function getPaletteEntry(result: RenderState, row: number, col: number): PaletteEntry | null { const index = result.cellIndices[(row * result.width) + col]; return index === TRANSPARENT_INDEX ? null : result.paletteEntries[index] ?? null; }
function shouldDrawCoordinate(index: number, total: number, sectionSize: number): boolean { return index === 0 || index === total - 1 || ((index + 1) % sectionSize === 0); }
function getContrastText(hex: string): string { const rgb = hexToRgb(hex); if (!rgb) return "#1f2937"; const luma = ((0.2126 * rgb[0]) + (0.7152 * rgb[1]) + (0.0722 * rgb[2])) / 255; return luma > 0.62 ? "#1f2937" : "#ffffff"; }
function describeCleanupStrength(value: number): string { if (value <= 10) return "几乎不处理"; if (value <= 30) return "轻度去杂色"; if (value <= 55) return "自然清理，尽量保留轮廓细节"; if (value <= 80) return "中等清理，让底稿更干净"; return "强力清理，适合复杂照片"; }
function describeMergeStrength(value: number): string { if (value <= 10) return "几乎不合并，尽量保留原始颜色层"; if (value <= 30) return "轻度合并，只收掉很接近的零散色"; if (value <= 55) return "平衡模式，优先合并低频近似色"; if (value <= 80) return "明显收色，让底稿更干净好做"; return "强力合并，适合颜色特别杂的复杂照片"; }
function hexToRgb(hex: string): [number, number, number] | null { const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim()); if (!match) return null; return [Number.parseInt(match[1].slice(0, 2), 16), Number.parseInt(match[1].slice(2, 4), 16), Number.parseInt(match[1].slice(4, 6), 16)]; }
function updateActionState(): void { processButton.disabled = !(paletteReady && currentFile); }
function setStatus(message: string, isError: boolean): void { statusNode.textContent = message; statusNode.classList.toggle("error", isError); }
function syncMobileToolButtons(): void {
  mobileTools.querySelectorAll<HTMLElement>("[data-edit-tool]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.editTool === activeEditTool);
  });
  mobilePaletteToggle.classList.toggle("is-active", mobilePaletteVisible);
  mobilePaletteToggle.textContent = mobilePaletteVisible ? "收起色盘" : "调色盘";
}
function isCompactTouchUi(): boolean {
  return window.matchMedia("(max-width: 860px)").matches;
}
function isTouchEditingPointer(event: PointerEvent): boolean {
  return isCompactTouchUi() && event.pointerType !== "mouse";
}
function makeTag(content: string): string { return `<span class="tag">${content}</span>`; }
function revokeSourceUrl(): void { if (!sourceUrl) return; URL.revokeObjectURL(sourceUrl); sourceUrl = null; }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;"); }
