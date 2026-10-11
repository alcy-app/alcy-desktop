#!/usr/bin/env node
// Sensor leve: falha se CSS de feature usar cor hex/rgba, font-size em px ou
// border-radius em px fora de src/styles/tokens.css — os valores devem vir
// dos design tokens.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

const EXCLUDED_FILES = new Set(['styles/tokens.css', 'styles/fonts.css'])

// Exceções documentadas, por arquivo -> linhas permitidas.
const ALLOWLIST = {
  'shared/ui/modal.css': new Set([7]), // scrim do backdrop — única cor fora dos tokens no app
  'features/request-workbench/request-workbench.css': new Set([636]), // fundo do preview de HTML (ADR 0008) — deliberadamente branco, independente do tema do app, já que o HTML de terceiros assume fundo claro por padrão
}

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/
const RGB_COLOR = /\brgba?\(/
const FONT_SIZE_DECLARATION = /font-size:\s*([^;]+);/
const RADIUS_DECLARATION = /border-radius:\s*([^;]+);/

function isRawFontSize(value) {
  const trimmed = value.trim()
  return trimmed !== 'inherit' && !trimmed.startsWith('var(')
}

function collectCssFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      collectCssFiles(full, out)
    } else if (entry.endsWith('.css')) {
      out.push(full)
    }
  }
  return out
}

function hasRawRadius(value) {
  return value.split(/\s+/).some((part) => /^\d/.test(part) && part !== '0')
}

const violations = []

for (const file of collectCssFiles(SRC_DIR)) {
  const relPath = relative(SRC_DIR, file)
  if (EXCLUDED_FILES.has(relPath)) continue
  const allowedLines = ALLOWLIST[relPath] ?? new Set()

  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    const lineNo = index + 1
    if (allowedLines.has(lineNo)) return

    if (HEX_COLOR.test(line) || RGB_COLOR.test(line)) {
      violations.push(`${relPath}:${lineNo}: cor fora dos tokens — ${line.trim()}`)
    }
    const fontMatch = FONT_SIZE_DECLARATION.exec(line)
    if (fontMatch && isRawFontSize(fontMatch[1])) {
      violations.push(`${relPath}:${lineNo}: font-size sem token — ${line.trim()}`)
    }
    const radiusMatch = RADIUS_DECLARATION.exec(line)
    if (radiusMatch && hasRawRadius(radiusMatch[1])) {
      violations.push(`${relPath}:${lineNo}: border-radius sem token — ${line.trim()}`)
    }
  })
}

if (violations.length > 0) {
  console.error('check-css-tokens: valores fora dos design tokens encontrados:\n')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(`\n${violations.length} violação(ões). Use os tokens de src/styles/tokens.css.`)
  process.exit(1)
}

console.log('check-css-tokens: ok — nenhum valor de cor/font-size/border-radius fora dos tokens.')
