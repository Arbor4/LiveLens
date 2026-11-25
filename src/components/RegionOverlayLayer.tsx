import type { OverlayRegion } from "../types/translator";

interface RegionOverlayLayerProps {
  regions: OverlayRegion[];
  sourceWidth: number;
  sourceHeight: number;
  containerWidth: number;
  containerHeight: number;
  opacity?: number;
  fontScale?: number;
  bilingual?: boolean;
  subtitleBarMode?: boolean;
  selectable?: boolean;
}

function estimateFittedFontSize(
  text: string,
  boxW: number,
  boxH: number,
  hintSize: number,
  fontScale: number,
): number {
  const safeW = Math.max(24, boxW - 6);
  const safeH = Math.max(14, boxH - 4);
  const base = hintSize > 6 ? hintSize : Math.min(20, Math.max(11, safeH * 0.65));
  let size = Math.min(Math.max(10, base * fontScale), Math.max(12, safeH * 0.85));

  // Iteratively shrink font size until estimated wrapped text height fits inside boxH.
  for (let i = 0; i < 8; i++) {
    const avgCharWidth = computeAvgCharWidth(text, size);
    const charsPerLine = Math.max(1, Math.floor(safeW / avgCharWidth));
    const lines = text
      .split("\n")
      .reduce((acc, seg) => acc + Math.max(1, Math.ceil(seg.length / charsPerLine)), 0);
    const neededH = lines * size * 1.24;
    if (neededH <= safeH || size <= 9.5) {
      break;
    }
    size = Math.max(9.5, size * 0.88);
  }
  return Number(size.toFixed(1));
}

function computeAvgCharWidth(text: string, fontSize: number): number {
  if (!text) return fontSize * 0.6;
  let cjkCount = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x2e80 && code <= 0x9fff) {
      cjkCount += 1;
    }
  }
  const cjkRatio = cjkCount / text.length;
  return fontSize * (0.56 + 0.44 * cjkRatio);
}

export function RegionOverlayLayer({
  regions,
  sourceWidth,
  sourceHeight,
  containerWidth,
  containerHeight,
  opacity = 0.94,
  fontScale = 1,
  bilingual = false,
  subtitleBarMode = false,
  selectable = false,
}: RegionOverlayLayerProps) {
  if (regions.length === 0 || sourceWidth <= 0 || sourceHeight <= 0) {
    return null;
  }

  if (subtitleBarMode) {
    return (
      <div
        className={`absolute inset-x-3 bottom-3 flex flex-col gap-1.5 rounded-xl bg-gray-950/85 px-4 py-3 text-white shadow-lg backdrop-blur-md ${
          selectable ? "pointer-events-auto select-text" : "pointer-events-none select-none"
        }`}
        style={{ opacity }}
      >
        {regions.map((region, idx) => (
          <div key={`${idx}-${region.localRect.x}-${region.localRect.y}`} className="leading-snug">
            {bilingual && region.source && (
              <div className="text-[12px] text-zinc-300">{region.source}</div>
            )}
            <div
              className="font-medium text-white"
              style={{ fontSize: `${Math.round(15 * fontScale)}px` }}
            >
              {region.translated || region.source}
            </div>
          </div>
        ))}
      </div>
    );
  }

  const scaleX = containerWidth / sourceWidth;
  const scaleY = containerHeight / sourceHeight;

  return (
    <div
      className={`absolute inset-0 overflow-hidden ${
        selectable ? "pointer-events-auto select-text" : "pointer-events-none select-none"
      }`}
    >
      {regions.map((region, idx) => {
        const leftPct = (region.localRect.x / sourceWidth) * 100;
        const topPct = (region.localRect.y / sourceHeight) * 100;
        const widthPct = (region.localRect.width / sourceWidth) * 100;
        const heightPct = (region.localRect.height / sourceHeight) * 100;

        const renderedW = region.localRect.width * scaleX;
        const renderedH = region.localRect.height * scaleY;
        const hintFontPx = (region.fontSize || 0) * scaleY;
        const displayText =
          bilingual && region.source && region.translated
            ? `${region.translated}\n${region.source}`
            : region.translated || region.source;

        const fontSizePx = estimateFittedFontSize(
          displayText,
          renderedW,
          renderedH,
          hintFontPx,
          fontScale,
        );

        const bg =
          region.color && region.color !== "default" ? region.color : "#111827";
        const fg = region.textColor || "#F9FAFB";

        return (
          <div
            key={`${idx}-${region.localRect.x}-${region.localRect.y}`}
            title={bilingual ? undefined : region.source}
            style={{
              left: `${leftPct}%`,
              top: `${topPct}%`,
              width: `${widthPct}%`,
              height: `${heightPct}%`,
              backgroundColor: bg,
              color: fg,
              opacity,
              fontSize: `${fontSizePx}px`,
              lineHeight: 1.22,
            }}
            className="absolute flex items-center overflow-hidden rounded-[3px] px-1 py-0.5 font-medium shadow-[0_1px_2px_rgba(0,0,0,0.12)]"
          >
            <span className="w-full break-words whitespace-pre-wrap">{displayText}</span>
          </div>
        );
      })}
    </div>
  );
}
