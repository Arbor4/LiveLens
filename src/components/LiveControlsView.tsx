import { useEffect, useState } from "react";
import {
  Languages,
  LayoutGrid,
  Monitor,
  Pause,
  Play,
  Scan,
  Square,
  Subtitles,
} from "lucide-react";
import { invokeCommand, listenEvent, waitForTauriRuntime } from "../lib/tauri";
import type { LiveSessionStatus } from "../types/translator";

export function LiveControlsView() {
  const [status, setStatus] = useState<LiveSessionStatus | null>(null);
  const [liveError, setLiveError] = useState("");

  useEffect(() => {
    document.documentElement.dataset.mode = "controls";
    document.body.dataset.mode = "controls";
    let unlistenStatus: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;

    const boot = async () => {
      try {
        await waitForTauriRuntime();
        const loaded = await invokeCommand<LiveSessionStatus>("load_live_status");
        setStatus(loaded);
        setLiveError(loaded.lastError || "");
        unlistenStatus = await listenEvent<LiveSessionStatus>("live:status", (event) => {
          if (event.payload) {
            setStatus(event.payload);
          }
        });
        unlistenError = await listenEvent<{ message?: string }>("live:error", (event) => {
          setLiveError(event.payload?.message || "");
        });
      } catch {
        // Ignore boot failure when closing.
      }
    };

    void boot();
    return () => {
      unlistenStatus?.();
      unlistenError?.();
    };
  }, []);

  const updateOptions = async (patch: Record<string, unknown>) => {
    try {
      const next = await invokeCommand<LiveSessionStatus>("update_live_options", patch);
      setStatus(next);
    } catch {
      // Ignore transient errors.
    }
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-transparent p-1 select-none">
      <div className="flex items-center gap-1 rounded-full border border-white/15 bg-gray-900/92 px-2.5 py-1 text-xs font-medium text-white shadow-xl backdrop-blur-md">
        <span
          data-tauri-drag-region
          title={liveError || "拖动控制条"}
          className="flex cursor-grab items-center gap-1.5 px-1 text-zinc-300"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              liveError
                ? "bg-red-400"
                : status?.paused
                  ? "bg-amber-400"
                  : "bg-emerald-400 animate-pulse"
            }`}
          />
          <span className="text-[11px]">
            {liveError ? "出错" : status?.paused ? "已暂停" : "原位实时"}
          </span>
        </span>

        <span className="mx-0.5 h-3.5 w-px bg-white/15" />

        <button
          type="button"
          onClick={() =>
            void invokeCommand<LiveSessionStatus>("pause_live_session", {
              paused: !(status?.paused ?? false),
            }).then(setStatus)
          }
          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-gray-100 transition hover:bg-white/10"
        >
          {status?.paused ? (
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Pause className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>{status?.paused ? "继续" : "暂停"}</span>
        </button>

        <button
          type="button"
          onClick={() =>
            void updateOptions({ subtitleBarMode: !(status?.subtitleBarMode ?? false) })
          }
          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-gray-100 transition hover:bg-white/10"
        >
          {status?.subtitleBarMode ? (
            <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Subtitles className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>{status?.subtitleBarMode ? "原位块" : "字幕条"}</span>
        </button>

        <button
          type="button"
          onClick={() => void updateOptions({ bilingual: !(status?.bilingual ?? false) })}
          className={`inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 transition ${
            status?.bilingual
              ? "bg-[#FFCC00] font-semibold text-[#111827]"
              : "text-gray-100 hover:bg-white/10"
          }`}
        >
          <Languages className="h-3.5 w-3.5" aria-hidden="true" />
          <span>双语</span>
        </button>

        <button
          type="button"
          onClick={() => void invokeCommand("switch_live_mode", { mode: "mirror" })}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-amber-500/20 px-2 py-1 text-amber-300 transition hover:bg-amber-500/30"
        >
          <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
          <span>切到副屏</span>
        </button>

        <button
          type="button"
          onClick={() => void invokeCommand("reselect_live_region")}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-gray-100 transition hover:bg-white/10"
        >
          <Scan className="h-3.5 w-3.5" aria-hidden="true" />
          <span>重选</span>
        </button>

        <button
          type="button"
          onClick={() => void invokeCommand("stop_live_session")}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-red-500/20 px-2 py-1 text-red-300 transition hover:bg-red-500/30"
        >
          <Square className="h-3.5 w-3.5" aria-hidden="true" />
          <span>停止</span>
        </button>
      </div>
    </div>
  );
}
