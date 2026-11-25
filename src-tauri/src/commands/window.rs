use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "macos")]
use crate::capture::screen as capture;
use crate::error::AppResult;
use crate::popup_shortcut::{decide_popup_shortcut_action, PopupShortcutAction};

const FOCUS_TEXT_INPUT_EVENT: &str = "main:focus-text-input";
const WIN_WIDTH: f64 = 520.0;

#[tauri::command]
pub async fn resize_main_window(app: AppHandle, height: f64) -> AppResult<()> {
    if let Some(w) = app.get_webview_window("main") {
        use tauri::LogicalSize;
        let width = w
            .inner_size()
            .ok()
            .and_then(|physical| w.scale_factor().ok().map(|s| physical.width as f64 / s))
            .filter(|w| *w > 0.0)
            .unwrap_or(WIN_WIDTH);
        let _ = w.set_size(LogicalSize::new(width, height));
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_window(app: AppHandle) -> AppResult<()> {
    if let Some(w) = app.get_webview_window("main") {
        instant_hide(&w);
    }
    #[cfg(target_os = "macos")]
    app.set_dock_visibility(false)?;
    Ok(())
}

pub(crate) fn instant_hide(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowAnimationBehavior};
        if let Ok(raw) = window.ns_window() {
            unsafe {
                let ns_window: &NSWindow = &*raw.cast();
                // 2 is NSWindowAnimationBehaviorNone
                ns_window.setAnimationBehavior(NSWindowAnimationBehavior(2));
            }
        }
    }
    let _ = window.hide();
}

pub(crate) fn hide_main_window_before_capture(app: &AppHandle) -> bool {
    if let Some(main_window) = app.get_webview_window("main") {
        let was_visible = main_window.is_visible().unwrap_or(false);
        if was_visible {
            instant_hide(&main_window);
        }
        was_visible
    } else {
        false
    }
}

pub(crate) fn toggle_main_window_from_popup_shortcut(app: &AppHandle) -> AppResult<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let is_visible = window.is_visible().unwrap_or(false);
    match decide_popup_shortcut_action(is_visible) {
        PopupShortcutAction::HideWindow => {
            instant_hide(&window);
            #[cfg(target_os = "macos")]
            app.set_dock_visibility(false)?;
        }
        PopupShortcutAction::ShowWindowAndFocusInput => {
            #[cfg(target_os = "macos")]
            app.set_dock_visibility(true)?;
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            app.emit_to("main", FOCUS_TEXT_INPUT_EVENT, serde_json::json!({}))?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn capture_debug_log(message: String) -> AppResult<()> {
    let _ = &message;
    #[cfg(target_os = "macos")]
    capture::debug_log(format!("[timeline][ui] {message}"));
    Ok(())
}
