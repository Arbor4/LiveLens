import type { RefObject } from "react";
import {
  DEFAULT_LLM_AUTO_PROMPT,
  DEFAULT_LLM_PROMPT,
  PROXY_MODES,
  TRANSLATE_ENGINES,
} from "../constants/translator";
import type {
  LlmConfig,
  ProxyMode,
  ScreenCapturePermissionStatus,
  TextTranslateEngine,
  TranslatorSettings,
} from "../types/translator";
import { ShortcutRecorder } from "./ShortcutRecorder";

interface SettingsPanelProps {
  panelRef: RefObject<HTMLDivElement | null>;
  settings: TranslatorSettings;
  open: boolean;
  screenPermission?: ScreenCapturePermissionStatus | null;
  onUpdateSettings: (updater: (prev: TranslatorSettings) => TranslatorSettings) => void;
  onUpdateLlmConfig: (patch: Partial<LlmConfig>) => void;
  onRecordingChange: (recording: boolean) => void;
  onResetScreenPermission?: () => void;
  onOpenScreenPermissionSettings?: () => void;
}

export function SettingsPanel({
  panelRef,
  settings,
  open,
  screenPermission,
  onUpdateSettings,
  onUpdateLlmConfig,
  onRecordingChange,
  onResetScreenPermission,
  onOpenScreenPermissionSettings,
}: SettingsPanelProps) {
  if (!open) {
    return null;
  }

  return (
    <section
      ref={panelRef}
      id="settings-panel"
      className="settings-panel no-scrollbar min-h-0 flex-1 overflow-y-auto rounded-[20px] bg-white px-4 py-3.5 shadow-[0_2px_8px_rgba(0,0,0,0.02)]"
    >
      <div className="settings-section flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="shrink-0 whitespace-nowrap text-[13px] font-medium text-[#111827]">
            翻译引擎
          </span>
          <div className="flex flex-wrap justify-end rounded-lg bg-zinc-100 p-0.5">
            {TRANSLATE_ENGINES.map((engine) => {
              const active = settings.textTranslateEngine === engine.value;
              return (
                <button
                  key={engine.value}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdateSettings((prev) => ({
                      ...prev,
                      textTranslateEngine: engine.value as TextTranslateEngine,
                    }));
                  }}
                  className={`cursor-pointer whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition ${
                    active
                      ? "bg-white text-[#111827] shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                      : "text-[#6B7280] hover:text-[#111827]"
                  }`}
                >
                  {engine.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="shrink-0 whitespace-nowrap text-[13px] font-medium text-[#111827]">
            网络代理
          </span>
          <div className="flex rounded-lg bg-zinc-100 p-0.5">
            {PROXY_MODES.map((proxy) => {
              const active = settings.proxyMode === proxy.value;
              return (
                <button
                  key={proxy.value}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdateSettings((prev) => ({
                      ...prev,
                      proxyMode: proxy.value as ProxyMode,
                    }));
                  }}
                  className={`cursor-pointer whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition ${
                    active
                      ? "bg-white text-[#111827] shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                      : "text-[#6B7280] hover:text-[#111827]"
                  }`}
                >
                  {proxy.label}
                </button>
              );
            })}
          </div>
        </div>

        {settings.proxyMode === "custom" && (
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="custom-proxy"
              className="shrink-0 whitespace-nowrap text-[13px] font-medium text-[#111827]"
            >
              代理地址
            </label>
            <input
              id="custom-proxy"
              type="text"
              value={settings.customProxy || ""}
              onChange={(e) => {
                const value = e.target.value;
                onUpdateSettings((prev) => ({ ...prev, customProxy: value.trim() }));
              }}
              placeholder="http://127.0.0.1:7890"
              className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-[#F3F4F6] px-2.5 py-1 text-right text-xs text-[#111827] outline-none transition placeholder:text-zinc-300 focus:border-[#FFCC00]"
            />
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="shrink-0 whitespace-nowrap text-[13px] font-medium text-[#111827]">
            开机自启
          </span>
          <button
            id="autostart"
            type="button"
            aria-pressed={settings.autostart}
            onClick={() =>
              onUpdateSettings((prev) => ({
                ...prev,
                autostart: !prev.autostart,
              }))
            }
            className={`relative h-[18px] w-8 shrink-0 cursor-pointer rounded-full border-none p-0 transition-colors ${
              settings.autostart ? "bg-[#FFCC00]" : "bg-zinc-200"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.12)] transition-transform ${
                settings.autostart ? "translate-x-3.5" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <span className="shrink-0 whitespace-nowrap text-[13px] font-medium text-[#111827]">
            截图翻译
          </span>
          <ShortcutRecorder
            id="shortcut-row"
            prefix="快捷键:"
            shortcut={settings.hotkey}
            onRecordingChange={onRecordingChange}
            onChange={(combo) => {
              if (!combo) return;
              onUpdateSettings((prev) => ({ ...prev, hotkey: combo }));
            }}
          />
        </div>

        <div className="flex items-center justify-between">
          <span className="shrink-0 whitespace-nowrap text-[13px] font-medium text-[#111827]">
            截图复制
          </span>
          <ShortcutRecorder
            id="copy-shortcut-row"
            prefix="快捷键:"
            shortcut={settings.copyHotkey}
            onRecordingChange={onRecordingChange}
            onChange={(combo) => {
              if (!combo) return;
              onUpdateSettings((prev) => ({ ...prev, copyHotkey: combo }));
            }}
          />
        </div>

        <div className="flex items-center justify-between">
          <span className="shrink-0 whitespace-nowrap text-[13px] font-medium text-[#111827]">
            弹出窗口
          </span>
          <ShortcutRecorder
            id="popup-shortcut-row"
            allowClear
            shortcut={settings.popupShortcut}
            onRecordingChange={onRecordingChange}
            onChange={(combo) =>
              onUpdateSettings((prev) => ({ ...prev, popupShortcut: combo }))
            }
          />
        </div>

        {screenPermission?.supported && (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="shrink-0 whitespace-nowrap text-[13px] font-medium text-[#111827]">
                录屏权限
              </span>
              <span
                className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                  screenPermission.granted
                    ? "bg-emerald-50 text-emerald-600"
                    : "bg-red-50 text-red-600"
                }`}
              >
                {screenPermission.granted ? "已授权" : "未授权 / 需修复"}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {onResetScreenPermission && (
                <button
                  type="button"
                  onClick={onResetScreenPermission}
                  className="cursor-pointer rounded-md bg-zinc-100 px-2.5 py-1 text-xs font-medium text-[#111827] transition hover:bg-zinc-200"
                >
                  重置权限
                </button>
              )}
              {onOpenScreenPermissionSettings && (
                <button
                  type="button"
                  onClick={onOpenScreenPermissionSettings}
                  className="cursor-pointer rounded-md bg-zinc-100 px-2.5 py-1 text-xs font-medium text-[#6B7280] transition hover:bg-zinc-200 hover:text-[#111827]"
                >
                  系统设置
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {settings.textTranslateEngine === "llm" && (
        <div className="settings-section mt-3 flex flex-col gap-3 border-t border-zinc-100 pt-3">
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="llm-base-url"
              className="shrink-0 whitespace-nowrap text-[13px] font-medium text-[#111827]"
            >
              API 地址 (OpenAI)
            </label>
            <input
              id="llm-base-url"
              type="text"
              value={settings.llmConfig.baseUrl}
              onChange={(e) => onUpdateLlmConfig({ baseUrl: e.target.value.trim() })}
              placeholder="https://api.openai.com/v1/chat/completions"
              className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-[#F3F4F6] px-2.5 py-1 text-right text-xs text-[#111827] outline-none transition placeholder:text-zinc-300 focus:border-[#FFCC00]"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="llm-api-key"
              className="shrink-0 whitespace-nowrap text-[13px] font-medium text-[#111827]"
            >
              API Key
            </label>
            <input
              id="llm-api-key"
              type="password"
              value={settings.llmConfig.apiKey}
              onChange={(e) => onUpdateLlmConfig({ apiKey: e.target.value.trim() })}
              placeholder="sk-..."
              className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-[#F3F4F6] px-2.5 py-1 text-right text-xs text-[#111827] outline-none transition placeholder:text-zinc-300 focus:border-[#FFCC00]"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="llm-model"
              className="shrink-0 whitespace-nowrap text-[13px] font-medium text-[#111827]"
            >
              模型
            </label>
            <input
              id="llm-model"
              type="text"
              value={settings.llmConfig.model}
              onChange={(e) => onUpdateLlmConfig({ model: e.target.value.trim() })}
              placeholder="gpt-4o-mini"
              className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-[#F3F4F6] px-2.5 py-1 text-right text-xs text-[#111827] outline-none transition placeholder:text-zinc-300 focus:border-[#FFCC00]"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="llm-prompt"
              className="flex items-baseline justify-between gap-2 text-[13px] font-medium text-[#111827]"
            >
              <span>提示词（指定源语言）</span>
              <span className="text-[11px] font-normal text-[#6B7280]">
                可用 {"{from}"} / {"{to}"} 表示源/目标语言
              </span>
            </label>
            <textarea
              id="llm-prompt"
              rows={3}
              value={settings.llmConfig.prompt || ""}
              onChange={(e) => onUpdateLlmConfig({ prompt: e.target.value })}
              placeholder={DEFAULT_LLM_PROMPT}
              className="min-h-[64px] w-full resize-y rounded-lg border border-zinc-200 bg-[#F3F4F6] px-2.5 py-1.5 text-left text-xs leading-relaxed text-[#111827] outline-none transition placeholder:text-zinc-300 focus:border-[#FFCC00]"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="llm-auto-prompt"
              className="flex items-baseline justify-between gap-2 text-[13px] font-medium text-[#111827]"
            >
              <span>提示词（自动检测源语言）</span>
              <span className="text-[11px] font-normal text-[#6B7280]">
                源语言为“自动检测”时使用，可用 {"{to}"}
              </span>
            </label>
            <textarea
              id="llm-auto-prompt"
              rows={3}
              value={settings.llmConfig.autoPrompt || ""}
              onChange={(e) => onUpdateLlmConfig({ autoPrompt: e.target.value })}
              placeholder={DEFAULT_LLM_AUTO_PROMPT}
              className="min-h-[64px] w-full resize-y rounded-lg border border-zinc-200 bg-[#F3F4F6] px-2.5 py-1.5 text-left text-xs leading-relaxed text-[#111827] outline-none transition placeholder:text-zinc-300 focus:border-[#FFCC00]"
            />
          </div>
        </div>
      )}
    </section>
  );
}
