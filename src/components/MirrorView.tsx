import { useCallback, useEffect, useRef, useState } from "react";
import { invokeCommand, listenEvent, waitForTauriRuntime } from "../lib/tauri";
import type {
  LiveFrameReadyEvent,
  LiveRegionsEvent,
  LiveSessionStatus,
  OverlayRegion,
} from "../types/translator";
import { RegionOverlayLayer } from "./RegionOverlayLayer";

export function MirrorView() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameUrlRef = useRef<string>("");
  const fetchingSeqRef = useRef<boolean>(false);
  const pendingSeqRef = useRef<number | null>(null);

  const [status, setStatus] = useState<LiveSessionStatus | null>(null);
  const [regions, setRegions] = useState<OverlayRegion[]>([]);
  const [showOverlay, setShowOverlay] = useState(true);
  const [metrics, setMetrics] = useState<{ ocrMs: number; translateMs: number } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>({
    width: 800,
    height: 500,
  });

  const drawFrameSeq = useCallback(async (seq: number) => {
    const baseUrl = frameUrlRef.current;
    if (!baseUrl) return;
    if (fetchingSeqRef.current) {
      pendingSeqRef.current = seq;
      return;
    }

    fetchingSeqRef.current = true;
    try {
      const resp = await fetch(`${baseUrl}&seq=${seq}`, { cache: "no-store" });
      if (resp.status === 200) {
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = canvasRef.current;
        if (canvas) {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          const ctx = canvas.getContext("2d");
          ctx?.drawImage(bitmap, 0, 0);
        }
        bitmap.close();
      }
    } catch {
      // Ignore transient frame fetch errors when pausing or shutting down.
    } finally {
      fetchingSeqRef.current = false;
      const queued = pendingSeqRef.current;
      pendingSeqRef.current = null;
      if (queued !== null && queued !== seq) {
        void drawFrameSeq(queued);
      }
    }
  }, []);

  useEffect(() => {
    document.body.dataset.mode = "mirror";
    let unlistenFrame: (() => void) | undefined;
    let unlistenRegions: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;

    const boot = async () => {
      try {
        await waitForTauriRuntime();
        const loaded = await invokeCommand<LiveSessionStatus>("load_live_status");
        setStatus(loaded);
        setRegions(loaded.regions || []);
        setError(loaded.lastError || "");
        frameUrlRef.current = loaded.frameUrl;
        if (loaded.frameSeq > 0) {
          void drawFrameSeq(loaded.frameSeq);
        }

        unlistenFrame = await listenEvent<LiveFrameReadyEvent>("live:frame", (event) => {
          if (event.payload?.seq) {
            void drawFrameSeq(event.payload.seq);
          }
        });

        unlistenRegions = await listenEvent<LiveRegionsEvent>("live:regions", (event) => {
          const payload = event.payload;
          if (!payload) return;
          setRegions(payload.regions || []);
          setMetrics({ ocrMs: payload.ocrMs, translateMs: payload.translateMs });
          setError("");
        });

        unlistenStatus = await listenEvent<LiveSessionStatus>("live:status", (event) => {
          if (!event.payload) return;
          setStatus(event.payload);
          frameUrlRef.current = event.payload.frameUrl;
        });

        unlistenError = await listenEvent<{ message?: string }>("live:error", (event) => {
          if (event.payload?.message) {
            setError(event.payload.message);
          }
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    void boot();
    return () => {
      unlistenFrame?.();
      unlistenRegions?.();
      unlistenStatus?.();
      unlistenError?.();
    };
  }, [drawFrameSeq]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setStageSize({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const srcW = Math.max(1, status?.sourceWidth || status?.selection.width || 1280);
  const srcH = Math.max(1, status?.sourceHeight || status?.selection.height || 720);
  const fitScale = Math.min(stageSize.width / srcW, stageSize.height / srcH);
  const boxW = Math.max(1, Math.floor(srcW * fitScale));
  const boxH = Math.max(1, Math.floor(srcH * fitScale));

  const updateOptions = async (patch: Record<string, unknown>) => {
    try {
      const next = await invokeCommand<LiveSessionStatus>("update_live_options", patch);
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTogglePause = async () => {
    if (!status) return;
    try {
      const next = await invokeCommand<LiveSessionStatus>("pause_live_session", {
        paused: !status.paused,
      });
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyRegions = async () => {
    const text = regions
      .map((r) => r.translated || r.source)
      .filter(Boolean)
      .join("\n");
    if (!text) return;
    try {
      await invokeCommand("copy_capture_text", { text });
      setNotice("已复制当前译文");
      setTimeout(() => setNotice(""), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-[#0B0F17] text-gray-100 select-none">
      {/* Control Toolbar */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#111827]/95 px-3 py-2 text-xs">
        <div className="flex items-center gap-2.5">
          <span className="flex items-center gap-1.5 font-semibold text-white">
            <span
              className={`h-2 w-2 rounded-full ${
                status?.paused ? "bg-amber-400" : "bg-emerald-400 animate-pulse"
              }`}
            />
            {status?.paused ? "已暂停" : "实时翻译副屏"}
          </span>
          {metrics && (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-zinc-400">
              OCR {metrics.ocrMs}ms · 译 {metrics.translateMs}ms
            </span>
          )}
          {notice && (
            <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[11px] text-emerald-300">
              {notice}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => void handleTogglePause()}
            className="cursor-pointer rounded-md bg-white/10 px-2.5 py-1 font-medium text-white transition hover:bg-white/20"
          >
            {status?.paused ? "继续" : "暂停"}
          </button>

          <button
            type="button"
            onClick={() =>
              void updateOptions({ keyframeOnly: !(status?.keyframeOnly ?? true) })
            }
            title="智能关键帧仅在画面变化时同步底图，省电清晰；流畅模式持续刷新画面"
            className="cursor-pointer rounded-md bg-white/10 px-2.5 py-1 text-zinc-200 transition hover:bg-white/20"
          >
            {status?.keyframeOnly ? "智能关键帧" : "流畅录屏"}
          </button>

          <button
            type="button"
            onClick={() =>
              void updateOptions({ subtitleBarMode: !(status?.subtitleBarMode ?? false) })
            }
            className="cursor-pointer rounded-md bg-white/10 px-2.5 py-1 text-zinc-200 transition hover:bg-white/20"
          >
            {status?.subtitleBarMode ? "字幕条模式" : "原位块模式"}
          </button>

          <button
            type="button"
            onClick={() => void updateOptions({ bilingual: !(status?.bilingual ?? false) })}
            className={`cursor-pointer rounded-md px-2.5 py-1 transition ${
              status?.bilingual
                ? "bg-[#FFCC00] font-semibold text-[#111827]"
                : "bg-white/10 text-zinc-200 hover:bg-white/20"
            }`}
          >
            双语
          </button>

          <button
            type="button"
            onClick={() => setShowOverlay((prev) => !prev)}
            className="cursor-pointer rounded-md bg-white/10 px-2.5 py-1 text-zinc-200 transition hover:bg-white/20"
          >
            {showOverlay ? "隐藏译文" : "显示译文"}
          </button>

          <button
            type="button"
            onClick={() => void handleCopyRegions()}
            className="cursor-pointer rounded-md bg-white/10 px-2.5 py-1 text-zinc-200 transition hover:bg-white/20"
          >
            复制译文
          </button>

          <button
            type="button"
            onClick={() =>
              void invokeCommand("switch_live_mode", { mode: "in_place" }).catch((err) =>
                setError(err instanceof Error ? err.message : String(err)),
              )
            }
            className="cursor-pointer rounded-md bg-amber-500/20 px-2.5 py-1 text-amber-300 transition hover:bg-amber-500/30"
          >
            切到原位
          </button>

          <button
            type="button"
            onClick={() => void invokeCommand("reselect_live_region")}
            className="cursor-pointer rounded-md bg-white/10 px-2.5 py-1 text-zinc-200 transition hover:bg-white/20"
          >
            重选区域
          </button>

          <button
            type="button"
            onClick={() => void invokeCommand("stop_live_session")}
            className="cursor-pointer rounded-md bg-red-500/20 px-2.5 py-1 text-red-300 transition hover:bg-red-500/30"
          >
            停止
          </button>
        </div>
      </header>

      {error && (
        <div className="shrink-0 bg-red-950/70 px-3 py-1.5 text-xs text-red-200">{error}</div>
      )}

      {/* Mirrored Stage */}
      <main
        ref={stageRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3"
      >
        <div
          style={{ width: `${boxW}px`, height: `${boxH}px` }}
          className="relative overflow-hidden rounded-lg bg-black shadow-2xl ring-1 ring-white/10"
        >
          <canvas ref={canvasRef} className="block h-full w-full" />

          {showOverlay && (
            <RegionOverlayLayer
              regions={regions}
              sourceWidth={srcW}
              sourceHeight={srcH}
              containerWidth={boxW}
              containerHeight={boxH}
              opacity={status?.overlayOpacity ?? 0.94}
              bilingual={Boolean(status?.bilingual)}
              subtitleBarMode={Boolean(status?.subtitleBarMode)}
              selectable
            />
          )}
        </div>
      </main>
    </div>
  );
}
