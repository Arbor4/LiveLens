use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, State, WebviewUrl,
    WebviewWindowBuilder,
};

use crate::error::AppResult;
use crate::models::OverlayPayload;
use crate::state::SharedState;

pub(crate) const OVERLAY_WINDOW_LABEL: &str = "overlay";

#[tauri::command]
pub async fn show_overlay(
    app: AppHandle,
    state: State<'_, SharedState>,
    payload: OverlayPayload,
) -> AppResult<()> {
    *state.overlay_payload.write().await = Some(payload.clone());
    create_overlay_window(
        &app,
        payload.selection.monitor_x,
        payload.selection.monitor_y,
        payload.selection.monitor_width,
        payload.selection.monitor_height,
    )?;
    Ok(())
}

#[tauri::command]
pub async fn load_overlay_payload(state: State<'_, SharedState>) -> AppResult<OverlayPayload> {
    state
        .overlay_payload
        .read()
        .await
        .clone()
        .ok_or_else(|| tauri::Error::AssetNotFound("overlay payload missing".into()).into())
}

#[tauri::command]
pub async fn close_overlay(app: AppHandle, state: State<'_, SharedState>) -> AppResult<()> {
    *state.overlay_payload.write().await = None;
    if let Some(w) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        w.close()?;
    }
    Ok(())
}

fn create_overlay_window(
    app: &AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> AppResult<()> {
    if let Some(w) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        w.set_position(Position::Physical(PhysicalPosition::new(x, y)))?;
        w.set_size(Size::Physical(PhysicalSize::new(width, height)))?;
        w.show()?;
        w.set_focus()?;
        return Ok(());
    }

    let url = WebviewUrl::App("overlay.html".into());
    let window = WebviewWindowBuilder::new(app, OVERLAY_WINDOW_LABEL, url)
        .title("LiveLens Overlay")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(true)
        .visible(false)
        .position(0.0, 0.0)
        .inner_size(100.0, 100.0)
        .build()?;
    window.set_position(Position::Physical(PhysicalPosition::new(x, y)))?;
    window.set_size(Size::Physical(PhysicalSize::new(width, height)))?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}
