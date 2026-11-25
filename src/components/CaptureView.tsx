import { useCallback, useEffect, useRef, useState } from "react";
import { invokeCommand, waitForTauriRuntime } from "../lib/tauri";
import type {
  CaptureRect,
  CaptureTranslatePayload,
  CaptureViewPayload,
  CaptureWindowInfo,
} from "../types/translator";

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function CaptureView() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bootStartedAtRef = useRef<number>(performance.now());
  const timelineSeqRef = useRef<number>(0);
  const mouseDownRef = useRef<boolean>(false);
  const hasDraggedRef = useRef<boolean>(false);
  const dragStartRef = useRef<Point | null>(null);
  const hoveredWindowAtDownRef = useRef<CaptureWindowInfo | null>(null);
  const selectionImageRef = useRef<CaptureRect | null>(null);

  const [payload, setPayload] = useState<CaptureViewPayload | null>(null);
  const [hoveredWindow, setHoveredWindow] = useState<CaptureWindowInfo | null>(null);
  const [selectionCss, setSelectionCss] = useState<CssRect | null>(null);
  const [loading, setLoading] = useState(false);
  const [resultImageBase64, setResultImageBase64] = useState("");
  const [showResult, setShowResult] = useState(true);
  const [error, setError] = useState("");
  const [fatalError, setFatalError] = useState("");
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

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

  const pointerWithinSelection = useCallback(
    (clientX: number, clientY: number) => {
      if (!selectionCss) return false;
      const p = pointFromEvent(clientX, clientY);
      return (
        p.x >= selectionCss.x &&
        p.x <= selectionCss.x + selectionCss.width &&
        p.y >= selectionCss.y &&
        p.y <= selectionCss.y + selectionCss.height
      );
    },
    [pointFromEvent, selectionCss],
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

  const submitSelectionRect = useCallback(
    async (rect: CaptureRect) => {
      if (!payload) return;
      if (rect.width <= 4 || rect.height <= 4) {
        selectionImageRef.current = null;
        setSelectionCss(null);
        return;
      }

      selectionImageRef.current = rect;
      setSelectionCss(imageRectToCssRect(rect, payload));
      setHoveredWindow(null);
      setLoading(true);
      setResultImageBase64("");
      setError("");

      try {
        const result = await invokeCommand<CaptureTranslatePayload>("submit_capture_selection", {
          selection: rect,
        });
        selectionImageRef.current = result.selection;
        setSelectionCss(imageRectToCssRect(result.selection, payload));
        setResultImageBase64(result.imageBase64);
        setShowResult(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [imageRectToCssRect, payload],
  );

  const submitSelection = useCallback(
    async (rectCss: CssRect) => {
      if (!payload) return;
      const rect = cssRectToImageRect(rectCss, payload);
      await submitSelectionRect(rect);
    },
    [cssRectToImageRect, payload, submitSelectionRect],
  );

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
        void cancelCapture();
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
  }, [cancelCapture, imageRectToCssRect, payload]);

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

  let hintText = "正在准备截图… · Esc/右键取消";
  if (payload) {
    if (resultImageBase64) {
      hintText = "区域内右键切换原文/译文 · 拖拽或点击其他区域重选 · Esc/右键取消";
    } else if (loading) {
      hintText = payload.copyTextMode ? "正在识别文字…" : "正在翻译…";
    } else if ((payload.windows?.length ?? 0) > 0) {
      hintText = "悬停点击自动框选软件窗口 · 拖拽自定义区域 · Esc/右键取消";
    } else {
      hintText = "拖拽选择区域 · Esc/右键取消";
    }
  }

  return (
    <div
      ref={rootRef}
      id="capture-root"
      onContextMenu={(e) => {
        e.preventDefault();
        if (resultImageBase64 && pointerWithinSelection(e.clientX, e.clientY)) {
          setShowResult((prev) => !prev);
          return;
        }
        void cancelCapture();
      }}
      onMouseDown={(e) => {
        if (e.button !== 0 || loading || !payload) return;
        const start = pointFromEvent(e.clientX, e.clientY);
        mouseDownRef.current = true;
        hasDraggedRef.current = false;
        dragStartRef.current = start;
        hoveredWindowAtDownRef.current = resultImageBase64
          ? null
          : hoveredWindow ?? findWindowAtPoint(e.clientX, e.clientY, payload);
      }}
      onMouseMove={(e) => {
        if (!payload || loading) return;
        if (mouseDownRef.current && dragStartRef.current) {
          const current = pointFromEvent(e.clientX, e.clientY);
          const dist = Math.hypot(
            current.x - dragStartRef.current.x,
            current.y - dragStartRef.current.y,
          );
          if (!hasDraggedRef.current && dist >= 5) {
            hasDraggedRef.current = true;
            selectionImageRef.current = null;
            setHoveredWindow(null);
            setResultImageBase64("");
            setError("");
          }
          if (hasDraggedRef.current) {
            setSelectionCss(normalizeRect(dragStartRef.current, current, getRootRect()));
          }
          return;
        }

        if (!resultImageBase64 && !selectionCss) {
          setHoveredWindow(findWindowAtPoint(e.clientX, e.clientY, payload));
        }
      }}
      onMouseUp={(e) => {
        if (e.button === 2) {
          if (resultImageBase64 && pointerWithinSelection(e.clientX, e.clientY)) {
            return;
          }
          void cancelCapture();
          return;
        }
        if (e.button !== 0 || !mouseDownRef.current || !dragStartRef.current || !payload) return;

        const didDrag = hasDraggedRef.current;
        const start = dragStartRef.current;
        const winAtDown = hoveredWindowAtDownRef.current;

        mouseDownRef.current = false;
        hasDraggedRef.current = false;
        dragStartRef.current = null;
        hoveredWindowAtDownRef.current = null;

        if (didDrag) {
          const end = pointFromEvent(e.clientX, e.clientY);
          const rectCss = normalizeRect(start, end, getRootRect());
          void submitSelection(rectCss);
          return;
        }

        if (resultImageBase64) {
          if (!pointerWithinSelection(e.clientX, e.clientY)) {
            selectionImageRef.current = null;
            setSelectionCss(null);
            setResultImageBase64("");
            setError("");
            setHoveredWindow(findWindowAtPoint(e.clientX, e.clientY, payload));
          }
          return;
        }

        if (winAtDown) {
          void submitSelectionRect(winAtDown.rect);
          return;
        }

        selectionImageRef.current = null;
        setSelectionCss(null);
        setError("");
        setHoveredWindow(findWindowAtPoint(e.clientX, e.clientY, payload));
      }}
      className="fixed inset-0 cursor-crosshair overflow-hidden"
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
            className="pointer-events-none absolute overflow-hidden"
          >
            {previewSrc && !(resultImageBase64 && showResult) && (
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

      <div
        id="capture-hint"
        className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom,0px)+72px)] left-1/2 -translate-x-1/2 rounded-full bg-gray-900/80 px-3.5 py-2.5 text-[13px] leading-none text-gray-50 backdrop-blur-md"
      >
        {hintText}
      </div>

      {error && (
        <div
          id="capture-error"
          className="pointer-events-none fixed bottom-[22px] left-1/2 -translate-x-1/2 rounded-full bg-red-700/90 px-3.5 py-2.5 text-[13px] leading-none text-gray-50 backdrop-blur-md"
        >
          {error}
        </div>
      )}
    </div>
  );
}
