import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { HeaderBar } from "./components/HeaderBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { TranslationWorkspace } from "./components/TranslationWorkspace";
import { createDefaultSettings, TTS_LANG_MAP } from "./constants/translator";
import { focusTextInputIfAllowed } from "./lib/focus";
import { invokeCommand, listenEvent, waitForTauriRuntime } from "./lib/tauri";
import type {
  LlmConfig,
  ScreenCapturePermissionStatus,
  TranslatorSettings,
  WorkflowStatePayload,
} from "./types/translator";

function setCapturePreparing(active: boolean) {
  document.documentElement.classList.toggle("capture-preparing", active);
  document.body.classList.toggle("capture-preparing", active);
}

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

export function App() {
  const appRef = useRef<HTMLDivElement | null>(null);
  const settingsPanelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const translateSeqRef = useRef(0);
  const hotkeyRecordingRef = useRef(false);
  const loadingRef = useRef(false);

  const [settings, setSettings] = useState<TranslatorSettings | null>(null);
  const [fatalError, setFatalError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [inputText, setInputText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const [detectedLang, setDetectedLang] = useState("");
  const [textLoading, setTextLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [statusType, setStatusType] = useState("");
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [screenPermission, setScreenPermission] =
    useState<ScreenCapturePermissionStatus | null>(null);

  const settingsRef = useRef<TranslatorSettings | null>(null);
  settingsRef.current = settings;
  loadingRef.current = loading;

  const persistSettings = useCallback(async (next: TranslatorSettings) => {
    try {
      const saved = await invokeCommand<TranslatorSettings>("save_settings", { settings: next });
      setSettings(saved);
    } catch {
      // Best-effort persistence, matching original UI behavior.
    }
  }, []);

  const updateSettings = useCallback(
    (updater: (prev: TranslatorSettings) => TranslatorSettings) => {
      setSettings((prev) => {
        if (!prev) return prev;
        const next = updater(prev);
        void persistSettings(next);
        return next;
      });
    },
    [persistSettings],
  );

  const updateLlmConfig = useCallback(
    (patch: Partial<LlmConfig>) => {
      updateSettings((prev) => ({
        ...prev,
        llmConfig: {
          ...prev.llmConfig,
          ...patch,
        },
      }));
    },
    [updateSettings],
  );

  const measureSettingsHeight = useCallback(() => {
    const appEl = appRef.current;
    const panel = settingsPanelRef.current;
    const header = appEl?.querySelector<HTMLElement>(".header-block");
    const textBlock = appEl?.querySelector<HTMLElement>(".text-block");

    if (appEl && header && textBlock && panel) {
      const appCs = getComputedStyle(appEl);
      const appPadding = parseFloat(appCs.paddingTop) + parseFloat(appCs.paddingBottom);
      const appGap = parseFloat(appCs.rowGap || appCs.gap) || 0;

      const panelCs = getComputedStyle(panel);
      let panelContent = parseFloat(panelCs.paddingTop) + parseFloat(panelCs.paddingBottom);
      panel.querySelectorAll<HTMLElement>(":scope > .settings-section").forEach((section) => {
        if (getComputedStyle(section).display === "none") return;
        const sCs = getComputedStyle(section);
        panelContent +=
          section.offsetHeight +
          parseFloat(sCs.marginTop) +
          parseFloat(sCs.marginBottom);
      });

      const total =
        header.offsetHeight +
        textBlock.offsetHeight +
        panelContent +
        appGap * 2 +
        appPadding;
      const measured = Math.ceil(total) + 2;
      if (measured > 0) return measured;
    }

    let fallback = 560;
    if (settingsRef.current?.textTranslateEngine === "llm") fallback += 200;
    if (settingsRef.current?.proxyMode === "custom") fallback += 56;
    return fallback;
  }, []);

  useLayoutEffect(() => {
    if (!settings) return;
    const targetHeight = settingsOpen ? measureSettingsHeight() : 400;
    void invokeCommand("resize_main_window", { height: targetHeight }).catch(() => {});
  }, [
    measureSettingsHeight,
    screenPermission?.supported,
    settings?.imageTranslateMode,
    settings?.ocrEngine,
    settings?.proxyMode,
    settings?.textTranslateEngine,
    settingsOpen,
    Boolean(settings),
  ]);

  const refreshScreenPermission = useCallback(async () => {
    try {
      const next = await invokeCommand<ScreenCapturePermissionStatus>(
        "get_screen_capture_permission_status",
      );
      setScreenPermission(next);
    } catch {
      // Ignore if running outside Tauri runtime.
    }
  }, []);

  const handleResetScreenPermission = useCallback(async () => {
    try {
      const granted = await invokeCommand<boolean>("reset_screen_capture_permission");
      setScreenPermission((prev) =>
        prev ? { ...prev, granted } : { supported: true, granted },
      );
      setStatus(
        granted
          ? "屏幕录制权限已恢复"
          : "已清除旧录屏权限记录，请在系统弹窗中允许并在设置中勾选后重启 LiveLens",
      );
      setStatusType(granted ? "ok" : "");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      setStatusType("error");
    }
  }, []);

  const handleOpenScreenPermissionSettings = useCallback(async () => {
    try {
      await invokeCommand("open_screen_capture_settings");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      setStatusType("error");
    }
  }, []);

  const translateText = useCallback(async (textOverride?: string) => {
    const activeSettings = settingsRef.current;
    if (!activeSettings) return;

    const raw = textOverride ?? inputRef.current?.value ?? inputText;
    const text = raw.trim();
    if (!text) return;

    const seq = ++translateSeqRef.current;
    setTextLoading(true);
    setTranslatedText("");
    setAlternatives([]);
    setDetectedLang("");

    const isLocalLlmUrl = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:\d+)?/i.test(
      activeSettings.llmConfig.baseUrl.trim(),
    );
    if (
      activeSettings.textTranslateEngine === "llm" &&
      !activeSettings.llmConfig.apiKey &&
      !isLocalLlmUrl
    ) {
      if (seq === translateSeqRef.current) {
        setTextLoading(false);
        setStatus("请先在设置中配置 API Key");
        setStatusType("error");
      }
      return;
    }

    try {
      const result = await invokeCommand<{
        translatedText: string;
        fromLangDetected: string;
        alternatives?: string[];
      }>("translate_text", {
        text,
        fromLang: activeSettings.fromLang,
        toLang: activeSettings.toLang,
      });

      if (seq !== translateSeqRef.current) return;
      setTranslatedText(result.translatedText);
      setAlternatives(result.alternatives || []);
      setDetectedLang(result.fromLangDetected);
      setStatus("");
      setStatusType("");
    } catch (err) {
      if (seq !== translateSeqRef.current) return;
      setStatus(err instanceof Error ? err.message : String(err));
      setStatusType("error");
    } finally {
      if (seq === translateSeqRef.current) {
        setTextLoading(false);
      }
    }
  }, [inputText]);

  const handleInputChange = useCallback(
    (value: string) => {
      setInputText(value);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        if (value.trim()) {
          void translateText(value);
        } else {
          translateSeqRef.current += 1;
          setTextLoading(false);
          setTranslatedText("");
          setAlternatives([]);
          setDetectedLang("");
        }
      }, 500);
    },
    [translateText],
  );

  const handleStartCapture = useCallback(async () => {
    const activeSettings = settingsRef.current;
    if (loadingRef.current || !activeSettings) return;
    try {
      setLoading(true);
      await persistSettings(activeSettings);
      setCapturePreparing(true);
      (document.activeElement as HTMLElement | null)?.blur?.();
      await waitForNextPaint();
      await invokeCommand("begin_capture", {
        options: {
          fromLang: activeSettings.fromLang,
          toLang: activeSettings.toLang,
        },
      });
    } catch (err) {
      setCapturePreparing(false);
      setLoading(false);
      setStatus(err instanceof Error ? err.message : String(err));
      setStatusType("error");
    }
  }, [persistSettings]);

  const handleSpeakInput = useCallback(() => {
    const text = inputText.trim();
    const activeSettings = settingsRef.current;
    if (!text || !activeSettings) return;

    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      setTtsPlaying(false);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    const fromLang = detectedLang || activeSettings.fromLang;
    utterance.lang = TTS_LANG_MAP[fromLang] || fromLang;
    utterance.onend = () => setTtsPlaying(false);
    utterance.onerror = () => setTtsPlaying(false);

    setTtsPlaying(true);
    window.speechSynthesis.speak(utterance);
  }, [detectedLang, inputText]);

  useEffect(() => {
    document.body.dataset.mode = "main";
    let unlistenWorkflow: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;

    const boot = async () => {
      const isDemoPreview =
        import.meta.env.DEV &&
        new URLSearchParams(window.location.search).get("demo") === "1";
      if (isDemoPreview) {
        const demoSettings = createDefaultSettings();
        demoSettings.fromLang = "en";
        demoSettings.toLang = "zh-CHS";
        setSettings(demoSettings);
        setInputText("Screen changes, translation appears instantly.");
        setTranslatedText("画面一变，翻译即现。");
        setDetectedLang("en");
        setAlternatives(["幕译 · LiveLens", "实时屏幕翻译"]);
        return;
      }

      try {
        await waitForTauriRuntime();

        unlistenWorkflow = await listenEvent<WorkflowStatePayload>("workflow:state", (event) => {
          const payload = event.payload || {};
          const busy = Boolean(payload.busy);
          setLoading(busy);
          if (typeof payload.message === "string") {
            setStatus(payload.message);
            setStatusType(payload.type || "");
          }
          if (!busy && (!payload.message || payload.type === "error")) {
            setCapturePreparing(false);
          }
        });

        unlistenFocus = await listenEvent("main:focus-text-input", () => {
          focusTextInputIfAllowed({
            mode: "main",
            hotkeyRecording: hotkeyRecordingRef.current,
            input: inputRef.current,
          });
        });

        try {
          const loaded = await invokeCommand<TranslatorSettings>("load_settings");
          setSettings(loaded);
        } catch (err) {
          console.error("load_settings failed, falling back to defaults", err);
          setSettings(createDefaultSettings());
          setStatus(
            `设置加载失败，已使用默认配置: ${err instanceof Error ? err.message : String(err)}`,
          );
          setStatusType("error");
        }

        void invokeCommand("resize_main_window", { height: 400 }).catch(() => {});
        void refreshScreenPermission();
      } catch (err) {
        setFatalError(err instanceof Error ? err.message : String(err));
      }
    };

    void boot();
    return () => {
      unlistenWorkflow?.();
      unlistenFocus?.();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (settings && inputRef.current) {
      inputRef.current.focus();
    }
  }, [Boolean(settings)]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !hotkeyRecordingRef.current) {
        void invokeCommand("hide_window").catch(() => {});
      }
    };

    const onWindowFocus = () => {
      setCapturePreparing(false);
      void refreshScreenPermission();
    };

    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [refreshScreenPermission]);

  if (fatalError) {
    return (
      <div className="flex h-full w-full flex-col gap-3 bg-[#F3F4F6] p-3">
        <div className="rounded-[20px] bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
          <span className="text-xs text-red-500">启动失败: {fatalError}</span>
        </div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex h-full w-full flex-col gap-3 bg-[#F3F4F6] p-3">
        <div className="rounded-[20px] bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
          <span className="text-xs text-[#6B7280]">正在加载…</span>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={appRef}
      className={`bento-app flex h-full w-full flex-col gap-3 bg-[#F3F4F6] p-3 ${
        settingsOpen ? "settings-open" : ""
      }`}
    >
      <HeaderBar
        fromLang={settings.fromLang}
        toLang={settings.toLang}
        loading={loading}
        settingsOpen={settingsOpen}
        onFromLangChange={(fromLang) => updateSettings((prev) => ({ ...prev, fromLang }))}
        onToLangChange={(toLang) => updateSettings((prev) => ({ ...prev, toLang }))}
        onStartCapture={() => void handleStartCapture()}
        onToggleSettings={() => setSettingsOpen((prev) => !prev)}
      />

      <TranslationWorkspace
        inputRef={inputRef}
        inputText={inputText}
        translatedText={translatedText}
        alternatives={alternatives}
        detectedLang={detectedLang}
        textLoading={textLoading}
        loading={loading}
        status={status}
        statusType={statusType}
        ttsPlaying={ttsPlaying}
        settingsOpen={settingsOpen}
        screenPermissionSupported={Boolean(screenPermission?.supported)}
        onInputChange={handleInputChange}
        onTranslateNow={() => void translateText()}
        onSpeakInput={handleSpeakInput}
        onResetScreenPermission={() => void handleResetScreenPermission()}
        onOpenScreenPermissionSettings={() => void handleOpenScreenPermissionSettings()}
      />

      <SettingsPanel
        panelRef={settingsPanelRef}
        settings={settings}
        open={settingsOpen}
        screenPermission={screenPermission}
        onUpdateSettings={updateSettings}
        onUpdateLlmConfig={updateLlmConfig}
        onRecordingChange={(recording) => {
          hotkeyRecordingRef.current = recording;
        }}
        onResetScreenPermission={() => void handleResetScreenPermission()}
        onOpenScreenPermissionSettings={() => void handleOpenScreenPermissionSettings()}
      />
    </div>
  );
}

export default App;
