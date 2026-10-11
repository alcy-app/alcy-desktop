import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Build do runtime do webclient exportado (ADR 0046): um único HTML com JS e
 * CSS inline, versionado em `crates/alcy-webclient/runtime/` e embutido no
 * app pelo `include_str!`. `ALCY_WEBCLIENT_OUT_DIR` troca o destino (usado
 * pelo `scripts/check-webclient-runtime.mjs`).
 */

const OUTPUT_FILE = 'alcy-webclient.html'
const CSP_MARKER = '<meta name="referrer" content="no-referrer" />'

const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`

/** Junta o bundle no HTML e acrescenta a CSP com os hashes dos blocos inline. */
function singleFile(): Plugin {
  return {
    name: 'alcy-webclient-single-file',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const outputs = Object.values(bundle)
      const assets = outputs.filter((output) => output.type === 'asset')
      const chunks = outputs.filter((output) => output.type === 'chunk')
      const html = assets.find((output) => output.fileName === OUTPUT_FILE)
      const styles = assets.filter((output) => output.fileName.endsWith('.css'))
      const chunk = chunks[0]
      const style = styles[0]
      if (!html || !chunk || !style || chunks.length !== 1 || styles.length !== 1 || assets.length !== 2) {
        this.error('o runtime do webclient precisa sair como um HTML, um JS e um CSS')
      }

      // `</script` dentro do JS fecharia o bloco; `<\/script` é o mesmo texto para o JS.
      const script = chunk.code.replaceAll('</script', '<\\/script')
      const css = String(style.source)
      let source = String(html.source)
      const scriptTag = new RegExp(`<script type="module" crossorigin src="[^"]*${chunk.fileName}"></script>`)
      const styleTag = new RegExp(`<link rel="stylesheet" crossorigin href="[^"]*${style.fileName}">`)
      if (!scriptTag.test(source) || !styleTag.test(source) || !source.includes(CSP_MARKER)) {
        this.error('HTML do webclient fora do formato esperado')
      }
      source = source.replace(scriptTag, '').replace(styleTag, '')
      source = source.replace('</body>', () => `<script type="module">${script}</script>\n  </body>`)
      source = source.replace('</head>', () => `<style>${css}</style>\n  </head>`)
      const csp = [
        "default-src 'none'",
        `script-src ${sha256(script)}`,
        `style-src ${sha256(css)}`,
        'connect-src *',
        'img-src data:',
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ')
      source = source.replace(
        CSP_MARKER,
        () => `<meta http-equiv="Content-Security-Policy" content="${csp}" />\n    ${CSP_MARKER}`,
      )
      html.source = source
      delete bundle[chunk.fileName]
      delete bundle[style.fileName]
    },
  }
}

export default defineConfig({
  plugins: [react(), singleFile()],
  // O HTML é aberto de qualquer lugar (arquivo local ou subpasta de um servidor).
  base: './',
  // Nada de `public/` (ícones do app) no runtime.
  publicDir: false,
  build: {
    outDir: process.env.ALCY_WEBCLIENT_OUT_DIR ?? fileURLToPath(new URL('../../crates/alcy-webclient/runtime', import.meta.url)),
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    reportCompressedSize: false,
    rollupOptions: {
      input: fileURLToPath(new URL(`./${OUTPUT_FILE}`, import.meta.url)),
    },
  },
})
