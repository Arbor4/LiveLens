use tauri::State;

use crate::error::AppResult;
use crate::models::{LlmConfig, ProxyMode, TextTranslationResult};
use crate::state::SharedState;
use crate::translators::builtin::{normalize_proxy, system_proxy_url};
use crate::translators::ocr;

#[tauri::command]
pub async fn translate_text(
    state: State<'_, SharedState>,
    text: String,
    from_lang: String,
    to_lang: String,
) -> AppResult<TextTranslationResult> {
    let (engine, llm_config, proxy_url) = {
        let settings = state.settings.read().await;
        let proxy_url = match settings.proxy_mode {
            ProxyMode::None => None,
            ProxyMode::System => system_proxy_url(),
            ProxyMode::Custom => normalize_proxy(&settings.custom_proxy),
        };
        (
            settings.text_translate_engine,
            settings.llm_config.clone(),
            proxy_url,
        )
    };
    state
        .text_translator
        .translate(
            &text,
            &from_lang,
            &to_lang,
            engine,
            &llm_config,
            proxy_url.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn test_llm_connection(
    state: State<'_, SharedState>,
    llm_config: Option<LlmConfig>,
) -> AppResult<String> {
    let config = match llm_config {
        Some(cfg) => cfg,
        None => state.settings.read().await.llm_config.clone(),
    };
    state.text_translator.test_llm_connection(&config).await
}

#[tauri::command]
pub async fn test_rapid_ocr_connection(
    state: State<'_, SharedState>,
    rapid_ocr_url: Option<String>,
) -> AppResult<String> {
    let url = match rapid_ocr_url {
        Some(u) => u,
        None => state.settings.read().await.rapid_ocr_url.clone(),
    };
    ocr::test_rapid_ocr_connection(&state.http_client, &url).await
}
