use std::collections::HashMap;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::RwLock;

use crate::error::{AppError, AppResult};
use crate::models::{
    BoundingBox, CaptureRect, OcrEngine, OverlayRegion, RegionLine, SelectionPayload,
    TextTranslateEngine, TranslatorSettings,
};
use crate::translators::TextTranslator;

#[derive(Debug, Clone)]
pub struct OcrLine {
    pub rect: CaptureRect,
    pub text: String,
    pub score: f32,
}

#[derive(Debug, Clone)]
pub struct OcrParagraph {
    pub rect: CaptureRect,
    pub text: String,
    pub lines: Vec<OcrLine>,
    pub avg_line_height: f64,
}

#[derive(Debug, Deserialize)]
struct OcrJsonResponse {
    #[serde(default)]
    lines: Vec<OcrJsonLine>,
}

#[derive(Debug, Deserialize)]
struct OcrJsonLine {
    #[serde(default)]
    x: Option<u32>,
    #[serde(default)]
    y: Option<u32>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    rect: Option<CaptureRect>,
    #[serde(default)]
    text: String,
    #[serde(default)]
    score: f32,
}

pub async fn recognize_image_bytes(
    http: &Client,
    engine: OcrEngine,
    rapid_ocr_url: &str,
    png_bytes: Vec<u8>,
    from_lang: &str,
) -> AppResult<Vec<OcrLine>> {
    match engine {
        OcrEngine::AppleVision => {
            #[cfg(target_os = "macos")]
            {
                let lang = from_lang.to_string();
                tokio::task::spawn_blocking(move || recognize_apple_vision(&png_bytes, &lang))
                    .await
                    .map_err(|e| AppError::Capture(format!("Apple Vision task failed: {e}")))?
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = from_lang;
                recognize_rapid_ocr(http, rapid_ocr_url, &png_bytes).await
            }
        }
        OcrEngine::RapidOcr => recognize_rapid_ocr(http, rapid_ocr_url, &png_bytes).await,
    }
}

pub async fn recognize_rapid_ocr(
    http: &Client,
    endpoint: &str,
    png_bytes: &[u8],
) -> AppResult<Vec<OcrLine>> {
    let url = endpoint.trim();
    if url.is_empty() {
        return Err(AppError::Capture("请先配置 RapidOCR 服务地址".into()));
    }

    let b64 = BASE64_STANDARD.encode(png_bytes);
    let resp = http
        .post(url)
        .json(&json!({ "imageBase64": b64 }))
        .send()
        .await
        .map_err(|e| {
            AppError::Api(format!(
                "RapidOCR 服务连接失败 ({url}): {e}。请确认已按文档启动 scripts/rapidocr_server.py"
            ))
        })?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Api(format!("RapidOCR 响应读取失败: {e}")))?;

    if !status.is_success() {
        return Err(AppError::Api(format!(
            "RapidOCR 服务错误 (HTTP {}): {}",
            status.as_u16(),
            &body[..body.len().min(300)]
        )));
    }

    parse_ocr_json(&body)
}

pub async fn test_rapid_ocr_connection(http: &Client, endpoint: &str) -> AppResult<String> {
    let url = endpoint.trim();
    if url.is_empty() {
        return Err(AppError::Api("RapidOCR 地址不能为空".into()));
    }
    let health_url = if let Some(prefix) = url.strip_suffix("/ocr") {
        format!("{prefix}/health")
    } else if url.ends_with('/') {
        format!("{url}health")
    } else {
        format!("{url}/health")
    };

    let started = std::time::Instant::now();
    let resp = http
        .get(&health_url)
        .send()
        .await
        .map_err(|e| AppError::Api(format!("RapidOCR 连接失败 ({health_url}): {e}")))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::Api(format!(
            "RapidOCR 健康检查失败 (HTTP {}): {}",
            status.as_u16(),
            body
        )));
    }
    Ok(format!(
        "RapidOCR 可用 ({}ms)",
        started.elapsed().as_millis()
    ))
}

fn parse_ocr_json(raw: &str) -> AppResult<Vec<OcrLine>> {
    let parsed: OcrJsonResponse =
        serde_json::from_str(raw).map_err(|e| AppError::Parse(format!("OCR JSON parse: {e}")))?;
    let mut out = Vec::with_capacity(parsed.lines.len());
    for item in parsed.lines {
        let text = item.text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        let rect = if let Some(r) = item.rect {
            r
        } else {
            CaptureRect {
                x: item.x.unwrap_or(0),
                y: item.y.unwrap_or(0),
                width: item.width.unwrap_or(1).max(1),
                height: item.height.unwrap_or(1).max(1),
            }
        };
        if rect.width == 0 || rect.height == 0 {
            continue;
        }
        out.push(OcrLine {
            rect,
            text,
            score: item.score,
        });
    }
    Ok(out)
}

#[cfg(target_os = "macos")]
fn recognize_apple_vision(png_bytes: &[u8], from_lang: &str) -> AppResult<Vec<OcrLine>> {
    use std::ffi::{c_char, CStr, CString};

    extern "C" {
        fn livelens_vision_recognize_png(
            png_bytes: *const u8,
            len: usize,
            languages_csv: *const c_char,
            err_out: *mut *mut c_char,
        ) -> *mut c_char;
        fn livelens_free_c_string(ptr: *mut c_char);
    }

    let langs_csv = vision_languages_for(from_lang);
    let langs_c = CString::new(langs_csv).unwrap_or_else(|_| CString::new("").unwrap());
    let mut err_ptr: *mut c_char = std::ptr::null_mut();

    let json_ptr = unsafe {
        livelens_vision_recognize_png(
            png_bytes.as_ptr(),
            png_bytes.len(),
            langs_c.as_ptr(),
            &mut err_ptr,
        )
    };

    if json_ptr.is_null() {
        let err_msg = if !err_ptr.is_null() {
            let msg = unsafe { CStr::from_ptr(err_ptr) }
                .to_string_lossy()
                .into_owned();
            unsafe { livelens_free_c_string(err_ptr) };
            msg
        } else {
            "Apple Vision OCR failed".to_string()
        };
        return Err(AppError::Capture(err_msg));
    }

    let json_str = unsafe { CStr::from_ptr(json_ptr) }
        .to_string_lossy()
        .into_owned();
    unsafe { livelens_free_c_string(json_ptr) };

    parse_ocr_json(&json_str)
}

#[cfg(target_os = "macos")]
fn vision_languages_for(from_lang: &str) -> &'static str {
    match from_lang {
        "zh-CHS" => "zh-Hans,en-US",
        "zh-CHT" => "zh-Hant,en-US",
        "en" => "en-US",
        "ja" => "ja-JP,en-US",
        "ko" => "ko-KR,en-US",
        "fr" => "fr-FR,en-US",
        "de" => "de-DE,en-US",
        "ru" => "ru-RU,en-US",
        "es" => "es-ES,en-US",
        _ => "zh-Hans,zh-Hant,en-US,ja-JP,ko-KR",
    }
}

/// Merge adjacent OCR lines into coherent paragraphs for natural translation and cleaner layout.
pub fn group_ocr_lines_into_paragraphs(mut lines: Vec<OcrLine>) -> Vec<OcrParagraph> {
    if lines.is_empty() {
        return Vec::new();
    }

    // Sort top-to-bottom, with a small vertical bucket tolerance for left-to-right ordering.
    lines.sort_by(|a, b| {
        let ay = a.rect.y as i64;
        let by = b.rect.y as i64;
        let min_h = a.rect.height.min(b.rect.height).max(8) as i64;
        if (ay - by).abs() <= min_h / 2 {
            a.rect.x.cmp(&b.rect.x)
        } else {
            ay.cmp(&by)
        }
    });

    let mut groups: Vec<Vec<OcrLine>> = Vec::new();

    for line in lines {
        let mut placed = false;
        // Prefer the most recent compatible paragraph.
        for group in groups.iter_mut().rev() {
            if let Some(last) = group.last() {
                if should_merge_into_paragraph(last, &line) {
                    group.push(line.clone());
                    placed = true;
                    break;
                }
            }
        }
        if !placed {
            groups.push(vec![line]);
        }
    }

    groups
        .into_iter()
        .map(|group| {
            let mut min_x = u32::MAX;
            let mut min_y = u32::MAX;
            let mut max_x = 0u32;
            let mut max_y = 0u32;
            let mut height_sum = 0f64;

            for item in &group {
                min_x = min_x.min(item.rect.x);
                min_y = min_y.min(item.rect.y);
                max_x = max_x.max(item.rect.x + item.rect.width);
                max_y = max_y.max(item.rect.y + item.rect.height);
                height_sum += item.rect.height as f64;
            }

            let joined = join_paragraph_lines(&group);
            let avg_line_height = height_sum / (group.len() as f64);

            OcrParagraph {
                rect: CaptureRect {
                    x: min_x,
                    y: min_y,
                    width: max_x.saturating_sub(min_x).max(1),
                    height: max_y.saturating_sub(min_y).max(1),
                },
                text: joined,
                lines: group,
                avg_line_height,
            }
        })
        .collect()
}

fn should_merge_into_paragraph(prev: &OcrLine, next: &OcrLine) -> bool {
    let h1 = prev.rect.height.max(1) as f64;
    let h2 = next.rect.height.max(1) as f64;
    let ratio = h1.max(h2) / h1.min(h2);
    if ratio > 1.75 {
        return false;
    }

    let min_h = h1.min(h2);
    let max_h = h1.max(h2);

    let prev_left = prev.rect.x as f64;
    let prev_right = (prev.rect.x + prev.rect.width) as f64;
    let next_left = next.rect.x as f64;
    let next_right = (next.rect.x + next.rect.width) as f64;

    let prev_bottom = (prev.rect.y + prev.rect.height) as f64;
    let next_top = next.rect.y as f64;
    let v_gap = next_top - prev_bottom;

    // Same visual line (horizontal continuation, e.g. inline span split by OCR):
    let same_row = (next.rect.y as f64 - prev.rect.y as f64).abs() <= min_h * 0.5;
    if same_row {
        let h_gap = next_left - prev_right;
        return h_gap >= -min_h * 0.5 && h_gap <= max_h * 1.5;
    }

    // Subsequent line in the same paragraph:
    if v_gap < -min_h * 0.35 || v_gap > max_h * 0.95 {
        return false;
    }

    let horiz_overlap = prev_right.min(next_right) - prev_left.max(next_left);
    if horiz_overlap <= 0.0 {
        return false;
    }

    let left_aligned = (prev_left - next_left).abs() <= max_h * 2.5;
    let center_prev = (prev_left + prev_right) * 0.5;
    let center_next = (next_left + next_right) * 0.5;
    let center_aligned = (center_prev - center_next).abs() <= max_h * 2.5;

    left_aligned || center_aligned
}

fn join_paragraph_lines(lines: &[OcrLine]) -> String {
    let mut out = String::new();
    for line in lines {
        let piece = line.text.trim();
        if piece.is_empty() {
            continue;
        }
        if out.is_empty() {
            out.push_str(piece);
            continue;
        }
        let prev_char = out.chars().last().unwrap_or(' ');
        let next_char = piece.chars().next().unwrap_or(' ');
        if is_cjk(prev_char) && is_cjk(next_char) {
            out.push_str(piece);
        } else if out.ends_with('-') {
            out.pop();
            out.push_str(piece);
        } else {
            out.push(' ');
            out.push_str(piece);
        }
    }
    out
}

fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x3040..=0x30FF | 0xAC00..=0xD7AF
    )
}

/// Sample median perimeter color for the region background and pick a crisp high-contrast ink color.
pub fn sample_region_colors(
    crop_rgba: &[u8],
    crop_w: u32,
    crop_h: u32,
    rect: &CaptureRect,
) -> (String, String) {
    if crop_w == 0 || crop_h == 0 || crop_rgba.len() < (crop_w * crop_h * 4) as usize {
        return ("#111827".to_string(), "#F9FAFB".to_string());
    }

    let x0 = rect.x.saturating_sub(2).min(crop_w - 1);
    let y0 = rect.y.saturating_sub(2).min(crop_h - 1);
    let x1 = (rect.x + rect.width + 1).min(crop_w - 1);
    let y1 = (rect.y + rect.height + 1).min(crop_h - 1);

    let mut rs = Vec::new();
    let mut gs = Vec::new();
    let mut bs = Vec::new();

    let mut push_px = |px: u32, py: u32| {
        let idx = ((py * crop_w + px) * 4) as usize;
        if idx + 2 < crop_rgba.len() {
            rs.push(crop_rgba[idx]);
            gs.push(crop_rgba[idx + 1]);
            bs.push(crop_rgba[idx + 2]);
        }
    };

    let step_x = ((x1 - x0) / 24).max(1);
    let step_y = ((y1 - y0) / 16).max(1);

    let mut x = x0;
    while x <= x1 {
        push_px(x, y0);
        push_px(x, y1);
        x += step_x;
    }
    let mut y = y0;
    while y <= y1 {
        push_px(x0, y);
        push_px(x1, y);
        y += step_y;
    }

    if rs.is_empty() {
        return ("#111827".to_string(), "#F9FAFB".to_string());
    }

    rs.sort_unstable();
    gs.sort_unstable();
    bs.sort_unstable();

    let mid = rs.len() / 2;
    let r = rs[mid];
    let g = gs[mid];
    let b = bs[mid];

    let bg_hex = format!("#{r:02X}{g:02X}{b:02X}");
    let luminance = 0.2126 * (r as f64) + 0.7152 * (g as f64) + 0.0722 * (b as f64);
    let text_hex = if luminance > 140.0 {
        "#111827".to_string()
    } else {
        "#F9FAFB".to_string()
    };

    (bg_hex, text_hex)
}

pub async fn translate_paragraphs_to_regions(
    paragraphs: Vec<OcrParagraph>,
    crop_rgba: &[u8],
    crop_w: u32,
    crop_h: u32,
    selection: &SelectionPayload,
    settings: &TranslatorSettings,
    text_translator: &TextTranslator,
    cache: &Arc<RwLock<HashMap<String, String>>>,
) -> AppResult<Vec<OverlayRegion>> {
    if paragraphs.is_empty() {
        return Ok(Vec::new());
    }

    let proxy_url = match settings.proxy_mode {
        crate::models::ProxyMode::None => Some("none"),
        crate::models::ProxyMode::System => None,
        crate::models::ProxyMode::Custom => {
            let trimmed = settings.custom_proxy.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }
    };

    let engine_tag = format!("{:?}", settings.text_translate_engine);
    let mut translated_texts = vec![String::new(); paragraphs.len()];
    let mut missing_indices = Vec::new();
    let mut missing_sources = Vec::new();

    {
        let cache_guard = cache.read().await;
        for (idx, p) in paragraphs.iter().enumerate() {
            let key = format!(
                "{}|{}|{}|{}",
                engine_tag, settings.from_lang, settings.to_lang, p.text
            );
            if let Some(hit) = cache_guard.get(&key) {
                translated_texts[idx] = hit.clone();
            } else {
                missing_indices.push(idx);
                missing_sources.push(p.text.clone());
            }
        }
    }

    if !missing_sources.is_empty() {
        let batch_outputs = if settings.text_translate_engine == TextTranslateEngine::Llm {
            text_translator
                .translate_llm_batch(
                    &missing_sources,
                    &settings.from_lang,
                    &settings.to_lang,
                    &settings.llm_config,
                )
                .await?
        } else {
            let mut outputs = Vec::with_capacity(missing_sources.len());
            for src in &missing_sources {
                let res = text_translator
                    .translate(
                        src,
                        &settings.from_lang,
                        &settings.to_lang,
                        settings.text_translate_engine,
                        &settings.llm_config,
                        proxy_url,
                    )
                    .await?;
                outputs.push(res.translated_text);
            }
            outputs
        };

        let mut cache_guard = cache.write().await;
        if cache_guard.len() > 2000 {
            cache_guard.clear();
        }
        for (pos, idx) in missing_indices.into_iter().enumerate() {
            let translated = batch_outputs.get(pos).cloned().unwrap_or_default();
            let key = format!(
                "{}|{}|{}|{}",
                engine_tag, settings.from_lang, settings.to_lang, paragraphs[idx].text
            );
            cache_guard.insert(key, translated.clone());
            translated_texts[idx] = translated;
        }
    }

    let mut regions = Vec::with_capacity(paragraphs.len());
    for (idx, p) in paragraphs.into_iter().enumerate() {
        let (bg_color, text_color) = sample_region_colors(crop_rgba, crop_w, crop_h, &p.rect);
        let translated = translated_texts.get(idx).cloned().unwrap_or_default();
        let local_rect = BoundingBox {
            x: p.rect.x as f64,
            y: p.rect.y as f64,
            width: p.rect.width as f64,
            height: p.rect.height as f64,
        };
        regions.push(OverlayRegion {
            rect: BoundingBox {
                x: selection.x + local_rect.x,
                y: selection.y + local_rect.y,
                width: local_rect.width,
                height: local_rect.height,
            },
            local_rect,
            source: p.text,
            translated,
            color: bg_color,
            text_color,
            font_size: p.avg_line_height * 0.85,
            lines: p
                .lines
                .into_iter()
                .map(|l| RegionLine { text: l.text })
                .collect(),
        });
    }

    Ok(regions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_adjacent_lines_into_one_paragraph_and_splits_distant_blocks() {
        let lines = vec![
            OcrLine {
                rect: CaptureRect {
                    x: 20,
                    y: 20,
                    width: 200,
                    height: 24,
                },
                text: "Hello world".into(),
                score: 0.99,
            },
            OcrLine {
                rect: CaptureRect {
                    x: 20,
                    y: 48,
                    width: 180,
                    height: 24,
                },
                text: "from LiveLens".into(),
                score: 0.98,
            },
            OcrLine {
                rect: CaptureRect {
                    x: 20,
                    y: 160,
                    width: 160,
                    height: 24,
                },
                text: "Second block".into(),
                score: 0.97,
            },
        ];

        let grouped = group_ocr_lines_into_paragraphs(lines);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].text, "Hello world from LiveLens");
        assert_eq!(grouped[1].text, "Second block");
    }

    #[test]
    fn sample_region_colors_picks_contrasting_ink() {
        let rgba = vec![250u8, 250, 250, 255].repeat(40 * 40);
        let (bg, fg) = sample_region_colors(
            &rgba,
            40,
            40,
            &CaptureRect {
                x: 5,
                y: 5,
                width: 20,
                height: 20,
            },
        );
        assert_eq!(bg, "#FAFAFA");
        assert_eq!(fg, "#111827");
    }
}
