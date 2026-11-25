pub mod capture;
pub mod commands;
pub mod config;
pub mod error;
pub mod models;
pub mod popup_shortcut;
pub mod self_test;
pub mod startup;
pub mod state;
pub mod translators;

use std::path::PathBuf;

use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_autostart::MacosLauncher;
use tracing_subscriber::EnvFilter;

use crate::config::ConfigStore;
use crate::models::TranslatorSettings;
use crate::state::SharedState;
use crate::translators::{
    bing::BingTranslateClient, builtin::BuiltinTranslateClient, image_ocr::YoudaoClient,
    llm::LlmTranslateClient, TextTranslator,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    if self_test::should_run_capture_self_test() {
        match self_test::run_capture_self_test() {
            Ok(result) => {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result)
                        .expect("capture self test result should serialize")
                );
                return;
            }
            Err(err) => {
                eprintln!("capture self test failed: {err}");
                std::process::exit(1);
            }
        }
    }

    if self_test::should_run_capture_smoke_test() {
        match self_test::run_capture_smoke_test() {
            Ok(result) => {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result)
                        .expect("capture smoke test result should serialize")
                );
                return;
            }
            Err(err) => {
                eprintln!("capture smoke test failed: {err}");
                std::process::exit(1);
            }
        }
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !startup::is_silent_launch(args) {
                show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![startup::SILENT_START_ARG]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let base_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from(".").join(".livelens"));

            let app_handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let config_store = ConfigStore::new(base_dir);
                config_store.ensure().await?;
                let settings = config_store
                    .load_settings()
                    .await
                    .unwrap_or_else(|_| TranslatorSettings::default());

                commands::settings::apply_autostart(&app_handle, settings.autostart);
                commands::settings::apply_hotkey(&app_handle, &settings.hotkey);
                if let Some(ref popup) = settings.popup_shortcut {
                    commands::settings::apply_popup_shortcut(&app_handle, popup);
                }
                commands::settings::apply_copy_hotkey(&app_handle, &settings.copy_hotkey);

                let mut general_headers = reqwest::header::HeaderMap::new();
                general_headers.insert(reqwest::header::ACCEPT, "*/*".parse().unwrap());
                general_headers.insert(
                    reqwest::header::ACCEPT_LANGUAGE,
                    "zh-CN,zh;q=0.9,en;q=0.8".parse().unwrap(),
                );

                let general_http = std::sync::Arc::new(
                    reqwest::Client::builder()
                        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                        .default_headers(general_headers)
                        .build()?,
                );

                let mut bing_headers = reqwest::header::HeaderMap::new();
                bing_headers.insert(
                    reqwest::header::ACCEPT,
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                        .parse()
                        .unwrap(),
                );
                bing_headers.insert(
                    reqwest::header::ACCEPT_LANGUAGE,
                    "zh-CN,zh;q=0.9,en;q=0.8".parse().unwrap(),
                );
                bing_headers.insert(
                    reqwest::header::ORIGIN,
                    "https://cn.bing.com".parse().unwrap(),
                );

                let bing_http = std::sync::Arc::new(
                    reqwest::Client::builder()
                        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                        .default_headers(bing_headers)
                        .redirect(reqwest::redirect::Policy::none())
                        .build()?,
                );

                let api_client = YoudaoClient::new(general_http.clone());
                let bing_client = BingTranslateClient::new(bing_http);
                let builtin_client = BuiltinTranslateClient::new();
                let llm_client = LlmTranslateClient::new(general_http);
                let text_translator = TextTranslator::new(bing_client, builtin_client, llm_client);
                app_handle.manage(SharedState::new(
                    config_store,
                    settings,
                    api_client,
                    text_translator,
                ));
                Ok::<(), error::AppError>(())
            })?;

            let icon = Image::from_bytes(include_bytes!("../icons/icon.png"))?;

            let show = MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("LiveLens · 幕译")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        show_main_window(app);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                        if button == tauri::tray::MouseButton::Left {
                            show_main_window(&tray.app_handle());
                        }
                    }
                })
                .build(app)?;

            let main_window = app.get_webview_window("main").unwrap();

            if startup::is_silent_launch(std::env::args_os()) {
                hide_main_window_to_background(app.handle());
            } else {
                show_main_window(app.handle());
            }

            let mw = main_window.clone();
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    hide_main_window_to_background(&mw.app_handle());
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::load_settings,
            commands::settings::save_settings,
            commands::history::list_history,
            commands::history::clear_history,
            commands::capture::begin_capture,
            commands::capture::begin_copy_capture,
            commands::capture::cancel_capture,
            commands::capture::load_capture_payload,
            commands::capture::submit_capture_selection,
            commands::capture::get_screen_capture_permission_status,
            commands::capture::reset_screen_capture_permission,
            commands::capture::open_screen_capture_settings,
            commands::overlay::show_overlay,
            commands::overlay::load_overlay_payload,
            commands::overlay::close_overlay,
            commands::translate::translate_text,
            commands::window::resize_main_window,
            commands::window::hide_window,
            commands::window::capture_debug_log
        ])
        .build(tauri::generate_context!())
        .expect("failed to build tauri app");

    app.run(|_app_handle, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            show_main_window(_app_handle);
        }
    });
}

pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_dock_visibility(true);

    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(target_os = "macos")]
fn hide_main_window_to_background(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    let _ = app.set_dock_visibility(false);
}

#[cfg(not(target_os = "macos"))]
fn hide_main_window_to_background(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}
