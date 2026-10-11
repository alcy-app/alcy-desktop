import { useContext } from 'react'
import { GitlabContext, type GitlabContextValue } from './gitlab-context'

export function useGitlab(): GitlabContextValue {
  const context = useContext(GitlabContext)
  if (!context) {
    throw new Error('useGitlab precisa ser usado dentro de GitlabProvider')
  }
  return context
}
