use std::collections::HashMap;
use std::sync::Arc;

use reqwest::Client;
use tokio::sync::{watch, RwLock};

use crate::config::ConfigStore;
use crate::models::{
    CaptureMode, CaptureRect, CaptureWindowInfo, LiveDisplayMode, OverlayPayload, OverlayRegion,
    TranslatorSettings,
};
use crate::translators::{image_ocr::YoudaoClient, TextTranslator};

#[derive(Clone)]
pub struct ActiveCaptureSession {
    pub rgba: Vec<u8>,
    pub img_w: u32,
    pub img_h: u32,
    pub scale_factor: f64,
    pub monitor_x: i32,
    pub monitor_y: i32,
    pub monitor_width: u32,
    pub monitor_height: u32,
    pub preview_image_base64: Option<String>,
    pub preview_image_mime: String,
    pub windows: Vec<CaptureWindowInfo>,
    #[cfg(target_os = "macos")]
    pub display_id: u32,
    pub restore_main_window: bool,
}

#[derive(Clone, Default)]
pub struct LiveFrameStore {
    pub port: u16,
    pub token: String,
    pub jpeg_bytes: Vec<u8>,
    pub seq: u64,
}

#[derive(Clone)]
pub struct LiveRuntime {
    pub active: bool,
    pub mode: LiveDisplayMode,
    pub paused: bool,
    pub keyframe_only: bool,
    pub bilingual: bool,
    pub subtitle_bar_mode: bool,
    pub overlay_opacity: f32,
    pub selection: CaptureRect,
    pub monitor_x: i32,
    pub monitor_y: i32,
    pub monitor_width: u32,
    pub monitor_height: u32,
    pub img_w: u32,
    pub img_h: u32,
    pub scale_factor: f64,
    pub display_id: u32,
    pub source_width: u32,
    pub source_height: u32,
    pub regions: Vec<OverlayRegion>,
    pub last_error: String,
    pub stop_tx: Option<watch::Sender<bool>>,
}

impl Default for LiveRuntime {
    fn default() -> Self {
        Self {
            active: false,
            mode: LiveDisplayMode::Mirror,
            paused: false,
            keyframe_only: true,
            bilingual: false,
            subtitle_bar_mode: false,
            overlay_opacity: 0.92,
            selection: CaptureRect {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            },
            monitor_x: 0,
            monitor_y: 0,
            monitor_width: 0,
            monitor_height: 0,
            img_w: 0,
            img_h: 0,
            scale_factor: 1.0,
            display_id: 0,
            source_width: 0,
            source_height: 0,
            regions: Vec::new(),
            last_error: String::new(),
            stop_tx: None,
        }
    }
}

#[derive(Clone)]
pub struct SharedState {
    pub config_store: Arc<ConfigStore>,
    pub settings: Arc<RwLock<TranslatorSettings>>,
    pub http_client: Arc<Client>,
    pub api_client: Arc<YoudaoClient>,
    pub text_translator: Arc<TextTranslator>,
    pub translation_cache: Arc<RwLock<HashMap<String, String>>>,
    pub capture_in_progress: Arc<RwLock<bool>>,
    pub capture_session: Arc<RwLock<Option<ActiveCaptureSession>>>,
    pub capture_mode: Arc<RwLock<CaptureMode>>,
    pub overlay_payload: Arc<RwLock<Option<OverlayPayload>>>,
    pub live_frames: Arc<RwLock<LiveFrameStore>>,
    pub live_runtime: Arc<RwLock<LiveRuntime>>,
}

impl SharedState {
    pub fn new(
        config_store: ConfigStore,
        settings: TranslatorSettings,
        http_client: Arc<Client>,
        api_client: YoudaoClient,
        text_translator: TextTranslator,
    ) -> Self {
        Self {
            config_store: Arc::new(config_store),
            settings: Arc::new(RwLock::new(settings)),
            http_client,
            api_client: Arc::new(api_client),
            text_translator: Arc::new(text_translator),
            translation_cache: Arc::new(RwLock::new(HashMap::new())),
            capture_in_progress: Arc::new(RwLock::new(false)),
            capture_session: Arc::new(RwLock::new(None)),
            capture_mode: Arc::new(RwLock::new(CaptureMode::default())),
            overlay_payload: Arc::new(RwLock::new(None)),
            live_frames: Arc::new(RwLock::new(LiveFrameStore::default())),
            live_runtime: Arc::new(RwLock::new(LiveRuntime::default())),
        }
    }
}
