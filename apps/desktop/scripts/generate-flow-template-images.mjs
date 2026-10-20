// Run with `node apps/desktop/scripts/generate-flow-template-images.mjs` after changing template graphs or node visuals.
// Uses the existing renderer, bundled fonts, Firefox and Pillow; it never contacts API endpoints.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Position, ReactFlowProvider, getSmoothStepPath, useStoreApi } from '@xyflow/react'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'src/features/flows/template-images')
const cache = join(root, 'dist-ssr/flow-template-images')
mkdirSync(output, { recursive: true })
mkdirSync(cache, { recursive: true })
const server = await createServer({ root, server: { middlewareMode: true }, configFile: false, plugins: [(await import('@vitejs/plugin-react')).default()] })
const width = 960, height = 420
const padding = 56

function StaticNodes({ children }) {
  // Standalone cards paint their visual handles without an editor node identity.
  useStoreApi().setState({ onError: (code, message) => { if (code !== '010') throw new Error(message) } })
  return children
}

try {
  const { FLOW_TEMPLATES, createFlowFromTemplate } = await server.ssrLoadModule('/src/features/flows/flow-templates.ts')
  const { toFlowNodes, toFlowEdges, terminalFlowNodeIds } = await server.ssrLoadModule('/src/features/flows/flow-canvas-mapping.ts')
  const { nodeTypes } = await server.ssrLoadModule('/src/features/flows/flow-node-types.ts')
  const { flowLayoutModel } = await server.ssrLoadModule('/src/features/flows/flow-layout-model.ts')
  const { flowGeometryStyle } = await server.ssrLoadModule('/src/features/flows/flow-geometry.ts')
  const { LOAD_NODE_DEFINITIONS } = await server.ssrLoadModule('/src/features/flows/load-node-config.ts')
  const { LanguageContext } = await server.ssrLoadModule('/src/shared/i18n/language-context.ts')
  const { translate } = await server.ssrLoadModule('/src/shared/i18n/translations.ts')

  const css = ['src/styles/tokens.css', 'src/shared/ui/forms.css', 'src/features/flows/flow-canvas.css', 'src/features/flows/flow-studio.css']
    .map((path) => readFileSync(join(root, path), 'utf8')).join('\n')
  const fonts = readFileSync(join(root, 'src/styles/fonts.css'), 'utf8').replace(/url\('\.\.\/assets\/fonts\/([^']+)'\)/g, (_, name) => `url('data:font/woff2;base64,${readFileSync(join(root, 'src/assets/fonts', name)).toString('base64')}')`)
  const images = []
  for (const theme of ['light', 'dark']) for (const language of ['en', 'pt-BR']) for (const template of FLOW_TEMPLATES) {
    const t = (key, params) => translate(language, key, params)
    const flow = createFlowFromTemplate(template.id, t)
    const nodes = toFlowNodes(flow.nodes.filter((node) => node.kind !== 'note'))
    const edges = toFlowEdges(flow.edges)
    const model = flowLayoutModel(nodes, edges)
    const byId = new Map(model.nodes.map((node) => [node.id, node]))
    const terminalIds = terminalFlowNodeIds(nodes, edges)
    const graphWidth = Math.max(...model.nodes.map((node) => node.position.x + node.width))
    const graphHeight = Math.max(...model.nodes.map((node) => node.position.y + node.height))
    const scale = Math.min((width - padding * 2) / graphWidth, (height - padding * 2) / graphHeight, 1.6)
    const edgePaths = edges.map((edge) => {
      const source = byId.get(edge.source), target = byId.get(edge.target)
      const original = nodes.find((node) => node.id === edge.source)
      const handles = original.type === 'block' && original.data.loadKind
        ? LOAD_NODE_DEFINITIONS[original.data.loadKind].outputs
        : ['if', 'while', 'inlineRequest'].includes(original.type)
          ? original.type === 'if' ? ['true', 'false'] : original.type === 'while' ? ['loop', 'done'] : ['success', 'failure']
          : []
      const sourceY = source.position.y + (Array.isArray(handles) && handles.includes(edge.sourceHandle) ? 80 + (handles.indexOf(edge.sourceHandle) + 0.5) * 24 : original.type === 'start' ? 28 : 20)
      const [path] = getSmoothStepPath({ sourceX: source.position.x + source.width, sourceY, sourcePosition: Position.Right, targetX: target.position.x, targetY: target.position.y + 20, targetPosition: Position.Left, borderRadius: 4, offset: 32 })
      return h('path', { key: edge.id, d: path, fill: 'none', stroke: 'var(--text-muted)', strokeWidth: 1.25 })
    })
    const markup = renderToStaticMarkup(h(LanguageContext.Provider, { value: { language, t, setLanguage: () => {} } },
      h(ReactFlowProvider, {}, h(StaticNodes, {}, h('div', { className: 'flow-studio', style: flowGeometryStyle },
        h('svg', { width: graphWidth, height: graphHeight, style: { position: 'absolute', overflow: 'visible' } }, edgePaths),
        nodes.map((node) => h('div', { key: node.id, className: terminalIds.has(node.id) ? 'flow-terminal-node' : '', style: { position: 'absolute', left: node.position.x, top: node.position.y } },
          h(nodeTypes[node.type], { id: node.id, type: node.type, data: { ...node.data, readOnly: true }, isConnectable: false, selected: false, dragging: false, zIndex: 0, positionAbsoluteX: node.position.x, positionAbsoluteY: node.position.y }))),
      )))))
    images.push({ name: `${template.id}-${language}-${theme}`, html: `<section data-theme="${theme}" class="capture"><div class="stage" style="width:${graphWidth}px;height:${graphHeight}px;transform:translate(-50%,-50%) scale(${scale})">${markup}</div></section>` })
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${fonts}\n${css}\n*{box-sizing:border-box}html,body{margin:0;padding:0}body{font-family:var(--font-sans);font-size:var(--font-size-base)}.capture{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:var(--bg)}.stage{position:absolute;left:50%;top:50%;transform-origin:center}.flow-node-preview .flow-node-visual-handle{display:block}.react-flow__handle{display:none}.flow-studio .flow-node-content svg{stroke-width:2}</style></head><body>${images.map((image) => image.html).join('')}</body></html>`
  const page = join(cache, 'atlas.html')
  const screenshot = join(cache, 'atlas.png')
  writeFileSync(page, html)
  const profile = mkdtempSync(join(cache, 'firefox-'))
  try {
    rmSync(screenshot, { force: true })
    const capture = spawnSync('firefox', ['--headless', '--no-remote', '--profile', profile, '--screenshot', screenshot, '--window-size', `${width},${height * images.length}`, pathToFileURL(page).href], { encoding: 'utf8', timeout: 60000 })
    if (capture.status !== 0 || !existsSync(screenshot)) throw new Error(capture.error?.message ?? `${capture.stdout}\n${capture.stderr}`)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
  const crop = spawnSync('python3', ['-c', 'import json,sys\nfrom PIL import Image\nfrom pathlib import Path\nsource=Image.open(sys.argv[1])\nfor index,name in enumerate(json.loads(sys.argv[3])):\n source.crop((0,index*420,960,(index+1)*420)).save(Path(sys.argv[2])/(name+".png"), optimize=True)', screenshot, output, JSON.stringify(images.map((image) => image.name))], { encoding: 'utf8' })
  if (crop.status !== 0) throw new Error(crop.stderr)
  console.log(`Generated ${images.length} static flow thumbnails in ${output}`)
} finally {
  await server.close()
}
