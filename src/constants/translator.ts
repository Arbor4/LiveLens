import type { ProxyMode, TextTranslateEngine, TranslatorSettings } from "../types/translator";

export interface LanguageOption {
  value: string;
  label: string;
}

export const LANGUAGES: LanguageOption[] = [
  { value: "auto", label: "自动检测" },
  { value: "zh-CHS", label: "中文简体" },
  { value: "zh-CHT", label: "中文繁体" },
  { value: "en", label: "英语" },
  { value: "ja", label: "日语" },
  { value: "ko", label: "韩语" },
  { value: "fr", label: "法语" },
  { value: "de", label: "德语" },
  { value: "ru", label: "俄语" },
  { value: "es", label: "西班牙语" },
];

export const TTS_LANG_MAP: Record<string, string> = {
  "zh-CHS": "zh-CN",
  "zh-CN": "zh-CN",
  "zh-CHT": "zh-TW",
  "zh-TW": "zh-TW",
  en: "en-US",
  ja: "ja-JP",
  ko: "ko-KR",
  fr: "fr-FR",
  de: "de-DE",
  ru: "ru-RU",
  es: "es-ES",
};

export const TRANSLATE_ENGINES: { value: TextTranslateEngine; label: string }[] = [
  { value: "bing", label: "必应" },
  { value: "google", label: "Google" },
  { value: "microsoft", label: "微软" },
  { value: "transmart", label: "腾讯" },
  { value: "yandex", label: "Yandex" },
  { value: "iciba", label: "词霸" },
  { value: "llm", label: "AI 大模型" },
];

export const PROXY_MODES: { value: ProxyMode; label: string }[] = [
  { value: "system", label: "系统代理" },
  { value: "custom", label: "自定义" },
  { value: "none", label: "不使用" },
];

export const DEFAULT_LLM_PROMPT =
  "You are a professional translator. Translate the following text from {from} to {to}. Only output the translation, nothing else. Do not add explanations or notes.";

export const DEFAULT_LLM_AUTO_PROMPT =
  "You are a professional translator. Detect the source language and translate the following text to {to}. Only output the translation, nothing else. Do not add explanations or notes.";

export function createDefaultSettings(): TranslatorSettings {
  return {
    fromLang: "auto",
    toLang: "zh-CHS",
    clientele: "deskdict",
    client: "deskdict",
    vendor: "fanyiweb_navigation",
    inputChannel: "YoudaoDict_fanyiweb_navigation",
    appVersion: "10.3.0",
    abTest: "2",
    model: "default",
    screen: "1920*1080",
    osVersion: "14.0",
    network: "none",
    mid: "macos14.0",
    product: "macdict",
    yduuid: `web-${Date.now()}`,
    overlayOpacity: 0.92,
    overlayFontScale: 1,
    closeOnOutsideClick: true,
    autostart: false,
    hotkey: "CommandOrControl+Shift+X",
    copyHotkey: "CommandOrControl+Shift+C",
    textTranslateEngine: "bing",
    llmConfig: {
      baseUrl: "https://api.openai.com/v1/chat/completions",
      apiKey: "",
      model: "gpt-4o-mini",
      prompt: DEFAULT_LLM_PROMPT,
      autoPrompt: DEFAULT_LLM_AUTO_PROMPT,
    },
    popupShortcut: null,
    proxyMode: "system",
    customProxy: "",
  };
}
