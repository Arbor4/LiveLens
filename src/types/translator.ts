export type TextTranslateEngine =
  | "bing"
  | "google"
  | "microsoft"
  | "transmart"
  | "yandex"
  | "iciba"
  | "llm";

export type ProxyMode = "system" | "custom" | "none";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  autoPrompt: string;
}

export interface TranslatorSettings {
  fromLang: string;
  toLang: string;
  clientele: string;
  client: string;
  vendor: string;
  inputChannel: string;
  appVersion: string;
  abTest: string;
  model: string;
  screen: string;
  osVersion: string;
  network: string;
  mid: string;
  product: string;
  yduuid: string;
  overlayOpacity: number;
  overlayFontScale: number;
  closeOnOutsideClick: boolean;
  autostart: boolean;
  hotkey: string;
  copyHotkey: string;
  textTranslateEngine: TextTranslateEngine;
  llmConfig: LlmConfig;
  popupShortcut: string | null;
  proxyMode: ProxyMode;
  customProxy: string;
}

export interface TextTranslationResult {
  translatedText: string;
  fromLangDetected: string;
  alternatives?: string[];
}

export interface WorkflowStatePayload {
  message?: string;
  type?: string;
  busy?: boolean;
}

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureWindowInfo {
  rect: CaptureRect;
  title: string;
  ownerName: string;
}

export interface ScreenCapturePermissionStatus {
  supported: boolean;
  granted: boolean;
}

export interface CaptureViewPayload {
  imageBase64: string;
  imageMime: string;
  imageWidth: number;
  imageHeight: number;
  copyTextMode: boolean;
  windows?: CaptureWindowInfo[];
}

export interface CaptureTranslatePayload {
  imageBase64: string;
  selection: CaptureRect;
}

export interface OverlayPayload {
  requestId: string;
  lanFrom: string;
  lanTo: string;
  selection: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  overlayOpacity: number;
  overlayFontScale: number;
  closeOnOutsideClick: boolean;
  renderedImageBase64: string;
}
