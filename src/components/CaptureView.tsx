import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Languages,
  Layers,
  Monitor,
  Scan,
  ScanText,
  X,
} from "lucide-react";
import { invokeCommand, waitForTauriRuntime } from "../lib/tauri";
import type {
  CaptureRect,
  CaptureTranslatePayload,
  CaptureViewPayload,
  CaptureWindowInfo,
  OverlayRegion,
} from "../types/translator";
import { RegionOverlayLayer } from "./RegionOverlayLayer";

interface Point {
  x: number;
  y: number;
}

interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type InteractionMode =
  | { kind: "none" }
  | { kind: "new"; start: Point; hoveredAtDown: CaptureWindowInfo | null; dragged: boolean }
  | { kind: "move"; start: Point; origin: CssRect }
  | { kind: "resize"; handle: ResizeHandle; start: Point; origin: CssRect };

const HANDLE_CURSORS: Record<ResizeHandle, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeRect(a: Point, b: Point, bounds: DOMRect): CssRect {
  const x1 = clamp(Math.min(a.x, b.x), 0, bounds.width);
  const y1 = clamp(Math.min(a.y, b.y), 0, bounds.height);
  const x2 = clamp(Math.max(a.x, b.x), 0, bounds.width);
  const y2 = clamp(Math.max(a.y, b.y), 0, bounds.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function applyResize(
  origin: CssRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  bounds: DOMRect,
): CssRect {
  const minSize = 12;
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.width;
  let bottom = origin.y + origin.height;

  if (handle.includes("w")) {
    left = clamp(origin.x + dx, 0, right - minSize);
  }
  if (handle.includes("e")) {
    right = clamp(origin.x + origin.width + dx, left + minSize, bounds.width);
  }
  if (handle.includes("n")) {
    top = clamp(origin.y + dy, 0, bottom - minSize);
  }
  if (handle.includes("s")) {
    bottom = clamp(origin.y + origin.height + dy, top + minSize, bounds.height);
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function CaptureView() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bootStartedAtRef = useRef<number>(performance.now());
  const timelineSeqRef = useRef<number>(0);
  const interactionRef = useRef<InteractionMode>({ kind: "none" });
  const selectionImageRef = useRef<CaptureRect | null>(null);

  const [payload, setPayload] = useState<CaptureViewPayload | null>(null);
  const [hoveredWindow, setHoveredWindow] = useState<CaptureWindowInfo | null>(null);
  const [selectionCss, setSelectionCss] = useState<CssRect | null>(null);
  const [loading, setLoading] = useState(false);
  const [resultImageBase64, setResultImageBase64] = useState("");
  const [resultRegions, setResultRegions] = useState<OverlayRegion[]>([]);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [ocrCopied, setOcrCopied] = useState(false);
  const [resultSourceSize, setResultSourceSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });
  const [showResult, setShowResult] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fatalError, setFatalError] = useState("");
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  const hasResult = Boolean(resultImageBase64) || resultRegions.length > 0;

  const debugTimeline = useCallback(async (message: string) => {
    const elapsed = (performance.now() - bootStartedAtRef.current).toFixed(1);
    const seq = ++timelineSeqRef.current;
    try {
      await invokeCommand("capture_debug_log", {
        message: `#${seq} +${elapsed}ms ${message}`,
      });
    } catch {
      // Ignore logging errors during boot/teardown.
    }
  }, []);

  const getRootRect = useCallback(() => {
    return (
      rootRef.current?.getBoundingClientRect() ||
      new DOMRect(0, 0, window.innerWidth, window.innerHeight)
    );
  }, []);

  const cssRectToImageRect = useCallback(
    (rect: CssRect, activePayload: CaptureViewPayload): CaptureRect => {
      const bounds = getRootRect();
      return {
        x: Math.round((rect.x * activePayload.imageWidth) / bounds.width),
        y: Math.round((rect.y * activePayload.imageHeight) / bounds.height),
        width: Math.round((rect.width * activePayload.imageWidth) / bounds.width),
        height: Math.round((rect.height * activePayload.imageHeight) / bounds.height),
      };
    },
    [getRootRect],
  );

  const imageRectToCssRect = useCallback(
    (rect: CaptureRect, activePayload: CaptureViewPayload): CssRect => {
      const bounds = getRootRect();
      return {
        x: (rect.x * bounds.width) / activePayload.imageWidth,
        y: (rect.y * bounds.height) / activePayload.imageHeight,
        width: (rect.width * bounds.width) / activePayload.imageWidth,
        height: (rect.height * bounds.height) / activePayload.imageHeight,
      };
    },
    [getRootRect],
  );

  const cancelCapture = useCallback(async () => {
    try {
      await invokeCommand("cancel_capture");
    } catch (err) {
      setFatalError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const pointFromEvent = useCallback(
    (clientX: number, clientY: number): Point => {
      const bounds = getRootRect();
      return {
        x: clientX - bounds.left,
        y: clientY - bounds.top,
      };
    },
    [getRootRect],
  );

  const pointerWithinRect = useCallback(
    (clientX: number, clientY: number, rect: CssRect | null) => {
      if (!rect) return false;
      const p = pointFromEvent(clientX, clientY);
      return (
        p.x >= rect.x &&
        p.x <= rect.x + rect.width &&
        p.y >= rect.y &&
        p.y <= rect.y + rect.height
      );
    },
    [pointFromEvent],
  );

  const findWindowAtPoint = useCallback(
    (clientX: number, clientY: number, activePayload: CaptureViewPayload): CaptureWindowInfo | null => {
      const windows = activePayload.windows;
      if (!windows || windows.length === 0) return null;
      const bounds = getRootRect();
      if (bounds.width <= 0 || bounds.height <= 0) return null;
      const p = pointFromEvent(clientX, clientY);
      const ix = (p.x * activePayload.imageWidth) / bounds.width;
      const iy = (p.y * activePayload.imageHeight) / bounds.height;
      return (
        windows.find(
          (w) =>
            ix >= w.rect.x &&
            ix <= w.rect.x + w.rect.width &&
            iy >= w.rect.y &&
            iy <= w.rect.y + w.rect.height,
        ) ?? null
      );
    },
    [getRootRect, pointFromEvent],
  );

  const runSelectionAction = useCallback(
    async (action: "translate" | "copy_text") => {
      if (!payload || !selectionCss) return;
      const rect = selectionImageRef.current ?? cssRectToImageRect(selectionCss, payload);
      if (rect.width <= 4 || rect.height <= 4) {
        return;
      }

      selectionImageRef.current = rect;
      setHoveredWindow(null);
      setLoading(true);
      setResultImageBase64("");
      setResultRegions([]);
      setOcrText(null);
      setOcrCopied(false);
      setError("");
      setNotice("");

      try {
        const result = await invokeCommand<CaptureTranslatePayload>("submit_capture_selection", {
          selection: rect,
          mode: action,
        });
        if (action === "copy_text") {
          setOcrText(result.recognizedText ?? "");
          setOcrCopied(false);
          return;
        }
        selectionImageRef.current = result.selection;
        setSelectionCss(imageRectToCssRect(result.selection, payload));
        setResultImageBase64(result.imageBase64);
        const regions = result.regions ?? [];
        setResultRegions(regions);
        setResultSourceSize({
          w: result.imageWidth || result.selection.width,
          h: result.imageHeight || result.selection.height,
        });
        setShowResult(true);
        if (!result.imageBase64 && regions.length === 0) {
          setNotice("未识别到文字，可调整选区或切换 OCR 引擎后重试");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [cssRectToImageRect, imageRectToCssRect, payload, selectionCss],
  );

  const runLiveAction = useCallback(
    async (liveMode: "in_place" | "mirror") => {
      if (!payload || !selectionCss) return;
      const rect = selectionImageRef.current ?? cssRectToImageRect(selectionCss, payload);
      if (rect.width <= 4 || rect.height <= 4) {
        return;
      }
      setError("");
      setNotice("");
      try {
        await invokeCommand("start_live_session", {
          selection: rect,
          mode: liveMode,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(
          msg.includes("Command") || msg.includes("not found")
            ? "实时翻译模式将在下一阶段接入，当前请先使用「选区翻译」或「识别文字」"
            : msg,
        );
      }
    },
    [cssRectToImageRect, payload, selectionCss],
  );

  const handleCopyTranslated = useCallback(async () => {
    const text = resultRegions
      .map((r) => r.translated || r.source)
      .filter(Boolean)
      .join("\n");
    if (!text) return;
    try {
      await invokeCommand("copy_capture_text", { text });
      setNotice("已复制译文到剪贴板");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [resultRegions]);

  const handleCopyOcrText = useCallback(async () => {
    const text = (ocrText ?? "").trim();
    if (!text) return;
    try {
      await invokeCommand("copy_capture_text", { text });
      setOcrCopied(true);
      setNotice("已复制识别文字");
      setTimeout(() => setOcrCopied(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ocrText]);

  const resetToHover = useCallback(() => {
    selectionImageRef.current = null;
    setSelectionCss(null);
    setResultImageBase64("");
    setResultRegions([]);
    setOcrText(null);
    setOcrCopied(false);
    setError("");
    setNotice("");
  }, []);

  useEffect(() => {
    document.body.dataset.mode = "capture";
    let cancelled = false;

    const boot = async () => {
      try {
        await waitForTauriRuntime();
        await debugTimeline("tauri api ready");
        const payloadStartedAt = performance.now();

        for (let i = 0; i < 200; i++) {
          if (cancelled) return;
          try {
            const loaded = await invokeCommand<CaptureViewPayload>("load_capture_payload");
            if (cancelled) return;
            void debugTimeline(
              `load_capture_payload success attempts=${i + 1} wait=${(performance.now() - payloadStartedAt).toFixed(1)}ms`,
            );
            setPayload(loaded);
            void debugTimeline("capture payload applied");
            return;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (
              !message.includes("capture preview not ready") &&
              !message.includes("capture payload missing")
            ) {
              throw err;
            }
            await delay(25);
          }
        }
        throw new Error("capture preview timed out");
      } catch (err) {
        if (!cancelled) {
          setFatalError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, [debugTimeline]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (hasResult) {
          resetToHover();
        } else if (selectionCss) {
          resetToHover();
        } else {
          void cancelCapture();
        }
      } else if (event.key === "Enter" && selectionCss && !hasResult && !loading) {
        event.preventDefault();
        void runSelectionAction(payload?.copyTextMode ? "copy_text" : "translate");
      }
    };

    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      if (selectionImageRef.current && payload) {
        setSelectionCss(imageRectToCssRect(selectionImageRef.current, payload));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [
    cancelCapture,
    hasResult,
    imageRectToCssRect,
    loading,
    payload,
    resetToHover,
    runSelectionAction,
    selectionCss,
  ]);

  if (fatalError) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-[#111827] p-6 text-center text-sm text-[#F9FAFB]">
        {fatalError}
      </div>
    );
  }

  const previewSrc = payload
    ? `data:${payload.imageMime};base64,${payload.imageBase64}`
    : undefined;

  const hoveredCssRect =
    !selectionCss && hoveredWindow && payload
      ? imageRectToCssRect(hoveredWindow.rect, payload)
      : null;
  const activeBoxCss = selectionCss ?? hoveredCssRect;
  const activeBoxImageRect = selectionCss
    ? selectionImageRef.current ??
      (payload ? cssRectToImageRect(selectionCss, payload) : null)
    : hoveredWindow?.rect ?? null;
  const activeBoxLabel = selectionCss
    ? activeBoxImageRect
      ? `${Math.round(activeBoxImageRect.width)} × ${Math.round(activeBoxImageRect.height)}`
      : ""
    : hoveredWindow
      ? `${hoveredWindow.ownerName || hoveredWindow.title || "窗口"} · ${hoveredWindow.rect.width} × ${hoveredWindow.rect.height}`
      : "";

  const isLockedSelection = Boolean(selectionCss) && !loading && interactionRef.current.kind === "none";

  let hintText = "正在准备截图… · Esc/右键取消";
  if (payload) {
    if (hasResult) {
      hintText = "区域内右键切换原文/译文 · Esc 重新选区 · 右键空白处退出";
    } else if (loading) {
      hintText = "正在处理…";
    } else if (selectionCss) {
      hintText = "可拖动边框微调区域 · 点击下方工具栏选择操作 · Esc 重选";
    } else if ((payload.windows?.length ?? 0) > 0) {
      hintText = "悬停点击锁定软件窗口 · 或按住拖拽自定义区域 · Esc/右键取消";
    } else {
      hintText = "拖拽选择区域 · Esc/右键取消";
    }
  }

  // Compute toolbar position anchored near bottom-right of selectionCss.
  const toolbarStyle = (() => {
    if (!selectionCss) return undefined;
    const estToolbarH = 42;
    const margin = 10;
    const belowY = selectionCss.y + selectionCss.height + margin;
    const aboveY = selectionCss.y - estToolbarH - margin;
    let top: number;
    if (belowY + estToolbarH <= viewport.height - 8) {
      top = belowY;
    } else if (aboveY >= 8) {
      top = aboveY;
    } else {
      top = Math.max(8, selectionCss.y + selectionCss.height - estToolbarH - 12);
    }
    const rightAlignedLeft = selectionCss.x + selectionCss.width;
    return {
      top: `${top}px`,
      right: `${Math.max(12, viewport.width - rightAlignedLeft)}px`,
    };
  })();

  return (
    <div
      ref={rootRef}
      id="capture-root"
      onContextMenu={(e) => {
        if ((e.target as HTMLElement | null)?.closest("[data-capture-modal]")) {
          return;
        }
        e.preventDefault();
        if (hasResult && pointerWithinRect(e.clientX, e.clientY, selectionCss)) {
          setShowResult((prev) => !prev);
          return;
        }
        if (selectionCss && !hasResult) {
          resetToHover();
          return;
        }
        void cancelCapture();
      }}
      onMouseDown={(e) => {
        if (e.button !== 0 || loading || !payload) return;
        // Ignore clicks on the floating toolbar or OCR result modal.
        if ((e.target as HTMLElement | null)?.closest("[data-capture-toolbar], [data-capture-modal]")) {
          return;
        }

        const start = pointFromEvent(e.clientX, e.clientY);

        if (selectionCss && !hasResult && pointerWithinRect(e.clientX, e.clientY, selectionCss)) {
          interactionRef.current = {
            kind: "move",
            start,
            origin: selectionCss,
          };
          return;
        }

        interactionRef.current = {
          kind: "new",
          start,
          hoveredAtDown: selectionCss
            ? null
            : hoveredWindow ?? findWindowAtPoint(e.clientX, e.clientY, payload),
          dragged: false,
        };
      }}
      onMouseMove={(e) => {
        if (!payload || loading) return;
        const mode = interactionRef.current;
        const bounds = getRootRect();

        if (mode.kind === "resize") {
          const current = pointFromEvent(e.clientX, e.clientY);
          const next = applyResize(
            mode.origin,
            mode.handle,
            current.x - mode.start.x,
            current.y - mode.start.y,
            bounds,
          );
          selectionImageRef.current = cssRectToImageRect(next, payload);
          setSelectionCss(next);
          return;
        }

        if (mode.kind === "move") {
          const current = pointFromEvent(e.clientX, e.clientY);
          const dx = current.x - mode.start.x;
          const dy = current.y - mode.start.y;
          const next: CssRect = {
            x: clamp(mode.origin.x + dx, 0, Math.max(0, bounds.width - mode.origin.width)),
            y: clamp(mode.origin.y + dy, 0, Math.max(0, bounds.height - mode.origin.height)),
            width: mode.origin.width,
            height: mode.origin.height,
          };
          selectionImageRef.current = cssRectToImageRect(next, payload);
          setSelectionCss(next);
          return;
        }

        if (mode.kind === "new") {
          const current = pointFromEvent(e.clientX, e.clientY);
          const dist = Math.hypot(current.x - mode.start.x, current.y - mode.start.y);
          if (!mode.dragged && dist >= 5) {
            mode.dragged = true;
            selectionImageRef.current = null;
            setHoveredWindow(null);
            setResultImageBase64("");
            setResultRegions([]);
            setError("");
            setNotice("");
          }
          if (mode.dragged) {
            setSelectionCss(normalizeRect(mode.start, current, bounds));
          }
          return;
        }

        if (!hasResult && !selectionCss) {
          setHoveredWindow(findWindowAtPoint(e.clientX, e.clientY, payload));
        }
      }}
      onMouseUp={(e) => {
        if (e.button === 2) {
          return;
        }
        if (e.button !== 0 || !payload) return;
        const mode = interactionRef.current;
        interactionRef.current = { kind: "none" };

        if (mode.kind === "resize" || mode.kind === "move") {
          if (selectionCss) {
            selectionImageRef.current = cssRectToImageRect(selectionCss, payload);
          }
          return;
        }

        if (mode.kind !== "new") return;

        if (mode.dragged) {
          const end = pointFromEvent(e.clientX, e.clientY);
          const rectCss = normalizeRect(mode.start, end, getRootRect());
          if (rectCss.width <= 4 || rectCss.height <= 4) {
            resetToHover();
            return;
          }
          selectionImageRef.current = cssRectToImageRect(rectCss, payload);
          setSelectionCss(rectCss);
          setHoveredWindow(null);
          return;
        }

        // Single click without dragging:
        if (hasResult) {
          if (!pointerWithinRect(e.clientX, e.clientY, selectionCss)) {
            resetToHover();
            setHoveredWindow(findWindowAtPoint(e.clientX, e.clientY, payload));
          }
          return;
        }

        if (selectionCss) {
          if (!pointerWithinRect(e.clientX, e.clientY, selectionCss)) {
            resetToHover();
            setHoveredWindow(findWindowAtPoint(e.clientX, e.clientY, payload));
          }
          return;
        }

        if (mode.hoveredAtDown) {
          selectionImageRef.current = mode.hoveredAtDown.rect;
          setSelectionCss(imageRectToCssRect(mode.hoveredAtDown.rect, payload));
          setHoveredWindow(null);
          setError("");
          setNotice("");
          return;
        }
      }}
      className="fixed inset-0 cursor-crosshair overflow-hidden select-none"
    >
      {previewSrc && (
        <img
          id="capture-screen"
          src={previewSrc}
          alt=""
          onLoad={(e) => {
            const img = e.currentTarget;
            void debugTimeline(
              `screen image load natural=${img.naturalWidth}x${img.naturalHeight}`,
            );
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                void debugTimeline("screen image painted");
              });
            });
          }}
          className="pointer-events-none absolute inset-0 h-full w-full object-fill brightness-[0.55]"
        />
      )}

      {activeBoxCss && (
        <>
          <div
            id="capture-selection"
            style={{
              left: `${activeBoxCss.x}px`,
              top: `${activeBoxCss.y}px`,
              width: `${activeBoxCss.width}px`,
              height: `${activeBoxCss.height}px`,
            }}
            className={`absolute overflow-hidden ${
              isLockedSelection && !hasResult ? "cursor-move" : "pointer-events-none"
            }`}
          >
            {previewSrc && !(hasResult && showResult) && (
              <img
                id="capture-selection-preview"
                src={previewSrc}
                alt=""
                style={{
                  width: `${viewport.width}px`,
                  height: `${viewport.height}px`,
                  transform: `translate(${-activeBoxCss.x}px, ${-activeBoxCss.y}px)`,
                }}
                className="pointer-events-none absolute top-0 left-0 max-w-none"
              />
            )}

            {selectionCss && resultImageBase64 && showResult && (
              <img
                id="capture-selection-result"
                src={`data:image/jpeg;base64,${resultImageBase64}`}
                alt=""
                className="pointer-events-none absolute inset-0 h-full w-full object-fill"
              />
            )}

            {selectionCss && !resultImageBase64 && resultRegions.length > 0 && showResult && (
              <>
                {previewSrc && (
                  <img
                    src={previewSrc}
                    alt=""
                    style={{
                      width: `${viewport.width}px`,
                      height: `${viewport.height}px`,
                      transform: `translate(${-activeBoxCss.x}px, ${-activeBoxCss.y}px)`,
                    }}
                    className="pointer-events-none absolute top-0 left-0 max-w-none"
                  />
                )}
                <RegionOverlayLayer
                  regions={resultRegions}
                  sourceWidth={resultSourceSize.w}
                  sourceHeight={resultSourceSize.h}
                  containerWidth={activeBoxCss.width}
                  containerHeight={activeBoxCss.height}
                />
              </>
            )}

            <div
              className={`pointer-events-none absolute inset-0 border-2 ${
                selectionCss ? "border-[#4A9EFF]" : "border-[#07C160]"
              }`}
            />

            {loading && (
              <div
                id="capture-spinner"
                className="absolute top-1/2 left-1/2 -mt-[22px] -ml-[22px] h-[44px] w-[44px] animate-spin rounded-full border-[3px] border-white/30 border-t-[#4A9EFF]"
              />
            )}
          </div>

          {/* 8 resize handles when selection is locked and awaiting action */}
          {selectionCss && !hasResult && !loading && (
            <div
              style={{
                left: `${selectionCss.x}px`,
                top: `${selectionCss.y}px`,
                width: `${selectionCss.width}px`,
                height: `${selectionCss.height}px`,
              }}
              className="pointer-events-none absolute"
            >
              {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as ResizeHandle[]).map((handle) => {
                const posClass = {
                  nw: "-top-1 -left-1",
                  n: "-top-1 left-1/2 -translate-x-1/2",
                  ne: "-top-1 -right-1",
                  e: "top-1/2 -right-1 -translate-y-1/2",
                  se: "-bottom-1 -right-1",
                  s: "-bottom-1 left-1/2 -translate-x-1/2",
                  sw: "-bottom-1 -left-1",
                  w: "top-1/2 -left-1 -translate-y-1/2",
                }[handle];
                return (
                  <div
                    key={handle}
                    style={{ cursor: HANDLE_CURSORS[handle] }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      if (e.button !== 0 || !selectionCss) return;
                      interactionRef.current = {
                        kind: "resize",
                        handle,
                        start: pointFromEvent(e.clientX, e.clientY),
                        origin: selectionCss,
                      };
                    }}
                    className={`pointer-events-auto absolute h-2.5 w-2.5 rounded-[2px] border border-[#4A9EFF] bg-white shadow ${posClass}`}
                  />
                );
              })}
            </div>
          )}

          {activeBoxLabel && (
            <div
              id="capture-selection-badge"
              style={{
                left: `${Math.max(8, activeBoxCss.x)}px`,
                top: `${
                  activeBoxCss.y >= 34
                    ? activeBoxCss.y - 30
                    : activeBoxCss.y + activeBoxCss.height + 34 <= viewport.height
                      ? activeBoxCss.y + activeBoxCss.height + 8
                      : activeBoxCss.y + 8
                }px`,
              }}
              className="pointer-events-none fixed max-w-[360px] truncate rounded-md bg-gray-900/85 px-2.5 py-1 text-[12px] font-medium leading-none text-gray-50 shadow-sm backdrop-blur-md"
            >
              {activeBoxLabel}
            </div>
          )}
        </>
      )}

      {/* Floating action toolbar after locking a selection */}
      {selectionCss && !loading && ocrText === null && toolbarStyle && (
        <div
          id="capture-toolbar"
          data-capture-toolbar
          style={toolbarStyle}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          className="fixed z-30 flex items-center gap-1 rounded-xl border border-white/15 bg-gray-900/90 px-2 py-1.5 text-xs font-medium text-white shadow-xl backdrop-blur-md"
        >
          {!hasResult ? (
            <>
              <button
                type="button"
                onClick={() => void runSelectionAction("translate")}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[#FFCC00] px-2.5 py-1 font-semibold text-[#111827] transition hover:bg-[#FFD633]"
              >
                <Languages className="h-3.5 w-3.5" aria-hidden="true" />
                <span>选区翻译</span>
              </button>
              <button
                type="button"
                onClick={() => void runSelectionAction("copy_text")}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-gray-100 transition hover:bg-white/10"
              >
                <ScanText className="h-3.5 w-3.5" aria-hidden="true" />
                <span>识别文字</span>
              </button>
              <span className="mx-0.5 h-3.5 w-px bg-white/15" />
              <button
                type="button"
                onClick={() => void runLiveAction("in_place")}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-gray-100 transition hover:bg-white/10"
              >
                <Layers className="h-3.5 w-3.5" aria-hidden="true" />
                <span>原位实时</span>
              </button>
              <button
                type="button"
                onClick={() => void runLiveAction("mirror")}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-gray-100 transition hover:bg-white/10"
              >
                <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
                <span>副屏实时</span>
              </button>
              <span className="mx-0.5 h-3.5 w-px bg-white/15" />
              <button
                type="button"
                onClick={() => void cancelCapture()}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-gray-400 transition hover:bg-white/10 hover:text-white"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                <span>取消</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setShowResult((prev) => !prev)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-gray-100 transition hover:bg-white/10"
              >
                {showResult ? (
                  <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span>{showResult ? "看原文" : "看译文"}</span>
              </button>
              {resultRegions.length > 0 && (
                <button
                  type="button"
                  onClick={() => void handleCopyTranslated()}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-gray-100 transition hover:bg-white/10"
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>复制译文</span>
                </button>
              )}
              <button
                type="button"
                onClick={resetToHover}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-gray-100 transition hover:bg-white/10"
              >
                <Scan className="h-3.5 w-3.5" aria-hidden="true" />
                <span>重选区域</span>
              </button>
              <button
                type="button"
                onClick={() => void cancelCapture()}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[#FFCC00] px-2.5 py-1 font-semibold text-[#111827] transition hover:bg-[#FFD633]"
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                <span>完成</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* OCR recognized text popup modal */}
      {ocrText !== null && (
        <div
          data-capture-modal
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px] select-text cursor-default"
        >
          <div className="flex w-full max-w-[460px] flex-col overflow-hidden rounded-2xl border border-white/15 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#111827]">
                <ScanText className="h-4 w-4 text-amber-500" aria-hidden="true" />
                <span>识别文字</span>
                {ocrText.trim() && (
                  <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-normal text-[#6B7280]">
                    {ocrText.trim().length} 字
                  </span>
                )}
              </div>
              <button
                type="button"
                title="关闭"
                onClick={() => void cancelCapture()}
                className="inline-flex cursor-pointer items-center justify-center rounded-lg p-1 text-[#6B7280] transition hover:bg-zinc-100 hover:text-[#111827]"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="p-4">
              <textarea
                autoFocus
                rows={7}
                value={ocrText}
                onChange={(e) => {
                  setOcrText(e.target.value);
                  setOcrCopied(false);
                }}
                placeholder="未识别到文字，可点击下方重选区域后重试"
                className="w-full resize-y rounded-xl border border-zinc-200 bg-[#F9FAFB] p-3 text-[13px] leading-relaxed text-[#111827] outline-none transition focus:border-[#FFCC00] focus:bg-white"
              />
            </div>

            <div className="flex items-center justify-between border-t border-zinc-100 bg-zinc-50/70 px-4 py-2.5">
              <button
                type="button"
                onClick={resetToHover}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[#6B7280] transition hover:bg-zinc-200/70 hover:text-[#111827]"
              >
                <Scan className="h-3.5 w-3.5" aria-hidden="true" />
                <span>重选区域</span>
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!ocrText.trim()}
                  onClick={() => void handleCopyOcrText()}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    ocrCopied
                      ? "bg-emerald-500 text-white"
                      : "bg-[#FFCC00] text-[#111827] hover:bg-[#FFD633]"
                  }`}
                >
                  {ocrCopied ? (
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  <span>{ocrCopied ? "已复制" : "复制文字"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void cancelCapture()}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-[#111827] transition hover:bg-zinc-100"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>关闭</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div
        id="capture-hint"
        className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom,0px)+18px)] left-1/2 -translate-x-1/2 rounded-full bg-gray-900/80 px-3.5 py-2 text-[12px] leading-none text-gray-200 backdrop-blur-md"
      >
        {hintText}
      </div>

      {(error || notice) && (
        <div
          id="capture-feedback"
          className={`pointer-events-none fixed bottom-[56px] left-1/2 max-w-[80vw] -translate-x-1/2 truncate rounded-full px-3.5 py-2 text-[12px] leading-none text-gray-50 backdrop-blur-md ${
            error ? "bg-red-700/90" : "bg-gray-900/85"
          }`}
        >
          {error || notice}
        </div>
      )}
    </div>
  );
}
