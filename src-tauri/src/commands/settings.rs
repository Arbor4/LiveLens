use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::error::AppResult;
use crate::models::TranslatorSettings;
use crate::state::SharedState;

#[tauri::command]
pub async fn load_settings(state: State<'_, SharedState>) -> AppResult<TranslatorSettings> {
    Ok(state.settings.read().await.clone())
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    state: State<'_, SharedState>,
    settings: TranslatorSettings,
) -> AppResult<TranslatorSettings> {
    let old = state.settings.read().await.clone();
    state.config_store.save_settings(&settings).await?;
    *state.settings.write().await = settings.clone();

    if settings.autostart != old.autostart {
        apply_autostart(&app, settings.autostart);
    }
    if settings.hotkey != old.hotkey {
        unregister_hotkey(&app, &old.hotkey);
        apply_hotkey(&app, &settings.hotkey);
    }
    if settings.popup_shortcut != old.popup_shortcut {
        if let Some(ref old_shortcut) = old.popup_shortcut {
            unregister_hotkey(&app, old_shortcut);
        }
        if let Some(ref new_shortcut) = settings.popup_shortcut {
            apply_popup_shortcut(&app, new_shortcut);
        }
    }
    if settings.copy_hotkey != old.copy_hotkey {
        unregister_copy_hotkey(&app, &old.copy_hotkey);
        apply_copy_hotkey(&app, &settings.copy_hotkey);
    }

    Ok(settings)
}

pub fn apply_autostart(app: &AppHandle, enable: bool) {
    let manager = app.autolaunch();
    if enable {
        if let Err(e) = manager.enable() {
            tracing::warn!("autostart enable failed: {e}");
        }
    } else if let Err(e) = manager.disable() {
        tracing::warn!("autostart disable failed: {e}");
    }
}

pub fn apply_hotkey(app: &AppHandle, hotkey: &str) {
    if hotkey.is_empty() {
        return;
    }
    tracing::info!("registering global shortcut: '{hotkey}'");
    let app_clone = app.clone();
    if let Err(e) = app
        .global_shortcut()
        .on_shortcut(hotkey, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let app2 = app_clone.clone();
                tauri::async_runtime::spawn(async move {
                    let state: State<'_, SharedState> = app2.state();
                    let _ = crate::commands::capture::begin_capture(app2.clone(), state).await;
                });
            }
        })
    {
        tracing::warn!("global shortcut register failed for '{hotkey}': {e}");
    }
}

fn unregister_hotkey(app: &AppHandle, hotkey: &str) {
    if hotkey.is_empty() {
        return;
    }
    if let Err(e) = app.global_shortcut().unregister(hotkey) {
        tracing::warn!("global shortcut unregister failed for '{hotkey}': {e}");
    }
}

pub fn apply_popup_shortcut(app: &AppHandle, shortcut: &str) {
    if shortcut.is_empty() {
        return;
    }
    tracing::info!("registering popup shortcut: '{shortcut}'");
    let app_clone = app.clone();
    if let Err(e) = app
        .global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let app2 = app_clone.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::commands::window::toggle_main_window_from_popup_shortcut(&app2);
                });
            }
        })
    {
        tracing::warn!("popup shortcut register failed for '{shortcut}': {e}");
    }
}

pub fn apply_copy_hotkey(app: &AppHandle, hotkey: &str) {
    if hotkey.is_empty() {
        return;
    }
    tracing::info!("registering copy shortcut: '{hotkey}'");
    let app_clone = app.clone();
    if let Err(e) = app
        .global_shortcut()
        .on_shortcut(hotkey, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let app2 = app_clone.clone();
                tauri::async_runtime::spawn(async move {
                    let state: State<'_, SharedState> = app2.state();
                    let _ = crate::commands::capture::begin_copy_capture(app2.clone(), state).await;
                });
            }
        })
    {
        tracing::warn!("copy shortcut register failed for '{hotkey}': {e}");
    }
}

fn unregister_copy_hotkey(app: &AppHandle, hotkey: &str) {
    if hotkey.is_empty() {
        return;
    }
    if let Err(e) = app.global_shortcut().unregister(hotkey) {
        tracing::warn!("copy shortcut unregister failed for '{hotkey}': {e}");
    }
}
