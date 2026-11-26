import { useEffect, useState } from "react";
import { invokeCommand, listenEvent, waitForTauriRuntime } from "../lib/tauri";
import type {
  LiveRegionsEvent,
  LiveSessionStatus,
  OverlayPayload,
  OverlayRegion,
} from "../types/translator";
import { RegionOverlayLayer } from "./RegionOverlayLayer";

export function OverlayView() {
  const [overlay, setOverlay] = useState<OverlayPayload | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveSessionStatus | null>(null);
  const [liveRegions, setLiveRegions] = useState<OverlayRegion[]>([]);
  const [error, setError] = useState("");
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  useEffect(() => {
    document.documentElement.dataset.mode = "overlay";
    document.body.dataset.mode = "overlay";
    let unlistenRegions: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void invokeCommand("close_overlay");
      }
    };
    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);

    const boot = async () => {
      try {
        await waitForTauriRuntime();

        const live = await invokeCommand<LiveSessionStatus>("load_live_status");
        if (live.active && live.mode === "in_place") {
          setLiveStatus(live);
          setLiveRegions(live.regions || []);

          unlistenRegions = await listenEvent<LiveRegionsEvent>("live:regions", (event) => {
            if (event.payload) {
              setLiveRegions(event.payload.regions || []);
            }
          });
          unlistenStatus = await listenEvent<LiveSessionStatus>("live:status", (event) => {
            if (event.payload) {
              setLiveStatus(event.payload);
            }
          });
          unlistenError = await listenEvent<{ message?: string }>("live:error", (event) => {
            if (event.payload?.message) {
              setError(event.payload.message);
            }
          });
          return;
        }

        const payload = await invokeCommand<OverlayPayload>("load_overlay_payload");
        setOverlay(payload);
      } catch (err) {
        setError(`覆盖层初始化失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    void boot();
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
      unlistenRegions?.();
      unlistenStatus?.();
      unlistenError?.();
    };
  }, []);

  if (error) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-[#111827]/90 p-6 text-center text-sm text-[#F9FAFB]">
        {error}
      </div>
    );
  }

  if (liveStatus && liveStatus.active) {
    const srcW = Math.max(1, liveStatus.sourceWidth || liveStatus.selection.width);
    const srcH = Math.max(1, liveStatus.sourceHeight || liveStatus.selection.height);
    return (
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 border border-[#FFCC00]/60" />
        <RegionOverlayLayer
          regions={liveRegions}
          sourceWidth={srcW}
          sourceHeight={srcH}
          containerWidth={viewport.width}
          containerHeight={viewport.height}
          opacity={liveStatus.overlayOpacity}
          bilingual={liveStatus.bilingual}
          subtitleBarMode={liveStatus.subtitleBarMode}
        />
      </div>
    );
  }

  const dpr = window.devicePixelRatio || 1;

  return (
    <div
      className="fixed inset-0"
      onClick={() => {
        if (overlay?.closeOnOutsideClick) {
          void invokeCommand("close_overlay");
        }
      }}
    >
      {overlay && (
        <img
          src={`data:image/jpeg;base64,${overlay.renderedImageBase64}`}
          alt="translated"
          style={{
            left: `${overlay.selection.x / dpr}px`,
            top: `${overlay.selection.y / dpr}px`,
            width: `${overlay.selection.width / dpr}px`,
            height: `${overlay.selection.height / dpr}px`,
            opacity: overlay.overlayOpacity,
          }}
          className="pointer-events-auto absolute"
        />
      )}
    </div>
  );
}
