import { useLayoutEffect } from 'react'
import { ReactFlow, ReactFlowProvider, useStoreApi, type NodeProps } from '@xyflow/react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { DisplayViewport } from './DisplayViewport'
import { DisplayValue } from './DisplayValue'
import { FlowNodeCard } from './FlowNodeCard'
import { flowNodeSize } from './flow-geometry'

const duplicate = vi.fn()
const initialNodes = [{ id: 'display', type: 'test', position: { x: 48, y: 64 }, ...flowNodeSize('display'), selected: true, className: 'flow-terminal-node', data: {} }, { id: 'request', type: 'test', position: { x: -300, y: 64 }, ...flowNodeSize('request', 2), data: {} }]

function TestNode({ id }: NodeProps) {
  if (id === 'request') return <FlowNodeCard kind="request" outputs={[{ id: 'success', label: 'Success', variant: 'positive' }, { id: 'failure', label: 'Failure', variant: 'negative' }]} />
  return <FlowNodeCard kind="display" onDuplicate={duplicate}><DisplayViewport><DisplayValue value='{"address":{"city":"London"}}' format="auto" compact /></DisplayViewport></FlowNodeCard>
}
const nodeTypes = { test: TestNode }

function Viewport({ zoom, x }: { zoom: number; x: number }) {
  const store = useStoreApi()
  useLayoutEffect(() => { store.setState({ transform: [x, 23, zoom] }) }, [store, zoom, x])
  return null
}

function Scene({ zoom, x = 17 }: { zoom: number; x?: number }) {
  return <LanguageProvider><ReactFlowProvider initialNodes={initialNodes} initialWidth={1000} initialHeight={700}><div className="flow-studio"><ReactFlow nodeTypes={nodeTypes} defaultViewport={{ x, y: 23, zoom }}><Viewport zoom={zoom} x={x} /></ReactFlow></div></ReactFlowProvider></LanguageProvider>
}

describe('Flow node rendering', () => {
  it('renders the complete card outside the scaled graph while keeping its connection handles inside', () => {
    const { container } = render(<Scene zoom={1.5} />)
    const region = screen.getByRole('region')
    const card = region.closest<HTMLElement>('.flow-node')!
    const content = card.parentElement!
    const overlay = content.parentElement!
    expect(card.closest('.react-flow__viewport')).toBeNull()
    expect(card.closest('.react-flow__renderer')).not.toBeNull()
    expect(content.style.zoom).toBe('1.5')
    expect(overlay).toHaveClass('flow-terminal-node', 'flow-node-presentation--selected')
    expect(overlay.style.transform).toBe('translate(89px, 119px) translate(0%, 0%)')
    expect(overlay.style.transform).not.toContain('scale')
    expect(Number(overlay.style.zIndex)).toBeGreaterThan(2)
    expect(Number(overlay.style.zIndex)).toBeLessThan(5)
    const handles = container.querySelectorAll('.react-flow__handle')
    expect(handles).toHaveLength(5)
    handles.forEach(handle => expect(handle.closest('.flow-node-chassis')?.closest('.react-flow__viewport')).not.toBeNull())
    expect([...container.querySelectorAll('.react-flow__node[data-id="request"] .source')].map(handle => handle.getAttribute('data-handleid'))).toEqual(['success', 'failure'])
    expect(card.querySelectorAll('.react-flow__handle')).toHaveLength(0)
  })

  it('preserves expanded data, scroll and the open actions menu across pan and zoom', () => {
    const { rerender } = render(<Scene zoom={1.5} />)
    const region = screen.getByRole('region')
    fireEvent.click(screen.getByRole('button', { name: /^address / }))
    expect(screen.getByRole('button', { name: 'city "London"' })).toBeInTheDocument()
    region.scrollTop = 48
    fireEvent.click(screen.getByRole('button', { name: 'Ações do bloco' }))
    const menu = screen.getByRole('menu')
    expect(menu).toHaveClass('ui-menu--static')
    rerender(<Scene zoom={2.5} x={50} />)
    expect(screen.getByRole('region')).toBe(region)
    expect(region.closest<HTMLElement>('.flow-node-content')!.style.zoom).toBe('2.5')
    expect(region.closest<HTMLElement>('.flow-node-presentation')!.style.transform).toBe('translate(170px, 183px) translate(0%, 0%)')
    expect(region.scrollTop).toBe(48)
    expect(screen.getByRole('button', { name: 'city "London"' })).toBeInTheDocument()
    expect(screen.getByRole('menu')).toBe(menu)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicar este node' }))
    expect(duplicate).toHaveBeenCalledOnce()
  })
})
