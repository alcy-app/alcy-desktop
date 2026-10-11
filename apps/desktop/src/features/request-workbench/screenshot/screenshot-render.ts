import type { HighlightTone } from './screenshot-highlight'
import type { DrawOp, FontSpec, MeasureText, ScreenshotLayout } from './screenshot-layout'
import type { ColorRole, ScreenshotPalette } from './screenshot-palette'

/** Mesmas famílias de `--font-sans`/`--font-mono` (`tokens.css`); as fontes vêm no bundle. */
const FONT_FAMILIES: Record<FontSpec['family'], string> = {
  sans: "Inter, system-ui, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace",
}

/** Escala da exportação: nítida quando colada em documentos e apresentações. */
export const SCREENSHOT_SCALE = 2

const TONE_COLORS: Record<HighlightTone, ColorRole> = {
  plain: 'text',
  key: 'accentStrong',
  string: 'success',
  number: 'warning',
  keyword: 'accent',
  punctuation: 'textMuted',
  comment: 'textMuted',
}

function cssFont(font: FontSpec, weight: number = font.weight, italic = font.italic): string {
  return `${italic ? 'italic ' : ''}${weight} ${font.size}px ${FONT_FAMILIES[font.family]}`
}

/** Medida de texto do canvas; sem contexto 2D (ex.: jsdom), uma estimativa monoespaçada. */
export function createMeasure(context: CanvasRenderingContext2D | null): MeasureText {
  if (!context) return (text, font) => text.length * font.size * 0.6
  return (text, font) => {
    context.font = cssFont(font)
    return context.measureText(text).width
  }
}

/** Espera as fontes do bundle carregarem: o canvas não refaz o desenho quando elas chegam. */
export async function ensureScreenshotFonts(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return
  try {
    await Promise.all([
      document.fonts.load("400 12px 'JetBrains Mono'"),
      document.fonts.load("700 12px 'JetBrains Mono'"),
      document.fonts.load('400 12px Inter'),
      document.fonts.load('600 12px Inter'),
      document.fonts.load('700 12px Inter'),
    ])
  } catch {
    // Sem as fontes do bundle, o canvas usa as de fallback da pilha.
  }
}

/** Caminho de retângulo arredondado sem `roundRect`, ausente em WebKitGTK mais antigos. */
function roundedRectPath(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  context.beginPath()
  context.moveTo(x + r, y)
  context.arcTo(x + width, y, x + width, y + height, r)
  context.arcTo(x + width, y + height, x, y + height, r)
  context.arcTo(x, y + height, x, y, r)
  context.arcTo(x, y, x + width, y, r)
  context.closePath()
}

function drawOp(context: CanvasRenderingContext2D, op: DrawOp, palette: ScreenshotPalette) {
  switch (op.kind) {
    case 'rect':
      if (op.fill) {
        roundedRectPath(context, op.x, op.y, op.width, op.height, op.radius)
        context.globalAlpha = op.fillAlpha ?? 1
        context.fillStyle = palette[op.fill]
        context.fill()
        context.globalAlpha = 1
      }
      if (op.stroke) {
        // Meio pixel para a borda de 1px ficar nítida.
        roundedRectPath(context, op.x + 0.5, op.y + 0.5, op.width - 1, op.height - 1, op.radius)
        context.strokeStyle = palette[op.stroke]
        context.lineWidth = 1
        context.stroke()
      }
      return
    case 'text':
      context.font = cssFont(op.font)
      context.fillStyle = palette[op.color]
      context.fillText(op.text, op.x, op.y + op.height / 2)
      return
    case 'code': {
      let x = op.x
      for (const span of op.spans) {
        context.font = cssFont(op.font, span.tone === 'key' ? 600 : op.font.weight, span.tone === 'comment')
        context.fillStyle = palette[TONE_COLORS[span.tone]]
        context.fillText(span.text, x, op.y + op.height / 2)
        x += context.measureText(span.text).width
      }
      return
    }
  }
}

/** Desenha o layout no canvas, redimensionado para a escala de exportação.
 * Devolve `false` quando não há contexto 2D. */
export function drawScreenshot(canvas: HTMLCanvasElement, layout: ScreenshotLayout, palette: ScreenshotPalette, scale = SCREENSHOT_SCALE): boolean {
  canvas.width = Math.round(layout.width * scale)
  canvas.height = Math.round(layout.height * scale)
  const context = canvas.getContext('2d')
  if (!context) return false
  context.setTransform(scale, 0, 0, scale, 0, 0)
  context.fillStyle = palette.bg
  context.fillRect(0, 0, layout.width, layout.height)
  context.textBaseline = 'middle'
  context.textAlign = 'left'
  for (const op of layout.ops) drawOp(context, op, palette)
  return true
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas vazio'))), 'image/png')
  })
}
