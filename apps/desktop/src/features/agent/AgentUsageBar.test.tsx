import { describe, expect, it } from 'vitest'
import { render, screen } from '../../test-utils'
import type { AgentProviderDto } from '../../bindings/agent-settings'
import { AgentUsageBar } from './AgentUsageBar'

const provider: AgentProviderDto = { id: 'claude', kind: 'anthropic', label: 'Claude', baseUrl: 'https://api.anthropic.com', model: 'm', dailyTokenLimit: null, weeklyTokenLimit: null, hasApiKey: true }
const usage = { today: { input: 12_000, output: 400 }, week: { input: 90_000, output: 5_000 } }

describe('AgentUsageBar', () => {
  it('shows today and the week without meters when there are no limits', () => {
    render(<AgentUsageBar provider={provider} usage={usage} />)
    const group = screen.getByRole('group', { name: 'Uso de tokens de Claude' })
    expect(group).toHaveTextContent('Hoje')
    expect(group).toHaveTextContent('Semana')
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
    expect(screen.getByText('Hoje').parentElement).toHaveAttribute('title', 'Entrada: 12.000 · Saída: 400')
  })

  it('warns near a limit and says when one was reached, without blocking anything', () => {
    render(<AgentUsageBar provider={{ ...provider, dailyTokenLimit: 15_000, weeklyTokenLimit: 90_000 }} usage={usage} />)
    const [daily, weekly] = screen.getAllByRole('meter')
    expect(daily).toHaveAttribute('aria-valuenow', '12400')
    expect(daily.parentElement).toHaveAttribute('data-level', 'warning')
    expect(weekly.parentElement).toHaveAttribute('data-level', 'exceeded')
    expect(screen.getByRole('status')).toHaveTextContent('Limite semanal atingido')
  })
})
