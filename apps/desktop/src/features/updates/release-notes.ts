import changelog from '../../../../../CHANGELOG.md?raw'
import { APP_VERSION } from '../../shared/app-version'
import { translate } from '../../shared/i18n/translations'
import type { AppNotification } from '../notifications/notifications.types'
import { localized } from './update-notification'

export interface ReleaseNotes {
  version: string
  /** `AAAA-MM-DD`; `null` quando o título da versão não traz data. */
  date: string | null
  /** Markdown da seção da versão, sem o título. */
  body: string
}

const VERSION_HEADING = /^## \[([^\]]+)\](?:\s*-\s*(\S+))?/
/** Definições de link do rodapé (`[0.1.0]: https://…`), que não fazem parte do texto. */
const LINK_DEFINITION = /^\[[^\]]+\]:\s/
const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/

interface ChangelogSection {
  version: string
  date: string | null
  dateLabel: string | null
  lines: string[]
}

/** Aceita as duas grafias de data do changelog: `2026-09-25` e `30/09/2026`. */
function isoDate(raw: string | undefined): string | null {
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw)
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null
}

/**
 * Seção `## [versão]` do changelog. `fallbackToUnreleased` usa `[Unreleased]`
 * quando a versão ainda não tem seção, para o desenvolvimento ter o que mostrar.
 */
export function extractReleaseNotes(source: string, version: string, fallbackToUnreleased = false): ReleaseNotes | null {
  const sections = new Map<string, ChangelogSection>()
  let current: string[] | null = null

  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = VERSION_HEADING.exec(line)
    if (heading) {
      current = []
      if (!sections.has(heading[1])) {
        sections.set(heading[1], { version: heading[1], date: isoDate(heading[2]), dateLabel: heading[2] ?? null, lines: current })
      }
      else current = null
    } else if (line.startsWith('## ')) {
      current = null
    } else if (current && !LINK_DEFINITION.test(line)) {
      current.push(line)
    }
  }

  const section = sections.get(version) ?? (fallbackToUnreleased ? sections.get('Unreleased') : undefined)
  const body = section?.lines.join('\n').trim()
  if (!section || !body) return null
  if (section.version !== version) return { version, date: section.date, body }

  const stableVersion = STABLE_VERSION.exec(version)
  if (!stableVersion) return { version, date: section.date, body }

  const [, major, minor, targetPatch] = stableVersion
  const sameMinorSections = [...sections.values()]
    .filter((candidate) => {
      const candidateVersion = STABLE_VERSION.exec(candidate.version)
      return candidateVersion?.[1] === major && candidateVersion[2] === minor && Number(candidateVersion[3]) <= Number(targetPatch) && candidate.lines.join('\n').trim()
    })
    .sort((left, right) => Number(STABLE_VERSION.exec(right.version)![3]) - Number(STABLE_VERSION.exec(left.version)![3]))

  if (sameMinorSections.length === 1) return { version, date: section.date, body }

  return {
    version,
    date: section.date,
    body: sameMinorSections
      .map((candidate) => `## [${candidate.version}]${candidate.dateLabel ? ` - ${candidate.dateLabel}` : ''}\n\n${candidate.lines.join('\n').trim()}`)
      .join('\n\n'),
  }
}

/** Aba "Novidades da versão" do changelog embutido no build. O changelog é
 * escrito em inglês e aparece igual nos dois idiomas. */
export function releaseNotesNotification(notes: ReleaseNotes): AppNotification {
  return {
    id: `release-notes:${notes.version}`,
    kind: 'update',
    date: notes.date ?? '',
    title: localized((language) => translate(language, 'releaseNotes.title', { version: notes.version })),
    message: localized(() => ''),
    details: localized(() => notes.body),
  }
}

const CURRENT_NOTES = extractReleaseNotes(changelog, APP_VERSION, import.meta.env.DEV)

/** Novidades da versão em execução; `null` quando o changelog não tem a seção dela. */
export const CURRENT_RELEASE_NOTES: AppNotification | null = CURRENT_NOTES ? releaseNotesNotification(CURRENT_NOTES) : null
