import type { ClipboardEvent, KeyboardEvent, RefObject } from "react";
import { Volume2 } from "lucide-react";
import { LANGUAGES } from "../constants/translator";

interface TranslationWorkspaceProps {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  inputText: string;
  translatedText: string;
  alternatives: string[];
  detectedLang: string;
  textLoading: boolean;
  loading: boolean;
  status: string;
  statusType: string;
  ttsPlaying: boolean;
  settingsOpen: boolean;
  screenPermissionSupported?: boolean;
  onInputChange: (value: string) => void;
  onTranslateNow: () => void;
  onSpeakInput: () => void;
  onResetScreenPermission?: () => void;
  onOpenScreenPermissionSettings?: () => void;
}

export function TranslationWorkspace({
  inputRef,
  inputText,
  translatedText,
  alternatives,
  detectedLang,
  textLoading,
  loading,
  status,
  statusType,
  ttsPlaying,
  settingsOpen,
  screenPermissionSupported,
  onInputChange,
  onTranslateNow,
  onSpeakInput,
  onResetScreenPermission,
  onOpenScreenPermissionSettings,
}: TranslationWorkspaceProps) {
  const detectedLabel = detectedLang
    ? LANGUAGES.find((lang) => lang.value === detectedLang)?.label || detectedLang
    : "";

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onTranslateNow();
    }
  };

  const handlePaste = (_e: ClipboardEvent<HTMLTextAreaElement>) => {
    setTimeout(() => {
      if (inputRef.current) {
        onInputChange(inputRef.current.value);
      }
      onTranslateNow();
    }, 0);
  };

  const showIdleSlogan = !textLoading && !translatedText && !status && !inputText.trim();
  const isPermissionError =
    statusType === "error" &&
    (status.includes("屏幕录制权限") || status.includes("screencapture"));

  const permissionActions =
    isPermissionError && screenPermissionSupported ? (
      <div className="mt-2 flex flex-wrap gap-1.5">
        {onResetScreenPermission && (
          <button
            type="button"
            onClick={onResetScreenPermission}
            className="cursor-pointer rounded-md bg-amber-500 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-amber-600"
          >
            重置录屏权限
          </button>
        )}
        {onOpenScreenPermissionSettings && (
          <button
            type="button"
            onClick={onOpenScreenPermissionSettings}
            className="cursor-pointer rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs font-medium text-[#111827] transition hover:bg-zinc-100"
          >
            打开系统设置
          </button>
        )}
      </div>
    ) : null;

  return (
    <section
      className={`text-block flex flex-row overflow-hidden rounded-[20px] bg-white p-4 shadow-[0_2px_8px_rgba(0,0,0,0.02)] ${
        settingsOpen ? "h-[200px] shrink-0 grow-0" : "min-h-0 flex-1"
      }`}
    >
      <div className="flex min-w-0 flex-1 flex-col border-r border-[#F0F0F2] pr-2.5">
        <div className="relative flex flex-1 flex-col min-h-0">
          <textarea
            ref={inputRef}
            id="text-input"
            rows={3}
            value={inputText}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="输入要翻译的文本..."
            className="min-h-0 w-full flex-1 resize-none overflow-y-auto border-none bg-transparent pr-2 text-[15px] font-medium leading-relaxed text-[#111827] outline-none placeholder:text-zinc-300"
          />
        </div>

        <div className="flex shrink-0 items-center justify-between gap-1 pt-1 text-xs text-[#6B7280]">
          {detectedLabel ? (
            <span
              id="detected-lang"
              className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-[#6B7280]"
            >
              检测: {detectedLabel}
            </span>
          ) : (
            <span />
          )}

          <button
            id="tts-btn"
            type="button"
            title="朗读"
            onClick={onSpeakInput}
            className={`cursor-pointer rounded p-1 transition ${
              ttsPlaying
                ? "text-[#FFCC00]"
                : "text-[#6B7280] hover:text-[#111827]"
            }`}
          >
            <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden pl-2.5">
        <div id="output-wrap" className="min-h-0 flex-1 overflow-y-auto">
          {isPermissionError && translatedText && (
            <div className="mb-2.5 rounded-lg border border-red-200 bg-red-50/80 p-2.5 text-xs leading-relaxed text-red-600">
              <div className="whitespace-pre-wrap">{status}</div>
              {permissionActions}
            </div>
          )}

          {textLoading ? (
            <div className="flex items-center gap-2 text-[15px] font-medium leading-relaxed text-[#111827]">
              <span className="dot-loading inline-flex items-center gap-1" aria-hidden="true">
                <span className="h-1 w-1 rounded-full bg-current" />
                <span className="h-1 w-1 rounded-full bg-current" />
                <span className="h-1 w-1 rounded-full bg-current" />
              </span>
              <span>翻译中…</span>
            </div>
          ) : translatedText ? (
            <>
              <div
                id="output-primary"
                className="mb-2 whitespace-pre-wrap text-[15px] font-medium leading-relaxed text-[#111827]"
              >
                {translatedText}
              </div>
              {alternatives.length > 0 && (
                <div id="output-alternatives" className="flex flex-wrap gap-1.5">
                  {alternatives.map((alt, idx) => (
                    <span
                      key={`${alt}-${idx}`}
                      className="cursor-default rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium leading-snug text-[#6B7280]"
                    >
                      {alt}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : loading && status ? (
            <div
              id="output-primary"
              className="whitespace-pre-wrap text-[15px] font-medium leading-relaxed text-[#111827]"
            >
              {status}
            </div>
          ) : status ? (
            <div>
              <div
                id="output-primary"
                className={`whitespace-pre-wrap text-[15px] font-medium leading-relaxed ${
                  statusType === "error" ? "text-red-500" : "text-[#111827]"
                }`}
              >
                {status}
              </div>
              {permissionActions}
            </div>
          ) : showIdleSlogan ? (
            <div className="select-none text-[13px] font-normal text-zinc-300">
              画面一变，翻译即现。
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
