use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use std::sync::mpsc;
#[cfg(target_os = "macos")]
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(target_os = "macos")]
use tauri::{PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl, WebviewWindowBuilder};

#[cfg(not(target_os = "macos"))]
use crate::capture::native_window::{self as capture_window, CaptureCommand, CaptureEvent};
#[cfg(target_os = "macos")]
use crate::capture::native_window as capture_window;
use crate::capture::screen as capture;
use crate::commands::overlay::OVERLAY_WINDOW_LABEL;
use crate::commands::window::hide_main_window_before_capture;
use crate::error::{AppError, AppResult};
use crate::models::{
    CaptureMode, CaptureRect, CaptureTranslatePayload, CaptureViewPayload, ImageTranslateMode,
    OcrTextResult, OverlayRegion, ScreenCapturePermissionStatus, SelectionPayload,
    TranslationHistoryItem, TranslationPair,
};
use crate::state::{ActiveCaptureSession, SharedState};
use crate::translators::ocr;

const CAPTURE_WINDOW_LABEL: &str = "capture";

#[tauri::command]
pub async fn get_screen_capture_permission_status() -> AppResult<ScreenCapturePermissionStatus> {
    #[cfg(target_os = "macos")]
    {
        return Ok(ScreenCapturePermissionStatus {
            supported: true,
            granted: capture::check_screen_capture_permission(),
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(ScreenCapturePermissionStatus {
            supported: false,
            granted: true,
        })
    }
}

#[tauri::command]
pub async fn reset_screen_capture_permission(app: AppHandle) -> AppResult<bool> {
    #[cfg(target_os = "macos")]
    {
        let bundle_id = app.config().identifier.clone();
        tokio::task::spawn_blocking(move || {
            capture::reset_screen_capture_permission(&bundle_id)?;
            capture::relaunch_for_screen_permission()
        })
        .await
        .map_err(|e| AppError::Capture(format!("reset permission task failed: {e}")))??;

        // macOS TCC caches per-process ScreenCapture registration; exit so the freshly
        // relaunched process can re-register LiveLens in System Settings immediately.
        let app_to_exit = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            app_to_exit.exit(0);
        });
        return Ok(false);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(true)
    }
}

#[tauri::command]
pub async fn open_screen_capture_settings() -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(capture::open_screen_capture_settings)
            .await
            .map_err(|e| AppError::Capture(format!("open settings task failed: {e}")))??;
    }
    Ok(())
}

#[tauri::command]
pub async fn begin_capture(app: AppHandle, state: State<'_, SharedState>) -> AppResult<()> {
    begin_capture_with_mode(app, state, CaptureMode::Translate).await
}

#[tauri::command]
pub async fn begin_copy_capture(app: AppHandle, state: State<'_, SharedState>) -> AppResult<()> {
    begin_capture_with_mode(app, state, CaptureMode::CopyText).await
}

async fn begin_capture_with_mode(
    app: AppHandle,
    state: State<'_, SharedState>,
    mode: CaptureMode,
) -> AppResult<()> {
    let mut capture_in_progress = state.capture_in_progress.write().await;
    if *capture_in_progress {
        return Err(AppError::Capture(
            "a capture session is already running".into(),
        ));
    }
    *capture_in_progress = true;
    drop(capture_in_progress);

    *state.capture_mode.write().await = mode;

    let result = begin_capture_impl(&app, state.inner()).await;
    if let Err(ref err) = result {
        reset_capture_state(state.inner()).await;
        let message = err.to_string();
        emit_workflow_state(&app, &message, "error", false).ok();
        if message.contains("屏幕录制权限") || message.contains("screencapture") {
            crate::show_main_window(&app);
        }
    }
    result
}

async fn begin_capture_impl(app: &AppHandle, state: &SharedState) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    capture::ensure_screen_capture_permission()?;

    if let Some(w) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        let _ = w.close();
    }

    #[cfg(target_os = "macos")]
    {
        let dir = capture::debug_reset_dir()?;
        capture::debug_log(format!("[begin] debug dir={}", dir.display()));
    }

    let t0 = std::time::Instant::now();
    #[cfg(target_os = "macos")]
    capture_timeline(&t0, "begin_capture_impl entered");

    let restore_main_window = hide_main_window_before_capture(app);

    #[cfg(target_os = "macos")]
    capture_timeline(&t0, "main window hidden");

    #[cfg(target_os = "macos")]
    {
        let monitor = tokio::task::spawn_blocking(capture::find_cursor_monitor)
            .await
            .map_err(|e| AppError::Capture(format!("find monitor task failed: {e}")))??;

        tracing::info!(
            "[PERF] find_cursor_monitor: {:?} (scale={})",
            t0.elapsed(),
            monitor.scale_factor
        );
        capture::debug_log(format!(
            "[begin] cursor monitor x={} y={} width={} height={} scale_factor={} display_id={}",
            monitor.x, monitor.y, monitor.width, monitor.height, monitor.scale_factor, monitor.display_id
        ));
        capture_timeline(&t0, "cursor monitor resolved");

        let scale_factor = monitor.scale_factor;
        let display_id = monitor.display_id;
        let monitor_for_capture = monitor;

        let captured = tokio::task::spawn_blocking(move || {
            capture::capture_monitor_with_preview(&monitor_for_capture)
        })
        .await
        .map_err(|e| AppError::Capture(format!("capture task failed: {e}")))??;
        let rgba = captured.rgba_bytes;
        let w = captured.width;
        let h = captured.height;
        let windows = capture::list_capture_windows(&monitor, w, h);

        tracing::info!(
            "[PERF] capture_to_memory: {:?} | {}x{} ({:.1} MB RGBA)",
            t0.elapsed(),
            w,
            h,
            rgba.len() as f64 / 1_048_576.0
        );
        capture::debug_log(format!(
            "[begin] capture_to_memory -> {}x{} rgba_bytes={} scale_factor={}",
            w,
            h,
            rgba.len(),
            scale_factor
        ));
        capture_timeline(&t0, format!("screen capture ready {}x{}", w, h));

        let preview_started = std::time::Instant::now();
        let (preview_image_base64, preview_image_mime) =
            build_capture_preview_base64(captured.preview_bytes, captured.preview_mime);
        capture::debug_log(format!(
            "[preview] ready after {:?}",
            preview_started.elapsed()
        ));
        capture_timeline(
            &t0,
            format!(
                "preview payload ready mime={} base64_chars={}",
                preview_image_mime,
                preview_image_base64.len()
            ),
        );

        let window_x = ((monitor.x as f64) * scale_factor).round() as i32;
        let window_y = ((monitor.y as f64) * scale_factor).round() as i32;
        let window_width = w;
        let window_height = h;
        let monitor_logical_bounds = (
            monitor.x as f64,
            monitor.y as f64,
            monitor.width as f64,
            monitor.height as f64,
        );

        capture::debug_log(format!(
            "[begin] opening capture window physical x={} y={} width={} height={} logical={}x{}",
            window_x, window_y, window_width, window_height, monitor.width, monitor.height
        ));

        *state.capture_session.write().await = Some(ActiveCaptureSession {
            rgba,
            img_w: w,
            img_h: h,
            scale_factor,
            monitor_x: monitor.x,
            monitor_y: monitor.y,
            monitor_width: monitor.width,
            monitor_height: monitor.height,
            display_id,
            preview_image_base64: Some(preview_image_base64),
            preview_image_mime,
            windows,
            restore_main_window,
        });
        capture_timeline(&t0, "capture session stored");

        create_capture_window(
            app,
            window_x,
            window_y,
            window_width,
            window_height,
            monitor_logical_bounds,
        )?;
        capture_timeline(&t0, "capture window created");
        emit_workflow_state(app, capture_prompt_message(state).await, "", false)?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let result = tokio::task::spawn_blocking(capture::find_cursor_monitor)
            .await
            .map_err(|e| AppError::Capture(format!("find monitor task failed: {e}")))??;

        let monitor = result.monitor;
        tracing::info!(
            "[PERF] find_cursor_monitor: {:?} (scale={})",
            t0.elapsed(),
            monitor.scale_factor
        );

        let scale_factor = monitor.scale_factor;
        let screen = result.screen;

        let (rgba, w, h) =
            tokio::task::spawn_blocking(move || capture::capture_screen_to_memory(screen))
                .await
                .map_err(|e| AppError::Capture(format!("capture task failed: {e}")))??;

        tracing::info!(
            "[PERF] capture_to_memory: {:?} | {}x{} ({:.1} MB RGBA)",
            t0.elapsed(),
            w,
            h,
            rgba.len() as f64 / 1_048_576.0
        );

        *state.capture_session.write().await = Some(ActiveCaptureSession {
            rgba: rgba.clone(),
            img_w: w,
            img_h: h,
            scale_factor,
            monitor_x: monitor.x,
            monitor_y: monitor.y,
            monitor_width: monitor.width,
            monitor_height: monitor.height,
            preview_image_base64: None,
            preview_image_mime: String::new(),
            windows: Vec::new(),
            restore_main_window,
        });

        let (event_tx, event_rx) = mpsc::channel::<CaptureEvent>();
        capture_window::start_capture(
            rgba.clone(),
            w,
            h,
            scale_factor,
            monitor.x,
            monitor.y,
            event_tx,
        );
        tracing::info!("[PERF] start_capture_native: {:?}", t0.elapsed());

        let state_clone = state.clone();
        let app_clone = app.clone();
        tokio::spawn(async move {
            handle_capture_events(event_rx, rgba, w, scale_factor, state_clone, app_clone).await;
        });
    }

    #[cfg(not(target_os = "macos"))]
    emit_workflow_state(app, capture_prompt_message(state).await, "", false)?;
    Ok(())
}

async fn capture_prompt_message(state: &SharedState) -> &'static str {
    match *state.capture_mode.read().await {
        CaptureMode::CopyText => "请框选需要复制的文字",
        CaptureMode::Translate => "请框选需要翻译的区域",
    }
}

#[tauri::command]
pub async fn load_capture_payload(state: State<'_, SharedState>) -> AppResult<CaptureViewPayload> {
    let guard = state.capture_session.read().await;
    let session = guard
        .as_ref()
        .ok_or_else(|| AppError::Capture("capture payload missing".into()))?;

    let image_base64 = session
        .preview_image_base64
        .clone()
        .ok_or_else(|| AppError::Capture("capture preview not ready".into()))?;

    #[cfg(target_os = "macos")]
    capture::debug_log(format!(
        "[timeline][backend] load_capture_payload ready mime={} size={}x{} base64_chars={}",
        session.preview_image_mime,
        session.img_w,
        session.img_h,
        image_base64.len()
    ));

    Ok(CaptureViewPayload {
        image_base64,
        image_mime: session.preview_image_mime.clone(),
        image_width: session.img_w,
        image_height: session.img_h,
        copy_text_mode: *state.capture_mode.read().await == CaptureMode::CopyText,
        windows: session.windows.clone(),
    })
}

#[tauri::command]
pub async fn submit_capture_selection(
    app: AppHandle,
    state: State<'_, SharedState>,
    selection: CaptureRect,
    mode: Option<String>,
) -> AppResult<CaptureTranslatePayload> {
    if selection.width <= 4 || selection.height <= 4 {
        return Err(AppError::Capture("selection too small".into()));
    }

    let effective_mode = match mode.as_deref() {
        Some("copy_text") => CaptureMode::CopyText,
        Some("translate") => CaptureMode::Translate,
        _ => *state.capture_mode.read().await,
    };

    if effective_mode == CaptureMode::CopyText {
        emit_workflow_state(&app, "正在识别文字…", "", true).ok();

        let result = async {
            let (crop, scale_factor) = {
                let guard = state.capture_session.read().await;
                let session = guard
                    .as_ref()
                    .ok_or_else(|| AppError::Capture("capture session missing".into()))?;
                (
                    capture_window::crop_rgba(
                        &session.rgba,
                        session.img_w,
                        selection.x,
                        selection.y,
                        selection.width,
                        selection.height,
                    ),
                    session.scale_factor,
                )
            };

            let png_bytes = encode_cropped_png(crop, selection.width, selection.height).await?;
            let ocr_result =
                ocr_extract_text(state.inner(), png_bytes, &selection, scale_factor).await?;
            Ok::<OcrTextResult, AppError>(ocr_result)
        }
        .await;

        match result {
            Ok(ocr_result) => {
                emit_workflow_state(&app, "识别完成", "ok", false).ok();
                Ok(CaptureTranslatePayload {
                    image_base64: String::new(),
                    selection,
                    regions: Vec::new(),
                    image_width: selection.width,
                    image_height: selection.height,
                    recognized_text: Some(ocr_result.text),
                })
            }
            Err(err) => {
                #[cfg(target_os = "macos")]
                capture::debug_log(format!("[select] ocr error={err}"));
                emit_workflow_state(&app, "识别失败", "error", false).ok();
                Err(err)
            }
        }
    } else {
        emit_workflow_state(&app, "正在翻译…", "", true).ok();

        let result = async {
            let (crop, scale_factor) = {
                let guard = state.capture_session.read().await;
                let session = guard
                    .as_ref()
                    .ok_or_else(|| AppError::Capture("capture session missing".into()))?;

                #[cfg(target_os = "macos")]
                capture::debug_log(format!(
                    "[select] x={} y={} width={} height={} source_image={}x{} scale_factor={}",
                    selection.x,
                    selection.y,
                    selection.width,
                    selection.height,
                    session.img_w,
                    session.img_h,
                    session.scale_factor
                ));

                (
                    capture_window::crop_rgba(
                        &session.rgba,
                        session.img_w,
                        selection.x,
                        selection.y,
                        selection.width,
                        selection.height,
                    ),
                    session.scale_factor,
                )
            };

            let png_bytes = encode_cropped_png(crop.clone(), selection.width, selection.height).await?;
            #[cfg(target_os = "macos")]
            capture::debug_write_bytes("03_crop.png", &png_bytes);
            let (image_base64, regions) =
                translate_capture_png(state.inner(), &crop, png_bytes, &selection, scale_factor)
                    .await?;

            Ok::<CaptureTranslatePayload, AppError>(CaptureTranslatePayload {
                image_base64,
                selection,
                regions,
                image_width: selection.width,
                image_height: selection.height,
                recognized_text: None,
            })
        }
        .await;

        match result {
            Ok(payload) => {
                emit_workflow_state(&app, "翻译完成", "ok", false).ok();
                Ok(payload)
            }
            Err(err) => {
                #[cfg(target_os = "macos")]
                capture::debug_log(format!("[select] error={err}"));
                emit_workflow_state(&app, "翻译失败", "error", false).ok();
                Err(err)
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
async fn handle_capture_events(
    event_rx: mpsc::Receiver<CaptureEvent>,
    rgba: Vec<u8>,
    img_w: u32,
    scale_factor: f64,
    state: SharedState,
    app: AppHandle,
) {
    let rx = std::sync::Arc::new(std::sync::Mutex::new(event_rx));

    loop {
        let rx_clone = rx.clone();
        let event = tokio::task::spawn_blocking(move || rx_clone.lock().unwrap().recv()).await;

        let event = match event {
            Ok(Ok(e)) => e,
            _ => break,
        };

        match event {
            CaptureEvent::Selection { x, y, w, h } => {
                let mode = *state.capture_mode.read().await;

                if mode == CaptureMode::CopyText {
                    emit_workflow_state(&app, "正在识别文字…", "", true).ok();
                    let _ = capture_window::capture_proxy().send_event(CaptureCommand::ShowLoading);

                    let crop = capture_window::crop_rgba(&rgba, img_w, x, y, w, h);
                    let rect = CaptureRect {
                        x,
                        y,
                        width: w,
                        height: h,
                    };

                    let png_bytes = match encode_cropped_png(crop, w, h).await {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            tracing::error!("PNG encode failed: {e}");
                            emit_workflow_state(&app, "截图编码失败", "error", false).ok();
                            continue;
                        }
                    };

                    match ocr_extract_text(&state, png_bytes, &rect, scale_factor).await {
                        Ok(ocr_result) => {
                            if let Err(e) = copy_to_clipboard(&ocr_result.text) {
                                tracing::warn!("clipboard copy failed: {e}");
                            }
                            let _ =
                                capture_window::capture_proxy().send_event(CaptureCommand::Close);
                            emit_workflow_state(&app, "", "", false).ok();
                        }
                        Err(e) => {
                            tracing::error!("OCR error: {e}");
                            emit_workflow_state(&app, "识别失败", "error", false).ok();
                            let _ =
                                capture_window::capture_proxy().send_event(CaptureCommand::Close);
                            break;
                        }
                    }
                } else {
                    emit_workflow_state(&app, "正在翻译…", "", true).ok();
                    let _ = capture_window::capture_proxy().send_event(CaptureCommand::ShowLoading);

                    let crop = capture_window::crop_rgba(&rgba, img_w, x, y, w, h);
                    let rect = CaptureRect {
                        x,
                        y,
                        width: w,
                        height: h,
                    };

                    let png_bytes = match encode_cropped_png(crop.clone(), w, h).await {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            tracing::error!("PNG encode failed: {e}");
                            emit_workflow_state(&app, "截图编码失败", "error", false).ok();
                            continue;
                        }
                    };

                    match translate_capture_png(&state, &crop, png_bytes, &rect, scale_factor).await {
                        Ok((image_base64, _regions)) => {
                            if !image_base64.is_empty() {
                                match BASE64_STANDARD.decode(&image_base64) {
                                    Ok(jpeg_bytes) => {
                                        let rgba_result = tokio::task::spawn_blocking(move || {
                                            decode_jpeg_to_rgba(&jpeg_bytes)
                                        })
                                        .await;

                                        match rgba_result {
                                            Ok(Ok((result_rgba, rw, rh))) => {
                                                let _ = capture_window::capture_proxy().send_event(
                                                    CaptureCommand::ShowResult {
                                                        rgba_bytes: result_rgba,
                                                        x,
                                                        y,
                                                        w: rw,
                                                        h: rh,
                                                    },
                                                );
                                            }
                                            Ok(Err(e)) => tracing::warn!("JPEG decode: {e}"),
                                            Err(e) => tracing::warn!("spawn_blocking JPEG: {e}"),
                                        }
                                    }
                                    Err(e) => tracing::warn!("base64 decode: {e}"),
                                }
                            }

                            emit_workflow_state(&app, "翻译完成", "ok", false).ok();
                        }
                        Err(e) => {
                            tracing::error!("Translation error: {e}");
                            emit_workflow_state(&app, "翻译失败", "error", false).ok();
                            let _ =
                                capture_window::capture_proxy().send_event(CaptureCommand::Close);
                            break;
                        }
                    }
                }
            }
            CaptureEvent::Cancelled => break,
        }
    }

    restore_main_window_if_needed(&app, &state).await;
    reset_capture_state(&state).await;
    emit_workflow_state(&app, "", "", false).ok();
}

#[tauri::command]
pub async fn cancel_capture(app: AppHandle, state: State<'_, SharedState>) -> AppResult<()> {
    restore_main_window_if_needed(&app, state.inner()).await;
    #[cfg(target_os = "macos")]
    capture::debug_log("[cancel] capture cancelled");

    reset_capture_state(state.inner()).await;

    let _ = close_capture_window(&app);
    #[cfg(not(target_os = "macos"))]
    let _ = capture_window::capture_proxy().send_event(CaptureCommand::Close);

    emit_workflow_state(&app, "", "", false)?;
    Ok(())
}

fn close_capture_window(app: &AppHandle) -> AppResult<()> {
    if let Some(w) = app.get_webview_window(CAPTURE_WINDOW_LABEL) {
        w.hide()?;
    }
    Ok(())
}

async fn reset_capture_state(state: &SharedState) {
    #[cfg(target_os = "macos")]
    capture::debug_log("[state] reset capture state");
    *state.capture_in_progress.write().await = false;
    *state.capture_session.write().await = None;
    *state.capture_mode.write().await = CaptureMode::default();
}

async fn restore_main_window_if_needed(app: &AppHandle, state: &SharedState) {
    let should_restore = state
        .capture_session
        .read()
        .await
        .as_ref()
        .map(|session| session.restore_main_window)
        .unwrap_or(false);

    if should_restore {
        #[cfg(target_os = "macos")]
        let _ = app.set_dock_visibility(true);

        if let Some(main_window) = app.get_webview_window("main") {
            let _ = main_window.show();
            let _ = main_window.set_focus();
        }
    }
}

#[cfg(target_os = "macos")]
fn build_capture_preview_base64(preview_bytes: Vec<u8>, preview_mime: &str) -> (String, String) {
    let extension = preview_mime
        .split('/')
        .nth(1)
        .filter(|value| !value.is_empty())
        .unwrap_or("bin");
    capture::debug_write_bytes(&format!("02_preview.{extension}"), &preview_bytes);
    capture::debug_log(format!(
        "[preview] reused capture preview mime={} bytes={}",
        preview_mime,
        preview_bytes.len()
    ));
    (BASE64_STANDARD.encode(preview_bytes), preview_mime.to_string())
}

#[cfg(target_os = "macos")]
fn capture_timeline(started: &std::time::Instant, message: impl AsRef<str>) {
    capture::debug_log(format!(
        "[timeline][backend] +{}ms {}",
        started.elapsed().as_millis(),
        message.as_ref()
    ));
}

async fn encode_cropped_png(crop: Vec<u8>, w: u32, h: u32) -> AppResult<Vec<u8>> {
    tokio::task::spawn_blocking(move || capture_window::encode_png(&crop, w, h))
        .await
        .map_err(|e| AppError::Capture(format!("PNG encode task failed: {e}")))?
}

#[tauri::command]
pub async fn copy_capture_text(text: String) -> AppResult<()> {
    copy_to_clipboard(&text)
}

async fn translate_capture_png(
    state: &SharedState,
    crop_rgba: &[u8],
    png_bytes: Vec<u8>,
    rect: &CaptureRect,
    scale_factor: f64,
) -> AppResult<(String, Vec<OverlayRegion>)> {
    let (settings, monitor_x, monitor_y, monitor_width, monitor_height) = {
        let guard = state.capture_session.read().await;
        let session = guard
            .as_ref()
            .ok_or_else(|| AppError::Capture("capture session missing".into()))?;
        (
            state.settings.read().await.clone(),
            session.monitor_x,
            session.monitor_y,
            session.monitor_width,
            session.monitor_height,
        )
    };

    let selection = SelectionPayload {
        x: 0.0,
        y: 0.0,
        width: rect.width as f64,
        height: rect.height as f64,
        monitor_id: format!(
            "capture:{}:{}:{}:{}",
            rect.x, rect.y, rect.width, rect.height
        ),
        monitor_x,
        monitor_y,
        monitor_width,
        monitor_height,
        monitor_scale_factor: scale_factor,
    };

    if settings.image_translate_mode == ImageTranslateMode::Youdao {
        let response = state
            .api_client
            .translate_image_bytes(
                png_bytes,
                "capture.png".into(),
                "image/png".into(),
                settings.from_lang.clone(),
                settings.to_lang.clone(),
                selection,
                None,
                &settings,
            )
            .await?;

        tracing::info!(
            "API response: request_id={}, rendered_image len={}, regions={}",
            response.request_id,
            response.rendered_image_base64.len(),
            response.regions.len()
        );
        #[cfg(target_os = "macos")]
        capture::debug_log(format!(
            "[translate] request_id={} rendered_b64_len={} regions={}",
            response.request_id,
            response.rendered_image_base64.len(),
            response.regions.len()
        ));

        if let Ok(mut history) = state.config_store.load_history().await {
            history.push(response.history_item.clone());
            let _ = state.config_store.save_history(&history).await;
        }

        #[cfg(target_os = "macos")]
        if !response.rendered_image_base64.is_empty() {
            if let Ok(bytes) = BASE64_STANDARD.decode(&response.rendered_image_base64) {
                capture::debug_write_bytes("04_translated.jpg", &bytes);
            }
        }

        return Ok((response.rendered_image_base64, response.regions));
    }

    let lines = ocr::recognize_image_bytes(
        &state.http_client,
        settings.ocr_engine,
        &settings.rapid_ocr_url,
        png_bytes,
        &settings.from_lang,
    )
    .await?;
    let paragraphs = ocr::group_ocr_lines_into_paragraphs(lines);
    let regions = ocr::translate_paragraphs_to_regions(
        paragraphs,
        crop_rgba,
        rect.width,
        rect.height,
        &selection,
        &settings,
        &state.text_translator,
        &state.translation_cache,
    )
    .await?;

    let pairs = regions
        .iter()
        .map(|r| TranslationPair {
            source: r.source.clone(),
            target: r.translated.clone(),
        })
        .collect::<Vec<_>>();
    let history_item = TranslationHistoryItem::from_response(
        selection,
        uuid::Uuid::new_v4().to_string(),
        settings.from_lang.clone(),
        settings.to_lang.clone(),
        pairs,
    );
    if let Ok(mut history) = state.config_store.load_history().await {
        history.push(history_item);
        let _ = state.config_store.save_history(&history).await;
    }

    Ok((String::new(), regions))
}

async fn ocr_extract_text(
    state: &SharedState,
    png_bytes: Vec<u8>,
    rect: &CaptureRect,
    scale_factor: f64,
) -> AppResult<OcrTextResult> {
    let (settings, monitor_x, monitor_y, monitor_width, monitor_height) = {
        let guard = state.capture_session.read().await;
        let session = guard
            .as_ref()
            .ok_or_else(|| AppError::Capture("capture session missing".into()))?;
        (
            state.settings.read().await.clone(),
            session.monitor_x,
            session.monitor_y,
            session.monitor_width,
            session.monitor_height,
        )
    };

    if settings.image_translate_mode == ImageTranslateMode::OcrPipeline {
        let lines = ocr::recognize_image_bytes(
            &state.http_client,
            settings.ocr_engine,
            &settings.rapid_ocr_url,
            png_bytes,
            &settings.from_lang,
        )
        .await?;
        let paragraphs = ocr::group_ocr_lines_into_paragraphs(lines);
        let text = paragraphs
            .into_iter()
            .map(|p| p.text)
            .collect::<Vec<_>>()
            .join("\n");
        return Ok(OcrTextResult {
            text,
            request_id: uuid::Uuid::new_v4().to_string(),
            lan_from: settings.from_lang,
        });
    }

    let response = state
        .api_client
        .translate_image_bytes(
            png_bytes,
            "capture.png".into(),
            "image/png".into(),
            settings.from_lang.clone(),
            settings.to_lang.clone(),
            SelectionPayload {
                x: 0.0,
                y: 0.0,
                width: rect.width as f64,
                height: rect.height as f64,
                monitor_id: format!(
                    "capture:{}:{}:{}:{}",
                    rect.x, rect.y, rect.width, rect.height
                ),
                monitor_x,
                monitor_y,
                monitor_width,
                monitor_height,
                monitor_scale_factor: scale_factor,
            },
            None,
            &settings,
        )
        .await?;

    let text = response
        .regions
        .iter()
        .map(|r| r.source.as_str())
        .collect::<Vec<_>>()
        .join("\n");

    Ok(OcrTextResult {
        text,
        request_id: response.request_id,
        lan_from: response.lan_from,
    })
}

fn copy_to_clipboard(text: &str) -> AppResult<()> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| AppError::Capture(format!("clipboard init failed: {e}")))?;
    clipboard
        .set_text(text.to_owned())
        .map_err(|e| AppError::Capture(format!("clipboard set_text failed: {e}")))?;
    Ok(())
}

fn emit_workflow_state(app: &AppHandle, message: &str, kind: &str, busy: bool) -> AppResult<()> {
    app.emit_to(
        "main",
        "workflow:state",
        serde_json::json!({
            "message": message,
            "type": kind,
            "busy": busy,
        }),
    )?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn decode_jpeg_to_rgba(jpeg_bytes: &[u8]) -> AppResult<(Vec<u8>, u32, u32)> {
    use image::ImageReader;
    let img = ImageReader::new(std::io::Cursor::new(jpeg_bytes))
        .with_guessed_format()
        .map_err(|e| AppError::Capture(format!("image reader: {e}")))?
        .decode()
        .map_err(|e| AppError::Capture(format!("image decode: {e}")))?
        .into_rgba8();
    let w = img.width();
    let h = img.height();
    Ok((img.into_raw(), w, h))
}

#[cfg(target_os = "macos")]
fn create_capture_window(
    app: &AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    logical_bounds: (f64, f64, f64, f64),
) -> AppResult<()> {
    let t0 = std::time::Instant::now();

    if let Some(w) = app.get_webview_window(CAPTURE_WINDOW_LABEL) {
        w.set_position(Position::Physical(PhysicalPosition::new(x, y)))?;
        w.set_size(Size::Physical(PhysicalSize::new(width, height)))?;
        let _ = w.set_visible_on_all_workspaces(true);
        let _ = w.eval("window.location.reload()");
        w.show()?;
        configure_capture_window_macos(&w, logical_bounds)?;
        w.set_focus()?;
        capture::debug_log(format!(
            "[timeline][backend][window] +{}ms reused existing capture window",
            t0.elapsed().as_millis()
        ));
        return Ok(());
    }

    let url = WebviewUrl::App("capture.html".into());
    let window = WebviewWindowBuilder::new(app, CAPTURE_WINDOW_LABEL, url)
        .title("LiveLens Capture")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .focused(true)
        .visible(false)
        .position(0.0, 0.0)
        .inner_size(100.0, 100.0)
        .build()?;
    capture::debug_log(format!(
        "[timeline][backend][window] +{}ms builder finished",
        t0.elapsed().as_millis()
    ));
    window.set_position(Position::Physical(PhysicalPosition::new(x, y)))?;
    capture::debug_log(format!(
        "[timeline][backend][window] +{}ms position set x={} y={}",
        t0.elapsed().as_millis(),
        x,
        y
    ));
    window.set_size(Size::Physical(PhysicalSize::new(width, height)))?;
    capture::debug_log(format!(
        "[timeline][backend][window] +{}ms size set {}x{}",
        t0.elapsed().as_millis(),
        width,
        height
    ));
    let _ = window.set_visible_on_all_workspaces(true);
    capture::debug_log(format!(
        "[timeline][backend][window] +{}ms visible_on_all_workspaces set",
        t0.elapsed().as_millis()
    ));
    window.show()?;
    capture::debug_log(format!(
        "[timeline][backend][window] +{}ms window shown",
        t0.elapsed().as_millis()
    ));
    configure_capture_window_macos(&window, logical_bounds)?;
    window.set_focus()?;
    capture::debug_log(format!(
        "[timeline][backend][window] +{}ms window focused",
        t0.elapsed().as_millis()
    ));
    Ok(())
}

#[cfg(target_os = "macos")]
fn configure_capture_window_macos(
    window: &tauri::WebviewWindow,
    logical_bounds: (f64, f64, f64, f64),
) -> AppResult<()> {
    use core_graphics::display::CGDisplay;
    use objc2_app_kit::{NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior};

    let (tx, rx) = mpsc::sync_channel(1);
    let dispatcher = window.clone();
    let window = window.clone();
    let t0 = std::time::Instant::now();
    let (mon_x, mon_y, mon_w, mon_h) = logical_bounds;
    let main_bounds = CGDisplay::main().bounds();
    let appkit_x = mon_x;
    let appkit_y = main_bounds.origin.y + main_bounds.size.height - (mon_y + mon_h);

    dispatcher.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let raw = window.ns_window().map_err(|e| e.to_string())?;
            unsafe {
                let ns_window: &NSWindow = &*raw.cast();
                let mut behavior = ns_window.collectionBehavior();
                behavior |= NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::Stationary
                    | NSWindowCollectionBehavior::FullScreenAuxiliary;
                ns_window.setCollectionBehavior(behavior);
                ns_window.setLevel(NSScreenSaverWindowLevel);
                ns_window.setCanHide(false);
                ns_window.setHidesOnDeactivate(false);

                // Re-apply full display frame after raising window level so macOS does not
                // clamp the top edge below the menu bar.
                let mut frame = ns_window.frame();
                frame.origin.x = appkit_x;
                frame.origin.y = appkit_y;
                frame.size.width = mon_w;
                frame.size.height = mon_h;
                ns_window.setFrame_display(frame, true);

                ns_window.orderFrontRegardless();
            }
            Ok(())
        })();

        let _ = tx.send(result);
    })?;

    match rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(())) => {
            capture::debug_log(format!(
                "[begin] promoted capture window above menu bar in {}ms",
                t0.elapsed().as_millis()
            ));
            Ok(())
        }
        Ok(Err(err)) => Err(AppError::Capture(format!(
            "failed to configure macOS capture window: {err}"
        ))),
        Err(err) => Err(AppError::Capture(format!(
            "timed out configuring macOS capture window: {err}"
        ))),
    }
}
