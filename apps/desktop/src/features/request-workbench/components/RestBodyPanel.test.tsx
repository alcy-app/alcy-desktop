import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../../test-utils'
import { emptyBodyState, toBodyState } from '../body-state'
import type { BodyState } from '../request-workbench.types'
import { RestBodyPanel } from './RestBodyPanel'

const noop = () => {}
const allExist = async (_root: string, paths: string[]) => paths.map(() => true)

function renderPanel(body: BodyState, overrides: Partial<Parameters<typeof RestBodyPanel>[0]> = {}) {
  return render(
    <RestBodyPanel
      body={body}
      rootPath="/home/ana/api"
      checkFiles={allExist}
      onTypeChange={noop}
      onRawLanguageChange={noop}
      onRawChange={noop}
      onAddUrlEncoded={noop}
      onUpdateUrlEncoded={noop}
      onRemoveUrlEncoded={noop}
      onReplaceUrlEncoded={noop}
      onAddFormData={noop}
      onUpdateFormData={noop}
      onRemoveFormData={noop}
      onBinaryFileChange={noop}
      environmentVariables={[]}
      pickFile={async () => null}
      {...overrides}
    />,
  )
}

describe('RestBodyPanel', () => {
  it('mostra os cinco tipos de corpo, com raw marcado por padrão', () => {
    renderPanel(emptyBodyState)
    const group = screen.getByRole('radiogroup', { name: 'Tipo de corpo' })
    const options = Array.from(group.querySelectorAll('[role="radio"]')).map((option) => option.textContent)
    expect(options).toEqual(['none', 'form-data', 'x-www-form-urlencoded', 'raw', 'binary'])
    expect(screen.getByRole('radio', { name: 'raw' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('textbox', { name: 'Corpo da requisição' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Formato do corpo raw' })).toHaveTextContent('JSON')
  })

  it('troca de tipo pelo clique e pelas setas do teclado', () => {
    const onTypeChange = vi.fn()
    renderPanel(emptyBodyState, { onTypeChange })

    fireEvent.click(screen.getByRole('radio', { name: 'form-data' }))
    expect(onTypeChange).toHaveBeenLastCalledWith('formData')

    fireEvent.keyDown(screen.getByRole('radio', { name: 'raw' }), { key: 'ArrowRight' })
    expect(onTypeChange).toHaveBeenLastCalledWith('binary')
    fireEvent.keyDown(screen.getByRole('radio', { name: 'none' }), { key: 'ArrowLeft' })
    expect(onTypeChange).toHaveBeenLastCalledWith('binary')
  })

  it('escolhe a linguagem do corpo raw', () => {
    const onRawLanguageChange = vi.fn()
    renderPanel(emptyBodyState, { onRawLanguageChange })
    fireEvent.click(screen.getByRole('combobox', { name: 'Formato do corpo raw' }))
    fireEvent.click(screen.getByRole('option', { name: 'XML' }))
    expect(onRawLanguageChange).toHaveBeenCalledWith('xml')
  })

  it('explica que "none" não envia corpo', () => {
    renderPanel({ ...emptyBodyState, type: 'none' })
    expect(screen.getByText('Esta requisição não envia corpo.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Formato do corpo raw' })).not.toBeInTheDocument()
  })

  it('edita os campos x-www-form-urlencoded', () => {
    const onUpdateUrlEncoded = vi.fn()
    const onAddUrlEncoded = vi.fn()
    renderPanel(toBodyState({ type: 'urlencoded', fields: [{ name: 'user', value: 'ada', enabled: true }] }), {
      onUpdateUrlEncoded,
      onAddUrlEncoded,
    })
    fireEvent.change(screen.getByLabelText('Valor do campo'), { target: { value: 'grace' } })
    expect(onUpdateUrlEncoded).toHaveBeenCalledWith(expect.any(String), { value: 'grace' })
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar campo' }))
    expect(onAddUrlEncoded).toHaveBeenCalled()
  })

  it('escolhe o arquivo de um campo form-data e mostra só o nome', async () => {
    const onUpdateFormData = vi.fn()
    const pickFile = vi.fn(async () => '/home/ana/photo.png')
    const body = toBodyState({ type: 'formData', fields: [{ kind: 'file', name: 'file', enabled: true, filePath: '' }] })
    const { rerender } = renderPanel(body, { onUpdateFormData, pickFile })

    fireEvent.click(screen.getByRole('button', { name: 'Selecionar arquivo' }))
    await waitFor(() => expect(onUpdateFormData).toHaveBeenCalledWith(body.formData[0].id, { filePath: '/home/ana/photo.png' }))

    const withFile = { ...body, formData: [{ ...body.formData[0], filePath: '/home/ana/photo.png' }] }
    rerender(
      <RestBodyPanel
        body={withFile}
        rootPath="/home/ana/api"
        checkFiles={allExist}
        onTypeChange={noop}
        onRawLanguageChange={noop}
        onRawChange={noop}
        onAddUrlEncoded={noop}
        onUpdateUrlEncoded={noop}
        onRemoveUrlEncoded={noop}
        onReplaceUrlEncoded={noop}
        onAddFormData={noop}
        onUpdateFormData={onUpdateFormData}
        onRemoveFormData={noop}
        onBinaryFileChange={noop}
        environmentVariables={[]}
        pickFile={pickFile}
      />,
    )
    expect(screen.getByRole('button', { name: 'photo.png' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remover arquivo photo.png' }))
    expect(onUpdateFormData).toHaveBeenLastCalledWith(body.formData[0].id, { filePath: '' })
  })

  it('escolhe e limpa o arquivo do corpo binary', async () => {
    const onBinaryFileChange = vi.fn()
    renderPanel({ ...emptyBodyState, type: 'binary' }, { onBinaryFileChange, pickFile: async () => 'C:\\dados\\a.zip' })
    expect(screen.getByText('Nenhum arquivo selecionado')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar arquivo' }))
    await waitFor(() => expect(onBinaryFileChange).toHaveBeenCalledWith('C:\\dados\\a.zip'))
  })

  it('não altera o arquivo quando o diálogo é cancelado', async () => {
    const onBinaryFileChange = vi.fn()
    const pickFile = vi.fn(async () => null)
    renderPanel({ ...emptyBodyState, type: 'binary', binaryFilePath: '/tmp/a.bin' }, { onBinaryFileChange, pickFile })
    expect(screen.getByText('a.bin')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Trocar arquivo' }))
    await waitFor(() => expect(pickFile).toHaveBeenCalled())
    expect(onBinaryFileChange).not.toHaveBeenCalled()
  })

  it('salva com caminho relativo um arquivo escolhido dentro do workspace', async () => {
    const onBinaryFileChange = vi.fn()
    renderPanel({ ...emptyBodyState, type: 'binary' }, { onBinaryFileChange, pickFile: async () => '/home/ana/api/files/a.zip' })
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar arquivo' }))
    await waitFor(() => expect(onBinaryFileChange).toHaveBeenCalledWith('files/a.zip'))
  })

  it('avisa quando o arquivo não existe nesta máquina', async () => {
    const checkFiles = vi.fn(async (_root: string, paths: string[]) => paths.map(() => false))
    renderPanel({ ...emptyBodyState, type: 'binary', binaryFilePath: 'files/a.zip' }, { checkFiles })
    expect(await screen.findByText('Arquivo não encontrado nesta máquina')).toBeInTheDocument()
    expect(checkFiles).toHaveBeenCalledWith('/home/ana/api', ['files/a.zip'])
  })

  it('reconsulta os arquivos quando a janela volta ao foco', async () => {
    let exists = false
    const checkFiles = vi.fn(async (_root: string, paths: string[]) => paths.map(() => exists))
    renderPanel({ ...emptyBodyState, type: 'binary', binaryFilePath: 'files/a.zip' }, { checkFiles })
    expect(await screen.findByText('Arquivo não encontrado nesta máquina')).toBeInTheDocument()

    exists = true
    fireEvent.focus(window)
    await waitFor(() => expect(screen.queryByText('Arquivo não encontrado nesta máquina')).not.toBeInTheDocument())
  })

  it('indica um arquivo fora do workspace, cujo caminho absoluto fica salvo', async () => {
    renderPanel({ ...emptyBodyState, type: 'binary', binaryFilePath: '/tmp/a.zip' })
    expect(await screen.findByText('Fora do workspace')).toBeInTheDocument()
  })

  it('marca o campo form-data cujo arquivo está ausente', async () => {
    const body = toBodyState({ type: 'formData', fields: [{ kind: 'file', name: 'f', enabled: true, filePath: 'files/x.png' }] })
    renderPanel(body, { checkFiles: async (_root, paths) => paths.map(() => false) })
    expect(await screen.findByText('Arquivo não encontrado nesta máquina')).toBeInTheDocument()
  })
})
