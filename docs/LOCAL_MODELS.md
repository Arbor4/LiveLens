# 本地模型与 OCR 服务安装指南（RapidOCR + HY-MT1.5-1.8B）

为了保持 LiveLens 安装包轻量且避免捆绑体积庞大的模型权重，**RapidOCR** 与 **HY-MT1.5-1.8B** 均采用「外部独立服务」方式运行，在 LiveLens 设置面板中填入服务地址即可使用。

> **macOS 用户提示**：在 macOS 上你也可以直接在设置里将 OCR 引擎选为 **Apple Vision（系统原生）**，无需启动 RapidOCR Python 服务即可获得极快且低功耗的识别能力；如果你需要特定字体识别、Windows 跨平台一致性或想单独使用 RapidOCR，可按本文第 1 节启动。

---

## 一、 安装与启动 RapidOCR 本地服务（可选）

仓库内已提供极简无框架依赖的单文件 HTTP 服务脚本 [`scripts/rapidocr_server.py`](../scripts/rapidocr_server.py)。

### 1. 创建独立 Python 虚拟环境并安装依赖

建议使用 Python 3.10 ~ 3.12：

```bash
python3 -m venv ~/.livelens-ocr-venv
source ~/.livelens-ocr-venv/bin/activate

pip install --upgrade pip
pip install -r scripts/requirements-ocr.txt
```

### 2. 启动 RapidOCR 服务

```bash
source ~/.livelens-ocr-venv/bin/activate
python3 scripts/rapidocr_server.py --host 127.0.0.1 --port 9003
```

启动成功后，服务提供以下接口：
- 健康检查：`GET http://127.0.0.1:9003/health`
- OCR 识别：`POST http://127.0.0.1:9003/ocr`（支持 `multipart/form-data` 上传 `image` 字段或 JSON `imageBase64`）

### 3. 在 LiveLens 中配置
1. 打开 LiveLens **设置**；
2. 将「图片翻译模式」设为 **OCR + 翻译引擎**；
3. 将「OCR 引擎」设为 **RapidOCR（本地服务）**；
4. 确认「RapidOCR 地址」为 `http://127.0.0.1:9003/ocr`，点击 **测试连接** 确认显示可用即可。

---

## 二、 安装与启动 HY-MT1.5-1.8B 翻译大模型

`HY-MT1.5-1.8B` 是腾讯混元推出的轻量级多语言翻译专用模型。只要通过任意兼容 OpenAI `/v1/chat/completions` 接口的本地推理工具运行它，即可直接接入 LiveLens。

以下提供三种常用部署方式（任选其一）：

---

### 方式 A：Ollama（最简单，macOS / Windows 通用）

1. 安装 Ollama：<https://ollama.com/download>
2. 拉取或导入 `HY-MT1.5-1.8B` 模型（可从 HuggingFace / ModelScope 下载 GGUF 权重并通过 `Modelfile` 创建）：

```bash
# 示例：若已有本地量化权重 HY-MT1.5-1.8B-Q4_K_M.gguf
cat << 'EOF' > Modelfile
FROM ./HY-MT1.5-1.8B-Q4_K_M.gguf
PARAMETER temperature 0.2
PARAMETER num_ctx 2048
EOF

ollama create hy-mt1.5-1.8b -f Modelfile
ollama run hy-mt1.5-1.8b "Hello"
```

3. 在 LiveLens 设置中选择「翻译引擎 → **AI 大模型**」，点击预设 **HY-MT1.5 (Ollama)**：
   - **API 地址**：`http://127.0.0.1:11434/v1/chat/completions`
   - **模型**：`hy-mt1.5-1.8b`
   - **API Key**：留空即可

---

### 方式 B：llama.cpp（低延迟、支持 Metal / CUDA 硬件加速）

1. 安装 `llama.cpp`（macOS Homebrew 一键安装）：

```bash
brew install llama.cpp
```

2. 下载 `HY-MT1.5-1.8B` 的 GGUF 量化模型（推荐 `Q4_K_M` 或 `Q8_0`），启动 OpenAI 兼容服务端：

```bash
llama-server \
  -m /path/to/HY-MT1.5-1.8B-Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  -c 2048 \
  -ngl 99
```

3. 在 LiveLens 设置中点击预设 **HY-MT1.5 (llama.cpp)**：
   - **API 地址**：`http://127.0.0.1:8080/v1/chat/completions`
   - **模型**：`hy-mt1.5-1.8b`
   - **API Key**：留空即可

---

### 方式 C：MLX-LM（Apple Silicon M1~M5 极致性能推荐）

如果你使用的是 Apple Silicon Mac，可以使用 `mlx-lm` 获得最快的本地推理速度：

```bash
python3 -m venv ~/.livelens-mlx-venv
source ~/.livelens-mlx-venv/bin/activate
pip install mlx-lm

# 启动兼容 OpenAI 的本地推理服务（请替换为实际的本地或 HF MLX 模型路径）
mlx_lm.server \
  --model /path/to/HY-MT1.5-1.8B-mlx-4bit \
  --host 127.0.0.1 \
  --port 8081
```

在 LiveLens 设置中点击预设 **HY-MT1.5 (MLX)**：
- **API 地址**：`http://127.0.0.1:8081/v1/chat/completions`
- **模型**：与 `--model` 参数一致
- **API Key**：留空即可

---

## 三、 推荐提示词（Prompt）参考

LiveLens 在批量实时翻译时会自动构造带编号的结构化翻译指令；当你在设置中使用单条文本翻译或自定义 Prompt 时，建议使用简洁无废话的翻译指令以压低首字延迟：

- **指定源语言**：
  `Translate the following text from {from} into {to}. Output only the translated text without any explanation.`
- **自动检测源语言**：
  `Translate the following text into {to}. Output only the translated text without any explanation.`

---

## 四、 常见问题

1. **为什么设置里不填写 API Key 也能调用本地模型？**
   LiveLens 支持对本地服务（`127.0.0.1` / `localhost`）或无鉴权端点留空 API Key 直接请求。
2. **不想启动任何本地服务时还能用吗？**
   可以。macOS 可直接用内置的 **Apple Vision OCR** 搭配系统内置 **必应 / Google / 微软 / 腾讯** 文本翻译引擎，或将图片翻译切回 **有道图片翻译**。
