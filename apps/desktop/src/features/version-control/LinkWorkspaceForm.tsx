import { useEffect, useState } from 'react'
import type { GitlabBranchDto, GitlabCommandError, GitlabProjectDto } from '../../bindings/gitlab-types'
import { listGitlabBranches } from '../../bindings/list-gitlab-branches'
import { listGitlabProjects } from '../../bindings/list-gitlab-projects'
import { gitlabErrorMessage } from '../../shared/gitlab/gitlab-error-message'
import { useGitlab } from '../../shared/gitlab/use-gitlab'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { Field } from '../../shared/ui/Field'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Input } from '../../shared/ui/Input'
import { Select } from '../../shared/ui/Select'
import type { LinkParams } from './use-version-control'

const SEARCH_DEBOUNCE_MS = 300
/** Limite de páginas de branches lidas de uma vez (30 por página). */
const MAX_BRANCH_PAGES = 5

interface ProjectsResult {
  key: string
  items: GitlabProjectDto[]
  nextPage: number | null
  error: GitlabCommandError | null
}

interface BranchesResult {
  projectId: number
  items: GitlabBranchDto[]
  error: GitlabCommandError | null
}

interface LinkWorkspaceFormProps {
  busy: boolean
  error: string | null
  onSubmit: (params: LinkParams) => void
  onCancelBusy: () => void
}

/** Escolha da conta, do projeto e da branch do GitLab que guardarão os arquivos do workspace. */
export function LinkWorkspaceForm({ busy, error, onSubmit, onCancelBusy }: LinkWorkspaceFormProps) {
  const { t } = useLanguage()
  const { accounts } = useGitlab()
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [projectsResult, setProjectsResult] = useState<ProjectsResult | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selected, setSelected] = useState<GitlabProjectDto | null>(null)
  const [branchesResult, setBranchesResult] = useState<BranchesResult | null>(null)
  const [chosenBranch, setChosenBranch] = useState('')
  const [directory, setDirectory] = useState('')
  const [includeEnvironments, setIncludeEnvironments] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search])

  const projectsKey = `${accountId}|${debouncedSearch}`
  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    void listGitlabProjects({ accountId, search: debouncedSearch, page: 1 }).then((result) => {
      if (cancelled) return
      setProjectsResult(
        result.ok
          ? { key: projectsKey, items: result.value.items, nextPage: result.value.nextPage, error: null }
          : { key: projectsKey, items: [], nextPage: null, error: result.error },
      )
    })
    return () => {
      cancelled = true
    }
  }, [accountId, debouncedSearch, projectsKey])

  const projectId = selected?.id ?? null
  useEffect(() => {
    if (!accountId || projectId === null) return
    let cancelled = false
    void (async () => {
      const items: GitlabBranchDto[] = []
      let page: number | null = 1
      for (let fetched = 0; page !== null && fetched < MAX_BRANCH_PAGES; fetched += 1) {
        const result = await listGitlabBranches({ accountId, projectId, page })
        if (cancelled) return
        if (!result.ok) {
          setBranchesResult({ projectId, items, error: result.error })
          return
        }
        items.push(...result.value.items)
        page = result.value.nextPage
      }
      setBranchesResult({ projectId, items, error: null })
    })()
    return () => {
      cancelled = true
    }
  }, [accountId, projectId])

  const projectsLoading = projectsResult?.key !== projectsKey
  const projects = projectsResult?.key === projectsKey ? projectsResult : null
  const branches = branchesResult?.projectId === projectId ? branchesResult : null
  const branchOptions = branches?.items ?? []
  const writableBranches = branchOptions.filter((branch) => branch.canPush)
  const defaultBranch = writableBranches.find((branch) => branch.name === selected?.defaultBranch)?.name
    ?? writableBranches.find((branch) => branch.isDefault)?.name
    ?? writableBranches[0]?.name
    ?? ''
  const branch = writableBranches.some((option) => option.name === chosenBranch) ? chosenBranch : defaultBranch

  const loadMore = async () => {
    if (!projects || projects.nextPage === null) return
    setLoadingMore(true)
    const result = await listGitlabProjects({ accountId, search: debouncedSearch, page: projects.nextPage })
    setLoadingMore(false)
    if (!result.ok) {
      setProjectsResult({ ...projects, error: result.error })
      return
    }
    setProjectsResult({
      key: projects.key,
      items: [...projects.items, ...result.value.items],
      nextPage: result.value.nextPage,
      error: null,
    })
  }

  const canSubmit = selected !== null && branch !== '' && !busy

  const submit = () => {
    if (!selected) return
    onSubmit({
      provider: 'gitlab',
      accountId,
      projectId: selected.id,
      projectPath: selected.pathWithNamespace,
      branch,
      directory: directory.trim(),
      includeEnvironments,
    })
  }

  return (
    <form
      className="vc-link-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit) submit()
      }}
    >
      <h3 className="vc-section-title">{t('vc.link.title')}</h3>

      {accounts.length > 1 && (
        <Field label={t('vc.link.account')}>
          {(id) => (
            <Select
              id={id}
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value)
                setSelected(null)
              }}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.username} · {account.baseUrl}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      <Field label={t('vc.link.projectSearch')}>
        {(id) => (
          <Input
            id={id}
            value={search}
            placeholder={t('vc.link.projectSearchPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
      </Field>
      <div className="vc-project-list" role="listbox" aria-label={t('vc.link.projectSearch')} aria-busy={projectsLoading}>
        {projectsLoading && <p className="vc-muted">{t('vc.link.projectsLoading')}</p>}
        {projects?.error && <InlineAlert>{gitlabErrorMessage(projects.error, t)}</InlineAlert>}
        {projects && !projects.error && projects.items.length === 0 && <p className="vc-muted">{t('vc.link.noProjects')}</p>}
        {projects?.items.map((project) => (
          <button
            key={project.id}
            type="button"
            role="option"
            aria-selected={selected?.id === project.id}
            className="vc-project-option"
            onClick={() => {
              setSelected(project)
              setChosenBranch('')
            }}
          >
            {project.pathWithNamespace}
          </button>
        ))}
        {projects && projects.nextPage !== null && (
          <Button variant="ghost" isLoading={loadingMore} onClick={() => void loadMore()}>
            {t('vc.link.loadMore')}
          </Button>
        )}
      </div>

      {selected && (
        <Field label={t('vc.link.branch')}>
          {(id) => (
            <Select id={id} value={branch} disabled={branches === null} onChange={(event) => setChosenBranch(event.target.value)}>
              {branchOptions.map((option) => (
                <option key={option.name} value={option.name} disabled={!option.canPush}>
                  {option.name}{option.canPush ? '' : ` — ${t('vc.link.readOnly')}`}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {branches?.error && <InlineAlert>{gitlabErrorMessage(branches.error, t)}</InlineAlert>}
      {branches && !branches.error && branchOptions.length > 0 && writableBranches.length === 0 && (
        <InlineAlert>{t('vc.link.noWritableBranches')}</InlineAlert>
      )}

      <Field label={t('vc.link.directory')}>
        {(id) => (
          <Input
            id={id}
            mono
            value={directory}
            placeholder={t('vc.link.directoryPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setDirectory(event.target.value)}
          />
        )}
      </Field>

      <label className="vc-checkbox-row">
        <Checkbox checked={includeEnvironments} onChange={(event) => setIncludeEnvironments(event.target.checked)} />
        <span>
          {t('vc.link.includeEnvironments')}
          <span className="vc-muted vc-checkbox-hint">{t('vc.link.includeEnvironmentsHint')}</span>
        </span>
      </label>

      {error && <InlineAlert>{error}</InlineAlert>}

      <div className="vc-actions">
        {busy && (
          <Button variant="ghost" onClick={onCancelBusy}>
            {t('gitlab.cancel')}
          </Button>
        )}
        <Button type="submit" disabled={!canSubmit} isLoading={busy}>
          {t('vc.link.submit')}
        </Button>
      </div>
    </form>
  )
}
