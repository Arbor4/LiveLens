import { useEffect, useState } from "react";
import { keyEventToShortcut, splitShortcutParts } from "../lib/shortcut";

interface ShortcutRecorderProps {
  id: string;
  shortcut: string | null;
  prefix?: string;
  allowClear?: boolean;
  onChange: (nextShortcut: string | null) => void;
  onRecordingChange: (recording: boolean) => void;
}

export function ShortcutRecorder({
  id,
  shortcut,
  prefix = "",
  allowClear = false,
  onChange,
  onRecordingChange,
}: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const result = keyEventToShortcut(event);
      if (result === null) {
        return;
      }

      setRecording(false);
      onRecordingChange(false);

      if (result === "cancel") {
        if (allowClear) {
          onChange(null);
        }
        return;
      }

      onChange(result);
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [allowClear, onChange, onRecordingChange, recording]);

  const startRecording = () => {
    if (recording) return;
    setRecording(true);
    onRecordingChange(true);
  };

  return (
    <button
      id={id}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        startRecording();
      }}
      className={`flex cursor-pointer select-none items-center gap-1 rounded-md border-none bg-transparent text-xs transition ${
        recording
          ? "font-medium text-amber-500"
          : "text-[#6B7280] hover:text-[#111827]"
      }`}
    >
      {recording ? (
        <span>按下快捷键…</span>
      ) : (
        <>
          {prefix && <span>{prefix}</span>}
          {shortcut ? (
            <span className="inline-flex items-center gap-1">
              {splitShortcutParts(shortcut).map((part, idx) => (
                <span key={`${part}-${idx}`} className="inline-flex items-center gap-1">
                  {idx > 0 && <span className="text-zinc-400">+</span>}
                  <kbd className="rounded bg-[#F3F4F6] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#111827]">
                    {part}
                  </kbd>
                </span>
              ))}
            </span>
          ) : (
            <span>未设置</span>
          )}
          <span className="ml-1.5 text-[11px] text-[#6B7280]">点击可设置</span>
        </>
      )}
    </button>
  );
}
