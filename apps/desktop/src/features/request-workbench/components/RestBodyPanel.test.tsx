import { describe, expect, it, vi } from 'vitest'
import { undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { fireEvent, render, screen, waitFor } from '../../../test-utils'
import { emptyBodyState, toBodyState } from '../body-state'
import type { BodyState } from '../request-workbench.types'
import type { BodyFileStatus } from '../../../bindings/check-body-files'
import type { PickedBodyFile } from '../../../bindings/pick-body-file'
import { RestBodyPanel } from './RestBodyPanel'

const noop = () => {}
const allExist = async (_root: string, paths: string[]) => paths.map(() => 'ok' as const)
const statusesOf = (status: BodyFileStatus) => async (_root: string, paths: string[]) => paths.map(() => status)
const picked = (path: string, outsideWorkspace = false): PickedBodyFile => ({ path, outsideWorkspace, sizeBytes: 2048 })

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

  it('formats the raw JSON body, keeping comments and templates, and undoes it in one step', () => {
    const onRawChange = vi.fn()
    const { container } = renderPanel({ ...emptyBodyState, raw: '{"id":{{id}}, // note\n"ok":true}' }, { onRawChange })

    fireEvent.click(screen.getByRole('button', { name: 'Formatar corpo' }))
    expect(onRawChange).toHaveBeenLastCalledWith('{\n  "id": {{id}}, // note\n  "ok": true\n}')

    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!
    expect(undo(view)).toBe(true)
    expect(onRawChange).toHaveBeenLastCalledWith('{"id":{{id}}, // note\n"ok":true}')
  })

  it('leaves a body that cannot be formatted untouched, silently', () => {
    const onRawChange = vi.fn()
    renderPanel({ ...emptyBodyState, raw: '{"a":' }, { onRawChange })

    fireEvent.click(screen.getByRole('button', { name: 'Formatar corpo' }))
    expect(onRawChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('offers formatting only for languages that have a formatter', () => {
    renderPanel({ ...emptyBodyState, rawLanguage: 'text' })
    expect(screen.queryByRole('button', { name: 'Formatar corpo' })).not.toBeInTheDocument()
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
    const pickFile = vi.fn(async () => picked('files/photo.png'))
    const body = toBodyState({ type: 'formData', fields: [{ kind: 'file', name: 'file', enabled: true, filePath: '' }] })
    const { rerender } = renderPanel(body, { onUpdateFormData, pickFile })

    fireEvent.click(screen.getByRole('button', { name: 'Selecionar arquivo' }))
    await waitFor(() => expect(onUpdateFormData).toHaveBeenCalledWith(body.formData[0].id, { filePath: 'files/photo.png' }))
    expect(pickFile).toHaveBeenCalledWith('/home/ana/api', '')

    const withFile = { ...body, formData: [{ ...body.formData[0], filePath: 'files/photo.png' }] }
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
    expect(screen.queryByText('Copiar para o workspace')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remover arquivo photo.png' }))
    expect(onUpdateFormData).toHaveBeenLastCalledWith(body.formData[0].id, { filePath: '' })
  })

  it('escolhe e limpa o arquivo do corpo binary', async () => {
    const onBinaryFileChange = vi.fn()
    renderPanel({ ...emptyBodyState, type: 'binary' }, { onBinaryFileChange, pickFile: async () => picked('files/a.zip') })
    expect(screen.getByText('Nenhum arquivo selecionado')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar arquivo' }))
    await waitFor(() => expect(onBinaryFileChange).toHaveBeenCalledWith('files/a.zip'))
  })

  it('não altera o arquivo quando o diálogo é cancelado', async () => {
    const onBinaryFileChange = vi.fn()
    const pickFile = vi.fn(async () => null)
    renderPanel({ ...emptyBodyState, type: 'binary', binaryFilePath: '/tmp/a.bin' }, { onBinaryFileChange, pickFile })
    expect(screen.getByText('a.bin')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Trocar arquivo' }))
    await waitFor(() => expect(pickFile).toHaveBeenCalledWith('/home/ana/api', '/tmp/a.bin'))
    expect(onBinaryFileChange).not.toHaveBeenCalled()
  })

  it('oferece copiar para o workspace um arquivo escolhido fora dele', async () => {
    const onBinaryFileChange = vi.fn()
    const copyFile = vi.fn(async () => ({ ok: true as const, value: { path: 'files/a.zip' } }))
    renderPanel(
      { ...emptyBodyState, type: 'binary' },
      { onBinaryFileChange, copyFile, pickFile: async () => picked('C:\\dados\\a.zip', true) },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Selecionar arquivo' }))
    await waitFor(() => expect(onBinaryFileChange).toHaveBeenCalledWith('C:\\dados\\a.zip'))
    expect(screen.getByText(/a\.zip \(.+\) está fora do workspace\./)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copiar para o workspace' }))
    await waitFor(() => expect(onBinaryFileChange).toHaveBeenLastCalledWith('files/a.zip'))
    expect(copyFile).toHaveBeenCalledWith('/home/ana/api', 'C:\\dados\\a.zip')
    expect(screen.queryByText('Copiar para o workspace')).not.toBeInTheDocument()
  })

  it('mantém o caminho absoluto quando a cópia é recusada', async () => {
    const onBinaryFileChange = vi.fn()
    const copyFile = vi.fn()
    renderPanel(
      { ...emptyBodyState, type: 'binary' },
      { onBinaryFileChange, copyFile, pickFile: async () => picked('/home/ana/outros/a.zip', true) },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Selecionar arquivo' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Manter caminho' }))

    expect(onBinaryFileChange).toHaveBeenCalledTimes(1)
    expect(copyFile).not.toHaveBeenCalled()
    expect(screen.queryByText('Copiar para o workspace')).not.toBeInTheDocument()
  })

  it('avisa quando o arquivo não existe nesta máquina', async () => {
    const checkFiles = vi.fn(statusesOf('missing'))
    renderPanel({ ...emptyBodyState, type: 'binary', binaryFilePath: 'files/a.zip' }, { checkFiles })
    expect(await screen.findByText('Arquivo não encontrado nesta máquina')).toBeInTheDocument()
    expect(checkFiles).toHaveBeenCalledWith('/home/ana/api', ['files/a.zip'])
  })

  it('reconsulta os arquivos quando a janela volta ao foco', async () => {
    let status: BodyFileStatus = 'missing'
    const checkFiles = vi.fn(async (_root: string, paths: string[]) => paths.map(() => status))
    renderPanel({ ...emptyBodyState, type: 'binary', binaryFilePath: 'files/a.zip' }, { checkFiles })
    expect(await screen.findByText('Arquivo não encontrado nesta máquina')).toBeInTheDocument()

    status = 'ok'
    fireEvent.focus(window)
    await waitFor(() => expect(screen.queryByText('Arquivo não encontrado nesta máquina')).not.toBeInTheDocument())
  })

  it('indica um arquivo fora do workspace que pode ser lido', async () => {
    renderPanel({ ...emptyBodyState, type: 'binary', binaryFilePath: '/tmp/a.zip' }, { checkFiles: statusesOf('outsideAllowed') })
    expect(await screen.findByText('Fora do workspace')).toBeInTheDocument()
  })

  it('marca como bloqueado um arquivo fora do workspace não escolhido nele e oferece escolher de novo', async () => {
    const pickFile = vi.fn(async () => null)
    renderPanel(
      { ...emptyBodyState, type: 'binary', binaryFilePath: '/home/ana/private/notes.txt' },
      { checkFiles: statusesOf('blocked'), pickFile },
    )
    expect(await screen.findByText('Bloqueado')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Escolher arquivo' }))
    await waitFor(() => expect(pickFile).toHaveBeenCalledWith('/home/ana/api', '/home/ana/private/notes.txt'))
  })

  it('marca o campo form-data cujo arquivo está ausente', async () => {
    const body = toBodyState({ type: 'formData', fields: [{ kind: 'file', name: 'f', enabled: true, filePath: 'files/x.png' }] })
    renderPanel(body, { checkFiles: statusesOf('missing') })
    expect(await screen.findByText('Arquivo não encontrado nesta máquina')).toBeInTheDocument()
  })

  it('consulta os arquivos de novo depois de escolher um, mesmo com o mesmo caminho', async () => {
    const checkFiles = vi.fn(statusesOf('blocked'))
    const path = '/home/ana/outros/a.zip'
    renderPanel({ ...emptyBodyState, type: 'binary', binaryFilePath: path }, { checkFiles, pickFile: async () => picked(path, true) })
    await screen.findByText('Bloqueado')
    const calls = checkFiles.mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: 'Trocar arquivo' }))
    await waitFor(() => expect(checkFiles.mock.calls.length).toBeGreaterThan(calls))
  })
})
