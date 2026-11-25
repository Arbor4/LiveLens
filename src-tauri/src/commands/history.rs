use tauri::State;

use crate::error::AppResult;
use crate::models::{HistoryQuery, TranslationHistoryItem};
use crate::state::SharedState;

#[tauri::command]
pub async fn list_history(
    state: State<'_, SharedState>,
    query: Option<HistoryQuery>,
) -> AppResult<Vec<TranslationHistoryItem>> {
    let mut items = state.config_store.load_history().await?;
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    if let Some(query) = query {
        if let Some(limit) = query.limit {
            items.truncate(limit);
        }
    }
    Ok(items)
}

#[tauri::command]
pub async fn clear_history(state: State<'_, SharedState>) -> AppResult<()> {
    state.config_store.save_history(&[]).await
}
