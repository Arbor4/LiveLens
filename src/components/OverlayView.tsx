import { useEffect, useState } from "react";
import { invokeCommand, waitForTauriRuntime } from "../lib/tauri";
import type { OverlayPayload } from "../types/translator";

export function OverlayView() {
  const [overlay, setOverlay] = useState<OverlayPayload | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    document.body.dataset.mode = "overlay";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void invokeCommand("close_overlay");
      }
    };
    window.addEventListener("keydown", onKeyDown);

    const boot = async () => {
      try {
        await waitForTauriRuntime();
        const payload = await invokeCommand<OverlayPayload>("load_overlay_payload");
        setOverlay(payload);
      } catch (err) {
        setError(`覆盖层初始化失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    void boot();
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  if (error) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-[#111827] p-6 text-center text-sm text-[#F9FAFB]">
        {error}
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
