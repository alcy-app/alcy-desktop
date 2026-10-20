import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { LANGUAGE_STORAGE_KEY } from '../../shared/i18n/translations'
import { emptyRequestContent } from '../request-workbench/collection-tree'
import type { TreeNode } from '../request-workbench/collection-tree'
import { RequestEndpoint } from './RequestEndpoint'

const wrapper = ({ children }: { children: ReactNode }) => <LanguageProvider>{children}</LanguageProvider>
const request = { id: 'users', name: 'Users', protocol: 'rest' as const, content: { ...emptyRequestContent('rest'), endpointUrl: 'https://api.test/users' } }
const collections: TreeNode[] = [{ id: 'api', name: 'Sample API', folders: [], requests: [request], authentication: { type: 'none' }, variables: [] }]

beforeEach(() => localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en'))

describe('request URL selection', () => {
  it('opens the existing collection picker and returns the chosen request without opening the inspector', () => {
    const onSelect = vi.fn()
    const selectNode = vi.fn()
    render(<div onClick={selectNode}><RequestEndpoint url={request.content.endpointUrl} collections={collections} onSelectRequest={onSelect}>{request.content.endpointUrl}</RequestEndpoint></div>, { wrapper })
    const trigger = screen.getByRole('button', { name: "Change this node's request" })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Sample API' }))
    fireEvent.click(screen.getByRole('button', { name: /Users/ }))
    expect(onSelect).toHaveBeenCalledWith(request)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(selectNode).not.toHaveBeenCalled()
  })

  it('preserves the current request when dismissed and keeps historical endpoints read-only', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<RequestEndpoint collections={collections} onSelectRequest={onSelect}>{request.content.endpointUrl}</RequestEndpoint>, { wrapper })
    fireEvent.click(screen.getByRole('button'))
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(onSelect).not.toHaveBeenCalled()
    rerender(<RequestEndpoint collections={collections} onSelectRequest={onSelect} readOnly>{request.content.endpointUrl}</RequestEndpoint>)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText(request.content.endpointUrl)).toBeInTheDocument()
  })
})
