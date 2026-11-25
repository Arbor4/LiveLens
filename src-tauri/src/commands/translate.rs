use tauri::State;

use crate::error::AppResult;
use crate::models::{ProxyMode, TextTranslationResult};
use crate::state::SharedState;
use crate::translators::builtin::{normalize_proxy, system_proxy_url};

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
