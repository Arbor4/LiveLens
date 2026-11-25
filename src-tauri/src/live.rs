use std::time::{Duration, Instant};

use image::codecs::jpeg::JpegEncoder;
use image::ExtendedColorType;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::capture::native_window as capture_window;
use crate::error::{AppError, AppResult};
use crate::models::{
    ImageTranslateMode, LiveDisplayMode, LiveFrameReadyEvent, LiveRegionsEvent, OcrEngine,
    SelectionPayload,
};
use crate::state::SharedState;
use crate::translators::ocr;

#[cfg(target_os = "macos")]
mod macos_sc {
    use std::ffi::{c_char, c_void, CStr};

    extern "C" {
        fn livelens_sc_start(
            display_id: u32,
            src_x: f64,
            src_y: f64,
            src_w: f64,
            src_h: f64,
            out_w: u32,
            out_h: u32,
            fps: u32,
            err_out: *mut *mut c_char,
        ) -> *mut c_void;
        fn livelens_sc_poll_frame(
            handle: *mut c_void,
            min_seq: u64,
            out_seq: *mut u64,
            out_w: *mut u32,
            out_h: *mut u32,
            out_rgba: *mut *mut u8,
            out_len: *mut usize,
            err_out: *mut *mut c_char,
        ) -> i32;
        fn livelens_sc_free_bytes(ptr: *mut u8);
        fn livelens_sc_stop(handle: *mut c_void);
        fn livelens_free_c_string(ptr: *mut c_char);
    }

    pub struct ScStreamHandle(*mut c_void);
    unsafe impl Send for ScStreamHandle {}
    unsafe impl Sync for ScStreamHandle {}

    impl Drop for ScStreamHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { livelens_sc_stop(self.0) };
                self.0 = std::ptr::null_mut();
            }
        }
    }

    pub fn start(
        display_id: u32,
        src_x: f64,
        src_y: f64,
        src_w: f64,
        src_h: f64,
        out_w: u32,
        out_h: u32,
        fps: u32,
    ) -> Result<ScStreamHandle, String> {
        let mut err_ptr: *mut c_char = std::ptr::null_mut();
        let ptr = unsafe {
            livelens_sc_start(
                display_id,
                src_x,
                src_y,
                src_w,
                src_h,
                out_w,
                out_h,
                fps,
                &mut err_ptr,
            )
        };
        if ptr.is_null() {
            let msg = if !err_ptr.is_null() {
                let s = unsafe { CStr::from_ptr(err_ptr) }
                    .to_string_lossy()
                    .into_owned();
                unsafe { livelens_free_c_string(err_ptr) };
                s
            } else {
                "failed to start ScreenCaptureKit stream".to_string()
            };
            return Err(msg);
        }
        Ok(ScStreamHandle(ptr))
    }

    pub fn poll(
        handle: &ScStreamHandle,
        min_seq: u64,
    ) -> Result<Option<(u64, u32, u32, Vec<u8>)>, String> {
        let mut seq: u64 = min_seq;
        let mut w: u32 = 0;
        let mut h: u32 = 0;
        let mut bytes_ptr: *mut u8 = std::ptr::null_mut();
        let mut len: usize = 0;
        let mut err_ptr: *mut c_char = std::ptr::null_mut();

        let rc = unsafe {
            livelens_sc_poll_frame(
                handle.0,
                min_seq,
                &mut seq,
                &mut w,
                &mut h,
                &mut bytes_ptr,
                &mut len,
                &mut err_ptr,
            )
        };

        if rc < 0 {
            let msg = if !err_ptr.is_null() {
                let s = unsafe { CStr::from_ptr(err_ptr) }
                    .to_string_lossy()
                    .into_owned();
                unsafe { livelens_free_c_string(err_ptr) };
                s
            } else {
                "ScreenCaptureKit stream error".to_string()
            };
            return Err(msg);
        }

        if rc == 0 || bytes_ptr.is_null() || len == 0 {
            return Ok(None);
        }

        let slice = unsafe { std::slice::from_raw_parts(bytes_ptr, len) };
        let vec = slice.to_vec();
        unsafe { livelens_sc_free_bytes(bytes_ptr) };
        Ok(Some((seq, w, h, vec)))
    }
}

pub async fn ensure_frame_server_started(state: &SharedState) -> AppResult<(u16, String)> {
    {
        let guard = state.live_frames.read().await;
        if guard.port != 0 && !guard.token.is_empty() {
            return Ok((guard.port, guard.token.clone()));
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| AppError::Capture(format!("failed to bind live frame server: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Capture(format!("failed to read live frame server addr: {e}")))?
        .port();
    let token = uuid::Uuid::new_v4().to_string().replace('-', "");

    {
        let mut guard = state.live_frames.write().await;
        if guard.port != 0 && !guard.token.is_empty() {
            return Ok((guard.port, guard.token.clone()));
        }
        guard.port = port;
        guard.token = token.clone();
    }

    let frames = state.live_frames.clone();
    let expected_token = token.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                continue;
            };
            let frames = frames.clone();
            let expected_token = expected_token.clone();
            tokio::spawn(async move {
                let mut req_buf = [0u8; 2048];
                let Ok(n) = stream.read(&mut req_buf).await else {
                    return;
                };
                if n == 0 {
                    return;
                }
                let req_str = String::from_utf8_lossy(&req_buf[..n]);
                let first_line = req_str.lines().next().unwrap_or("");
                let path = first_line.split_whitespace().nth(1).unwrap_or("");

                if !path.starts_with("/frame") || !path.contains(&format!("token={expected_token}")) {
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .await;
                    return;
                }

                let jpeg = {
                    let guard = frames.read().await;
                    guard.jpeg_bytes.clone()
                };

                if jpeg.is_empty() {
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .await;
                    return;
                }

                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nCache-Control: no-store, no-cache, must-revalidate\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    jpeg.len()
                );
                let _ = stream.write_all(header.as_bytes()).await;
                let _ = stream.write_all(&jpeg).await;
            });
        }
    });

    Ok((port, token))
}

pub fn encode_rgba_to_jpeg(rgba: &[u8], w: u32, h: u32, quality: u8) -> AppResult<Vec<u8>> {
    if w == 0 || h == 0 || rgba.len() < (w * h * 4) as usize {
        return Err(AppError::Capture("invalid RGBA buffer for JPEG".into()));
    }
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for px in rgba[..(w * h * 4) as usize].chunks_exact(4) {
        rgb.push(px[0]);
        rgb.push(px[1]);
        rgb.push(px[2]);
    }
    let mut out = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut out, quality);
    encoder
        .encode(&rgb, w, h, ExtendedColorType::Rgb8)
        .map_err(|e| AppError::Capture(format!("JPEG encode failed: {e}")))?;
    Ok(out)
}

/// Fast luminance MAD across a 32x24 sample grid (returns 0.0..255.0).
pub fn sample_frame_signature(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    if w == 0 || h == 0 || rgba.len() < (w * h * 4) as usize {
        return Vec::new();
    }
    const COLS: u32 = 32;
    const ROWS: u32 = 24;
    let mut sig = Vec::with_capacity((COLS * ROWS) as usize);
    for gy in 0..ROWS {
        let py = ((gy * h) / ROWS).min(h - 1);
        for gx in 0..COLS {
            let px = ((gx * w) / COLS).min(w - 1);
            let idx = ((py * w + px) * 4) as usize;
            let luma = ((rgba[idx] as u16 * 3 + rgba[idx + 1] as u16 * 6 + rgba[idx + 2] as u16)
                / 10) as u8;
            sig.push(luma);
        }
    }
    sig
}

pub fn signature_mad(a: &[u8], b: &[u8]) -> f32 {
    if a.is_empty() || a.len() != b.len() {
        return 255.0;
    }
    let sum: u32 = a
        .iter()
        .zip(b.iter())
        .map(|(&x, &y)| (x as i32 - y as i32).unsigned_abs())
        .sum();
    (sum as f32) / (a.len() as f32)
}

pub fn spawn_live_loop(
    app: AppHandle,
    state: SharedState,
    initial_rgba: Vec<u8>,
    initial_w: u32,
    initial_h: u32,
    mut stop_rx: watch::Receiver<bool>,
) {
    tokio::spawn(async move {
        let runtime_snapshot = state.live_runtime.read().await.clone();
        let settings_snapshot = state.settings.read().await.clone();
        let fps = settings_snapshot.live_mirror_fps.clamp(5, 30);

        let max_dim = 1920u32;
        let (out_w, out_h) = if initial_w > max_dim || initial_h > max_dim {
            let scale = (max_dim as f64) / (initial_w.max(initial_h) as f64);
            (
                ((initial_w as f64) * scale).round().max(2.0) as u32,
                ((initial_h as f64) * scale).round().max(2.0) as u32,
            )
        } else {
            (initial_w.max(2), initial_h.max(2))
        };

        #[cfg(target_os = "macos")]
        let sc_stream = {
            let mon_w = runtime_snapshot.monitor_width.max(1) as f64;
            let mon_h = runtime_snapshot.monitor_height.max(1) as f64;
            let img_w = runtime_snapshot.img_w.max(1) as f64;
            let img_h = runtime_snapshot.img_h.max(1) as f64;
            let src_x = (runtime_snapshot.selection.x as f64) * mon_w / img_w;
            let src_y = (runtime_snapshot.selection.y as f64) * mon_h / img_h;
            let src_w = ((runtime_snapshot.selection.width as f64) * mon_w / img_w).max(1.0);
            let src_h = ((runtime_snapshot.selection.height as f64) * mon_h / img_h).max(1.0);
            let display_id = runtime_snapshot.display_id;

            match tokio::task::spawn_blocking(move || {
                macos_sc::start(display_id, src_x, src_y, src_w, src_h, out_w, out_h, fps)
            })
            .await
            {
                Ok(Ok(handle)) => Some(std::sync::Arc::new(handle)),
                Ok(Err(err)) => {
                    tracing::error!("ScreenCaptureKit start failed: {err}");
                    state.live_runtime.write().await.last_error = err.clone();
                    let _ = app.emit("live:error", serde_json::json!({ "message": err }));
                    None
                }
                Err(err) => {
                    tracing::error!("ScreenCaptureKit spawn failed: {err}");
                    None
                }
            }
        };

        #[cfg(target_os = "macos")]
        if sc_stream.is_none() {
            return;
        }

        let mut last_sc_seq = 0u64;
        let mut last_video_sig = sample_frame_signature(&initial_rgba, initial_w, initial_h);
        let mut last_ocr_sig: Vec<u8> = Vec::new();
        let mut last_ocr_at = Instant::now() - Duration::from_secs(10);
        let mut last_text_signature = String::new();
        let mut latest_frame: Option<(Vec<u8>, u32, u32)> = Some((initial_rgba, initial_w, initial_h));
        let mut force_initial_ocr = true;

        let tick_ms = (1000 / fps.max(5)).max(33) as u64;

        loop {
            if *stop_rx.borrow() {
                break;
            }

            let runtime = state.live_runtime.read().await.clone();
            if !runtime.active {
                break;
            }

            if runtime.paused {
                tokio::select! {
                    _ = stop_rx.changed() => break,
                    _ = tokio::time::sleep(Duration::from_millis(120)) => continue,
                }
            }

            #[cfg(target_os = "macos")]
            let polled = if let Some(ref stream) = sc_stream {
                let s = stream.clone();
                let min_seq = last_sc_seq;
                tokio::task::spawn_blocking(move || macos_sc::poll(&s, min_seq))
                    .await
                    .ok()
                    .and_then(|res| match res {
                        Ok(opt) => opt,
                        Err(e) => {
                            tracing::warn!("SCStream poll error: {e}");
                            None
                        }
                    })
            } else {
                None
            };

            #[cfg(not(target_os = "macos"))]
            let polled: Option<(u64, u32, u32, Vec<u8>)> = None;

            if let Some((seq, fw, fh, rgba)) = polled {
                last_sc_seq = seq;
                let sig = sample_frame_signature(&rgba, fw, fh);
                let video_diff = signature_mad(&sig, &last_video_sig);

                let should_push_video = runtime.mode == LiveDisplayMode::Mirror
                    && (!runtime.keyframe_only || video_diff > 1.2);

                if should_push_video {
                    last_video_sig = sig.clone();
                    let rgba_for_jpg = rgba.clone();
                    if let Ok(Ok(jpeg)) = tokio::task::spawn_blocking(move || {
                        encode_rgba_to_jpeg(&rgba_for_jpg, fw, fh, 80)
                    })
                    .await
                    {
                        let new_seq = {
                            let mut store = state.live_frames.write().await;
                            store.jpeg_bytes = jpeg;
                            store.seq += 1;
                            store.seq
                        };
                        let _ = app.emit("live:frame", LiveFrameReadyEvent { seq: new_seq });
                    }
                }

                latest_frame = Some((rgba, fw, fh));
            }

            let settings = state.settings.read().await.clone();
            let interval = Duration::from_millis(settings.live_frame_interval_ms.clamp(150, 5000));

            if let Some((ref rgba, fw, fh)) = latest_frame {
                let sig = sample_frame_signature(rgba, fw, fh);
                let ocr_diff = signature_mad(&sig, &last_ocr_sig);
                let due = last_ocr_at.elapsed() >= interval;

                if force_initial_ocr || (due && ocr_diff > 2.4) {
                    force_initial_ocr = false;
                    last_ocr_at = Instant::now();
                    last_ocr_sig = sig;

                    let rgba_copy = rgba.clone();
                    let ocr_started = Instant::now();
                    let png_res = tokio::task::spawn_blocking(move || {
                        capture_window::encode_png(&rgba_copy, fw, fh)
                    })
                    .await;

                    let png_bytes = match png_res {
                        Ok(Ok(bytes)) => bytes,
                        _ => {
                            tokio::time::sleep(Duration::from_millis(tick_ms)).await;
                            continue;
                        }
                    };

                    let effective_ocr_engine = if settings.image_translate_mode == ImageTranslateMode::Youdao
                    {
                        #[cfg(target_os = "macos")]
                        {
                            OcrEngine::AppleVision
                        }
                        #[cfg(not(target_os = "macos"))]
                        {
                            OcrEngine::RapidOcr
                        }
                    } else {
                        settings.ocr_engine
                    };

                    match ocr::recognize_image_bytes(
                        &state.http_client,
                        effective_ocr_engine,
                        &settings.rapid_ocr_url,
                        png_bytes,
                        &settings.from_lang,
                    )
                    .await
                    {
                        Ok(lines) => {
                            let ocr_ms = ocr_started.elapsed().as_millis() as u64;
                            let paragraphs = ocr::group_ocr_lines_into_paragraphs(lines);
                            let text_sig = paragraphs
                                .iter()
                                .map(|p| format!("{}:{}:{}", p.text, p.rect.x / 8, p.rect.y / 8))
                                .collect::<Vec<_>>()
                                .join("|");

                            if text_sig != last_text_signature {
                                last_text_signature = text_sig;
                                let translate_started = Instant::now();
                                let sel = SelectionPayload {
                                    x: 0.0,
                                    y: 0.0,
                                    width: fw as f64,
                                    height: fh as f64,
                                    monitor_id: "live".into(),
                                    monitor_x: runtime.monitor_x,
                                    monitor_y: runtime.monitor_y,
                                    monitor_width: runtime.monitor_width,
                                    monitor_height: runtime.monitor_height,
                                    monitor_scale_factor: runtime.scale_factor,
                                };

                                match ocr::translate_paragraphs_to_regions(
                                    paragraphs,
                                    rgba,
                                    fw,
                                    fh,
                                    &sel,
                                    &settings,
                                    &state.text_translator,
                                    &state.translation_cache,
                                )
                                .await
                                {
                                    Ok(regions) => {
                                        let translate_ms =
                                            translate_started.elapsed().as_millis() as u64;
                                        let seq = state.live_frames.read().await.seq;
                                        {
                                            let mut rt = state.live_runtime.write().await;
                                            rt.regions = regions.clone();
                                            rt.source_width = fw;
                                            rt.source_height = fh;
                                            rt.last_error.clear();
                                        }
                                        let _ = app.emit(
                                            "live:regions",
                                            LiveRegionsEvent {
                                                frame_seq: seq,
                                                regions,
                                                ocr_ms,
                                                translate_ms,
                                            },
                                        );
                                    }
                                    Err(err) => {
                                        let msg = err.to_string();
                                        state.live_runtime.write().await.last_error = msg.clone();
                                        let _ = app.emit(
                                            "live:error",
                                            serde_json::json!({ "message": msg }),
                                        );
                                    }
                                }
                            }
                        }
                        Err(err) => {
                            let msg = err.to_string();
                            state.live_runtime.write().await.last_error = msg.clone();
                            let _ = app.emit("live:error", serde_json::json!({ "message": msg }));
                        }
                    }
                }
            }

            tokio::select! {
                _ = stop_rx.changed() => break,
                _ = tokio::time::sleep(Duration::from_millis(tick_ms)) => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_signature_distinguishes_identical_and_changed_frames() {
        let frame_a = vec![40u8, 40, 40, 255].repeat(64 * 48);
        let frame_b = vec![40u8, 40, 40, 255].repeat(64 * 48);
        let frame_c = vec![220u8, 220, 220, 255].repeat(64 * 48);

        let sig_a = sample_frame_signature(&frame_a, 64, 48);
        let sig_b = sample_frame_signature(&frame_b, 64, 48);
        let sig_c = sample_frame_signature(&frame_c, 64, 48);

        assert_eq!(signature_mad(&sig_a, &sig_b), 0.0);
        assert!(signature_mad(&sig_a, &sig_c) > 100.0);
    }

    #[test]
    fn encodes_rgba_to_valid_jpeg() {
        let rgba = vec![120u8, 180, 240, 255].repeat(16 * 16);
        let jpg = encode_rgba_to_jpeg(&rgba, 16, 16, 80).expect("jpeg encode");
        assert!(jpg.len() > 20);
        assert_eq!(&jpg[..2], &[0xFF, 0xD8]);
    }
}
