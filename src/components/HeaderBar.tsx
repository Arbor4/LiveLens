import { ArrowRight, Scan, Settings } from "lucide-react";
import { LANGUAGES } from "../constants/translator";

interface HeaderBarProps {
  fromLang: string;
  toLang: string;
  loading: boolean;
  settingsOpen: boolean;
  onFromLangChange: (lang: string) => void;
  onToLangChange: (lang: string) => void;
  onStartCapture: () => void;
  onToggleSettings: () => void;
}

export function HeaderBar({
  fromLang,
  toLang,
  loading,
  settingsOpen,
  onFromLangChange,
  onToLangChange,
  onStartCapture,
  onToggleSettings,
}: HeaderBarProps) {
  return (
    <header
      className="header-block flex shrink-0 items-center justify-between rounded-[20px] bg-white px-4 py-3 shadow-[0_2px_8px_rgba(0,0,0,0.02)]"
      data-tauri-drag-region
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-center gap-1.5 select-none">
          <span className="text-[15px] font-bold tracking-tight text-[#111827]">幕译</span>
          <span className="rounded-md border border-amber-200/80 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-700">
            LiveLens
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-sm font-semibold text-[#111827]">
          <select
            id="from-lang"
            aria-label="源语言"
            value={fromLang}
            onChange={(e) => onFromLangChange(e.target.value)}
            className="cursor-pointer appearance-none rounded-md bg-transparent px-1.5 py-0.5 text-[13px] font-semibold text-[#111827] outline-none transition hover:bg-black/5"
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.value} value={lang.value}>
                {lang.label}
              </option>
            ))}
          </select>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
          <select
            id="to-lang"
            aria-label="目标语言"
            value={toLang}
            onChange={(e) => onToLangChange(e.target.value)}
            className="cursor-pointer appearance-none rounded-md bg-transparent px-1.5 py-0.5 text-[13px] font-semibold text-[#111827] outline-none transition hover:bg-black/5"
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.value} value={lang.value}>
                {lang.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          id="capture-btn"
          type="button"
          title="选区翻译"
          disabled={loading}
          onClick={(e) => {
            e.stopPropagation();
            onStartCapture();
          }}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-[#6B7280] transition hover:bg-black/5 hover:text-[#111827] disabled:cursor-default disabled:opacity-40"
        >
          <Scan className="h-4 w-4" aria-hidden="true" />
          <span>选区翻译</span>
        </button>

        <button
          id="settings-btn"
          type="button"
          title="设置"
          aria-expanded={settingsOpen}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSettings();
          }}
          className={`cursor-pointer rounded-lg p-1.5 transition hover:bg-black/5 ${
            settingsOpen
              ? "text-[#FFCC00] hover:text-[#FFCC00]"
              : "text-[#6B7280] hover:text-[#111827]"
          }`}
        >
          <Settings className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
