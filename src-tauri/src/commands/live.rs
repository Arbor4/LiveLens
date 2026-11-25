use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, State, WebviewUrl,
    WebviewWindowBuilder,
};
use tokio::sync::watch;

use crate::capture::native_window as capture_window;
use crate::error::{AppError, AppResult};
use crate::live;
use crate::models::{CaptureRect, LiveDisplayMode, LiveSessionStatus};
use crate::state::SharedState;

pub(crate) const MIRROR_WINDOW_LABEL: &str = "mirror";

#[tauri::command]
pub async fn start_live_session(
    app: AppHandle,
    state: State<'_, SharedState>,
    selection: CaptureRect,
    mode: LiveDisplayMode,
) -> AppResult<LiveSessionStatus> {
    if selection.width <= 8 || selection.height <= 8 {
        return Err(AppError::Capture("选区过小，无法开启实时翻译".into()));
    }

    stop_existing_live_loop(state.inner()).await;

    let session = {
        let guard = state.capture_session.read().await;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| AppError::Capture("capture session missing".into()))?
    };

    let initial_crop = capture_window::crop_rgba(
        &session.rgba,
        session.img_w,
        selection.x,
        selection.y,
        selection.width,
        selection.height,
    );
    let initial_w = selection.width;
    let initial_h = selection.height;

    let (port, token) = live::ensure_frame_server_started(state.inner()).await?;
    let initial_jpeg = {
        let crop_clone = initial_crop.clone();
        tokio::task::spawn_blocking(move || {
            live::encode_rgba_to_jpeg(&crop_clone, initial_w, initial_h, 80)
        })
        .await
        .map_err(|e| AppError::Capture(format!("initial frame encode failed: {e}")))??
    };

    let frame_seq = {
        let mut store = state.live_frames.write().await;
        store.jpeg_bytes = initial_jpeg;
        store.seq += 1;
        store.seq
    };

    let settings = state.settings.read().await.clone();
    let (stop_tx, stop_rx) = watch::channel(false);

    {
        let mut rt = state.live_runtime.write().await;
        rt.active = true;
        rt.mode = mode;
        rt.paused = false;
        rt.keyframe_only = settings.live_mirror_keyframe_only;
        rt.bilingual = false;
        rt.subtitle_bar_mode = settings.live_in_place_subtitle_bar;
        rt.overlay_opacity = settings.overlay_opacity;
        rt.selection = selection;
        rt.monitor_x = session.monitor_x;
        rt.monitor_y = session.monitor_y;
        rt.monitor_width = session.monitor_width;
        rt.monitor_height = session.monitor_height;
        rt.img_w = session.img_w;
        rt.img_h = session.img_h;
        rt.scale_factor = session.scale_factor;
        #[cfg(target_os = "macos")]
        {
            rt.display_id = session.display_id;
        }
        rt.source_width = initial_w;
        rt.source_height = initial_h;
        rt.regions.clear();
        rt.last_error.clear();
        rt.stop_tx = Some(stop_tx);
    }

    // Close the static selection window and clear capture session without restoring main window.
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.hide();
    }
    *state.capture_in_progress.write().await = false;
    *state.capture_session.write().await = None;

    live::spawn_live_loop(
        app.clone(),
        state.inner().clone(),
        initial_crop,
        initial_w,
        initial_h,
        stop_rx,
    );

    open_windows_for_mode(&app, state.inner(), mode, selection, port, &token).await?;

    build_status_from_state(state.inner(), port, &token, frame_seq).await
}

#[tauri::command]
pub async fn stop_live_session(app: AppHandle, state: State<'_, SharedState>) -> AppResult<()> {
    stop_existing_live_loop(state.inner()).await;
    close_live_windows(&app);
    Ok(())
}

#[tauri::command]
pub async fn pause_live_session(
    app: AppHandle,
    state: State<'_, SharedState>,
    paused: bool,
) -> AppResult<LiveSessionStatus> {
    {
        let mut rt = state.live_runtime.write().await;
        rt.paused = paused;
    }
    let status = load_live_status_inner(state.inner()).await;
    let _ = app.emit("live:status", &status);
    Ok(status)
}

#[tauri::command]
pub async fn update_live_options(
    app: AppHandle,
    state: State<'_, SharedState>,
    keyframe_only: Option<bool>,
    bilingual: Option<bool>,
    subtitle_bar_mode: Option<bool>,
    overlay_opacity: Option<f32>,
) -> AppResult<LiveSessionStatus> {
    {
        let mut rt = state.live_runtime.write().await;
        if let Some(v) = keyframe_only {
            rt.keyframe_only = v;
        }
        if let Some(v) = bilingual {
            rt.bilingual = v;
        }
        if let Some(v) = subtitle_bar_mode {
            rt.subtitle_bar_mode = v;
        }
        if let Some(v) = overlay_opacity {
            rt.overlay_opacity = v.clamp(0.2, 1.0);
        }
    }
    let status = load_live_status_inner(state.inner()).await;
    let _ = app.emit("live:status", &status);
    Ok(status)
}

#[tauri::command]
pub async fn switch_live_mode(
    app: AppHandle,
    state: State<'_, SharedState>,
    mode: LiveDisplayMode,
) -> AppResult<LiveSessionStatus> {
    let (selection, active) = {
        let mut rt = state.live_runtime.write().await;
        rt.mode = mode;
        (rt.selection, rt.active)
    };
    if !active {
        return Err(AppError::Capture("当前没有运行中的实时翻译会话".into()));
    }

    let (port, token) = {
        let guard = state.live_frames.read().await;
        (guard.port, guard.token.clone())
    };
    open_windows_for_mode(&app, state.inner(), mode, selection, port, &token).await?;
    let status = load_live_status_inner(state.inner()).await;
    let _ = app.emit("live:status", &status);
    Ok(status)
}

#[tauri::command]
pub async fn load_live_status(state: State<'_, SharedState>) -> AppResult<LiveSessionStatus> {
    Ok(load_live_status_inner(state.inner()).await)
}

#[tauri::command]
pub async fn reselect_live_region(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> AppResult<()> {
    stop_existing_live_loop(state.inner()).await;
    close_live_windows(&app);
    crate::commands::capture::begin_capture(app, state).await
}

async fn stop_existing_live_loop(state: &SharedState) {
    let mut rt = state.live_runtime.write().await;
    rt.active = false;
    if let Some(tx) = rt.stop_tx.take() {
        let _ = tx.send(true);
    }
}

fn close_live_windows(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MIRROR_WINDOW_LABEL) {
        let _ = w.close();
    }
    if let Some(w) = app.get_webview_window(crate::commands::overlay::OVERLAY_WINDOW_LABEL) {
        let _ = w.close();
    }
    if let Some(w) = app.get_webview_window("live-controls") {
        let _ = w.close();
    }
}

async fn load_live_status_inner(state: &SharedState) -> LiveSessionStatus {
    let (port, token, seq) = {
        let guard = state.live_frames.read().await;
        (guard.port, guard.token.clone(), guard.seq)
    };
    build_status_from_state(state, port, &token, seq)
        .await
        .unwrap_or_else(|_| LiveSessionStatus {
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
            source_width: 0,
            source_height: 0,
            frame_url: String::new(),
            frame_seq: 0,
            regions: Vec::new(),
            last_error: String::new(),
        })
}

async fn build_status_from_state(
    state: &SharedState,
    port: u16,
    token: &str,
    frame_seq: u64,
) -> AppResult<LiveSessionStatus> {
    let rt = state.live_runtime.read().await;
    let frame_url = if port != 0 && !token.is_empty() {
        format!("http://127.0.0.1:{port}/frame?token={token}")
    } else {
        String::new()
    };
    Ok(LiveSessionStatus {
        active: rt.active,
        mode: rt.mode,
        paused: rt.paused,
        keyframe_only: rt.keyframe_only,
        bilingual: rt.bilingual,
        subtitle_bar_mode: rt.subtitle_bar_mode,
        overlay_opacity: rt.overlay_opacity,
        selection: rt.selection,
        source_width: rt.source_width,
        source_height: rt.source_height,
        frame_url,
        frame_seq,
        regions: rt.regions.clone(),
        last_error: rt.last_error.clone(),
    })
}

async fn open_windows_for_mode(
    app: &AppHandle,
    state: &SharedState,
    mode: LiveDisplayMode,
    selection: CaptureRect,
    _port: u16,
    _token: &str,
) -> AppResult<()> {
    match mode {
        LiveDisplayMode::Mirror => {
            if let Some(w) = app.get_webview_window(crate::commands::overlay::OVERLAY_WINDOW_LABEL) {
                let _ = w.close();
            }
            if let Some(w) = app.get_webview_window("live-controls") {
                let _ = w.close();
            }
            open_mirror_window(app, selection)?;
        }
        LiveDisplayMode::InPlace => {
            if let Some(w) = app.get_webview_window(MIRROR_WINDOW_LABEL) {
                let _ = w.close();
            }
            let rt = state.live_runtime.read().await.clone();
            open_in_place_overlay_windows(app, &rt)?;
        }
    }
    Ok(())
}

fn open_mirror_window(app: &AppHandle, selection: CaptureRect) -> AppResult<()> {
    let aspect = (selection.width.max(1) as f64) / (selection.height.max(1) as f64);
    let target_w = (selection.width as f64).clamp(640.0, 1120.0);
    let target_h = (target_w / aspect + 48.0).clamp(380.0, 820.0);

    if let Some(w) = app.get_webview_window(MIRROR_WINDOW_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    let url = WebviewUrl::App("mirror.html".into());
    let window = WebviewWindowBuilder::new(app, MIRROR_WINDOW_LABEL, url)
        .title("LiveLens · 实时翻译副屏")
        .inner_size(target_w, target_h)
        .min_inner_size(420.0, 280.0)
        .resizable(true)
        .center()
        .build()?;
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            let app_clone = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let state: State<'_, SharedState> = app_clone.state();
                let should_stop = {
                    let rt = state.live_runtime.read().await;
                    rt.active && rt.mode == LiveDisplayMode::Mirror
                };
                if should_stop {
                    stop_existing_live_loop(state.inner()).await;
                }
            });
        }
    });
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

fn open_in_place_overlay_windows(
    app: &AppHandle,
    rt: &crate::state::LiveRuntime,
) -> AppResult<()> {
    let mon_w = rt.monitor_width.max(1) as f64;
    let mon_h = rt.monitor_height.max(1) as f64;
    let img_w = rt.img_w.max(1) as f64;
    let img_h = rt.img_h.max(1) as f64;

    let logical_x = rt.monitor_x as f64 + (rt.selection.x as f64) * mon_w / img_w;
    let logical_y = rt.monitor_y as f64 + (rt.selection.y as f64) * mon_h / img_h;
    let logical_w = ((rt.selection.width as f64) * mon_w / img_w).max(20.0);
    let logical_h = ((rt.selection.height as f64) * mon_h / img_h).max(20.0);

    let phys_x = (logical_x * rt.scale_factor).round() as i32;
    let phys_y = (logical_y * rt.scale_factor).round() as i32;
    let phys_w = (logical_w * rt.scale_factor).round().max(20.0) as u32;
    let phys_h = (logical_h * rt.scale_factor).round().max(20.0) as u32;

    if let Some(w) = app.get_webview_window(crate::commands::overlay::OVERLAY_WINDOW_LABEL) {
        w.set_position(Position::Physical(PhysicalPosition::new(phys_x, phys_y)))?;
        w.set_size(Size::Physical(PhysicalSize::new(phys_w, phys_h)))?;
        let _ = w.set_ignore_cursor_events(true);
        let _ = w.show();
        #[cfg(target_os = "macos")]
        configure_macos_floating_window(&w, (logical_x, logical_y, logical_w, logical_h), false);
    } else {
        let url = WebviewUrl::App("overlay.html".into());
        let window = WebviewWindowBuilder::new(
            app,
            crate::commands::overlay::OVERLAY_WINDOW_LABEL,
            url,
        )
        .title("LiveLens Overlay")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .focused(false)
        .visible(false)
        .position(0.0, 0.0)
        .inner_size(100.0, 100.0)
        .build()?;
        window.set_position(Position::Physical(PhysicalPosition::new(phys_x, phys_y)))?;
        window.set_size(Size::Physical(PhysicalSize::new(phys_w, phys_h)))?;
        let _ = window.set_ignore_cursor_events(true);
        window.show()?;
        #[cfg(target_os = "macos")]
        configure_macos_floating_window(
            &window,
            (logical_x, logical_y, logical_w, logical_h),
            false,
        );
    }

    // Open floating mini control pill near the overlay bottom/top edge.
    let ctrl_w = 500.0;
    let ctrl_h = 44.0;
    let ctrl_x = logical_x + (logical_w - ctrl_w).max(0.0) / 2.0;
    let ctrl_y = if logical_y + logical_h + ctrl_h + 12.0 <= (rt.monitor_y as f64 + mon_h) {
        logical_y + logical_h + 8.0
    } else {
        (logical_y - ctrl_h - 8.0).max(rt.monitor_y as f64 + 8.0)
    };

    if let Some(w) = app.get_webview_window("live-controls") {
        let _ = w.set_position(Position::Logical(tauri::LogicalPosition::new(ctrl_x, ctrl_y)));
        let _ = w.show();
        #[cfg(target_os = "macos")]
        configure_macos_floating_window(&w, (ctrl_x, ctrl_y, ctrl_w, ctrl_h), true);
    } else {
        let url = WebviewUrl::App("live-controls.html".into());
        let ctrl = WebviewWindowBuilder::new(app, "live-controls", url)
            .title("LiveLens Live Controls")
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .resizable(false)
            .focused(false)
            .position(ctrl_x, ctrl_y)
            .inner_size(ctrl_w, ctrl_h)
            .build()?;
        let app_handle = app.clone();
        ctrl.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app_clone = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    let state: State<'_, SharedState> = app_clone.state();
                    let should_stop = {
                        let rt = state.live_runtime.read().await;
                        rt.active && rt.mode == LiveDisplayMode::InPlace
                    };
                    if should_stop {
                        stop_existing_live_loop(state.inner()).await;
                        if let Some(ov) =
                            app_clone.get_webview_window(crate::commands::overlay::OVERLAY_WINDOW_LABEL)
                        {
                            let _ = ov.close();
                        }
                    }
                });
            }
        });
        let _ = ctrl.show();
        #[cfg(target_os = "macos")]
        configure_macos_floating_window(&ctrl, (ctrl_x, ctrl_y, ctrl_w, ctrl_h), true);
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn configure_macos_floating_window(
    window: &tauri::WebviewWindow,
    logical_bounds: (f64, f64, f64, f64),
    above_overlay: bool,
) {
    use core_graphics::display::CGDisplay;
    use objc2_app_kit::{NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior};

    let (mon_x, mon_y, mon_w, mon_h) = logical_bounds;
    let main_bounds = CGDisplay::main().bounds();
    let appkit_x = mon_x;
    let appkit_y = main_bounds.origin.y + main_bounds.size.height - (mon_y + mon_h);

    let win_clone = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(raw) = win_clone.ns_window() {
            unsafe {
                let ns_window: &NSWindow = &*raw.cast();
                let mut behavior = ns_window.collectionBehavior();
                behavior |= NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::Stationary
                    | NSWindowCollectionBehavior::FullScreenAuxiliary;
                ns_window.setCollectionBehavior(behavior);
                ns_window.setLevel(if above_overlay {
                    NSScreenSaverWindowLevel + 1
                } else {
                    NSScreenSaverWindowLevel
                });
                ns_window.setHidesOnDeactivate(false);

                let mut frame = ns_window.frame();
                frame.origin.x = appkit_x;
                frame.origin.y = appkit_y;
                frame.size.width = mon_w;
                frame.size.height = mon_h;
                ns_window.setFrame_display(frame, true);
                ns_window.orderFrontRegardless();
            }
        }
    });
}
