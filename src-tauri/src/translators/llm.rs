use std::sync::Arc;

use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::models::TextTranslationResult;

pub struct LlmTranslateClient {
    http: Arc<Client>,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
}

#[derive(Serialize, Deserialize, Clone)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

impl LlmTranslateClient {
    pub fn new(http: Arc<Client>) -> Self {
        Self { http }
    }

    pub async fn translate(
        &self,
        text: &str,
        from: &str,
        to: &str,
        base_url: &str,
        api_key: &str,
        model: &str,
        prompt: &str,
        auto_prompt: &str,
    ) -> AppResult<TextTranslationResult> {
        let from_label = lang_label(from);
        let to_label = lang_label(to);

        // Pick the prompt template based on whether the source language is
        // auto-detect. Each has its own user-configurable template, falling back
        // to the built-in default when empty. `{from}` and `{to}` placeholders
        // are substituted with the resolved language labels.
        let template = if from == "auto" {
            if auto_prompt.trim().is_empty() {
                crate::models::default_llm_auto_prompt()
            } else {
                auto_prompt.to_string()
            }
        } else if prompt.trim().is_empty() {
            crate::models::default_llm_prompt()
        } else {
            prompt.to_string()
        };
        let system_prompt = template
            .replace("{from}", from_label)
            .replace("{to}", to_label);

        let url = base_url.trim().to_string();

        let request = ChatRequest {
            model: model.to_string(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: system_prompt,
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: text.to_string(),
                },
            ],
            temperature: 0.3,
        };

        let mut req_builder = self
            .http
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&request);
        if !api_key.trim().is_empty() {
            req_builder = req_builder.header("Authorization", format!("Bearer {}", api_key.trim()));
        }

        let resp = req_builder
            .send()
            .await
            .map_err(|e| AppError::Api(format!("LLM translate request failed: {e}")))?;

        let status = resp.status();
        let body_text = resp
            .text()
            .await
            .map_err(|e| AppError::Api(format!("LLM translate read body failed: {e}")))?;

        if !status.is_success() {
            let detail = &body_text[..body_text.len().min(500)];
            return Err(AppError::Api(format!(
                "LLM API error (HTTP {}): {}",
                status.as_u16(),
                detail
            )));
        }

        let chat_resp: ChatResponse = serde_json::from_str(&body_text)
            .map_err(|e| AppError::Api(format!("LLM translate parse failed: {e}")))?;

        let translated = chat_resp
            .choices
            .first()
            .and_then(|c| Some(c.message.content.clone()))
            .unwrap_or_default()
            .trim()
            .to_string();

        if translated.is_empty() {
            return Err(AppError::Api("LLM returned empty translation".into()));
        }

        Ok(TextTranslationResult {
            translated_text: translated,
            from_lang_detected: from.to_string(),
            alternatives: Vec::new(),
        })
    }

    pub async fn translate_batch(
        &self,
        texts: &[String],
        from: &str,
        to: &str,
        base_url: &str,
        api_key: &str,
        model: &str,
        prompt: &str,
        auto_prompt: &str,
    ) -> AppResult<Vec<String>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        if texts.len() == 1 {
            let single = self
                .translate(&texts[0], from, to, base_url, api_key, model, prompt, auto_prompt)
                .await?;
            return Ok(vec![single.translated_text]);
        }

        let from_label = lang_label(from);
        let to_label = lang_label(to);
        let numbered_input = texts
            .iter()
            .enumerate()
            .map(|(i, t)| format!("[{}] {}", i + 1, t.replace('\n', " ")))
            .collect::<Vec<_>>()
            .join("\n");

        let system_prompt = if from == "auto" {
            format!(
                "You are a professional translator. Detect the source language and translate each numbered item into {to_label}. Keep the exact [1], [2], ... numbering on separate lines. Output only the translated numbered lines."
            )
        } else {
            format!(
                "You are a professional translator. Translate each numbered item from {from_label} into {to_label}. Keep the exact [1], [2], ... numbering on separate lines. Output only the translated numbered lines."
            )
        };

        let request = ChatRequest {
            model: model.to_string(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: system_prompt,
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: numbered_input,
                },
            ],
            temperature: 0.2,
        };

        let url = base_url.trim().to_string();
        let mut req_builder = self
            .http
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&request);
        if !api_key.trim().is_empty() {
            req_builder = req_builder.header("Authorization", format!("Bearer {}", api_key.trim()));
        }

        let resp = req_builder
            .send()
            .await
            .map_err(|e| AppError::Api(format!("LLM batch translate request failed: {e}")))?;
        let status = resp.status();
        let body_text = resp
            .text()
            .await
            .map_err(|e| AppError::Api(format!("LLM batch read body failed: {e}")))?;

        if !status.is_success() {
            let detail = &body_text[..body_text.len().min(500)];
            return Err(AppError::Api(format!(
                "LLM API error (HTTP {}): {}",
                status.as_u16(),
                detail
            )));
        }

        let chat_resp: ChatResponse = serde_json::from_str(&body_text)
            .map_err(|e| AppError::Api(format!("LLM batch parse failed: {e}")))?;
        let content = chat_resp
            .choices
            .first()
            .map(|c| c.message.content.trim().to_string())
            .unwrap_or_default();

        if let Some(parsed) = parse_numbered_batch(&content, texts.len()) {
            return Ok(parsed);
        }

        // Fallback when a lightweight local model omits [N] markers.
        let mut results = Vec::with_capacity(texts.len());
        for text in texts {
            let single = self
                .translate(text, from, to, base_url, api_key, model, prompt, auto_prompt)
                .await?;
            results.push(single.translated_text);
        }
        Ok(results)
    }

    pub async fn test_connection(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
    ) -> AppResult<String> {
        let started = std::time::Instant::now();
        let res = self
            .translate(
                "Hello",
                "en",
                "zh-CHS",
                base_url,
                api_key,
                model,
                "",
                "",
            )
            .await?;
        Ok(format!(
            "连接成功 ({}ms): {}",
            started.elapsed().as_millis(),
            res.translated_text
        ))
    }
}

fn parse_numbered_batch(content: &str, expected: usize) -> Option<Vec<String>> {
    let mut items = vec![String::new(); expected];
    let mut current_idx: Option<usize> = None;
    let mut matched_any = false;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix('[') {
            if let Some((num_str, tail)) = rest.split_once(']') {
                if let Ok(num) = num_str.trim().parse::<usize>() {
                    if num >= 1 && num <= expected {
                        let idx = num - 1;
                        current_idx = Some(idx);
                        matched_any = true;
                        let text = tail.trim();
                        if !items[idx].is_empty() && !text.is_empty() {
                            items[idx].push(' ');
                        }
                        items[idx].push_str(text);
                        continue;
                    }
                }
            }
        }
        if let Some(idx) = current_idx {
            if !items[idx].is_empty() {
                items[idx].push('\n');
            }
            items[idx].push_str(line);
        }
    }

    if matched_any && items.iter().all(|item| !item.trim().is_empty()) {
        return Some(items);
    }

    let plain_lines: Vec<String> = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    if plain_lines.len() == expected {
        return Some(plain_lines);
    }

    None
}

fn lang_label(code: &str) -> &str {
    match code {
        "auto" => "auto-detect",
        "zh-CHS" => "Simplified Chinese",
        "zh-CHT" => "Traditional Chinese",
        "en" => "English",
        "ja" => "Japanese",
        "ko" => "Korean",
        "fr" => "French",
        "de" => "German",
        "ru" => "Russian",
        "es" => "Spanish",
        _ => code,
    }
}