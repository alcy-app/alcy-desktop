import type { ComponentType } from 'react'
import type { TranslationKey } from '../../shared/i18n/translations'
import {
  BellIcon,
  BlockIcon,
  BranchIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  EyeIcon,
  FlowIcon,
  GearIcon,
  GlobeIcon,
  MockServerIcon,
  PencilIcon,
  RefreshIcon,
  RunnerIcon,
  SendIcon,
  StopIcon,
  TerminalIcon,
  VariablesIcon,
} from '../../shared/ui/icons'
import type { FlowNodeKindState } from './flows.types'

export type FlowNodeKind = FlowNodeKindState['kind']

/** Categoria visual de um bloco — cada uma tem um token `--flow-tone-*`
 * (spec 0087) que pinta o ícone, a borda superior e a seleção do cartão. */
export type FlowTone = 'start' | 'control' | 'request' | 'data' | 'time' | 'output' | 'note' | 'mock'

export interface NodeKindAppearance {
  tone: FlowTone
  Icon: ComponentType<{ size?: number }>
  /** Título do cartão. Bloco e requisições mostram o nome dado pelo usuário e só usam este como reserva. */
  titleKey: TranslationKey
  /** Nome do tipo na paleta de blocos. */
  labelKey: TranslationKey
  /** Subtítulo do cartão e descrição na paleta. */
  descriptionKey: TranslationKey
}

/** Uma só fonte para ícone, cor e textos de cada tipo — usada pelos nodes e pela `BlockPalette`. */
export const NODE_KIND_APPEARANCE: Record<FlowNodeKind, NodeKindAppearance> = {
  start: {
    tone: 'start',
    Icon: FlowIcon,
    titleKey: 'flows.canvas.nodeTitle.start',
    labelKey: 'flows.canvas.startNodeLabel',
    descriptionKey: 'flows.canvas.nodeDescription.start',
  },
  block: {
    tone: 'control',
    Icon: BlockIcon,
    titleKey: 'flows.canvas.newBlockLabel',
    labelKey: 'flows.canvas.newBlockLabel',
    descriptionKey: 'flows.canvas.nodeDescription.block',
  },
  if: {
    tone: 'control',
    Icon: BranchIcon,
    titleKey: 'flows.canvas.nodeTitle.if',
    labelKey: 'flows.canvas.newIfBlockLabel',
    descriptionKey: 'flows.canvas.nodeDescription.if',
  },
  while: {
    tone: 'control',
    Icon: RefreshIcon,
    titleKey: 'flows.canvas.nodeTitle.while',
    labelKey: 'flows.canvas.newWhileLabel',
    descriptionKey: 'flows.canvas.nodeDescription.while',
  },
  break: {
    tone: 'control',
    Icon: StopIcon,
    titleKey: 'flows.canvas.nodeTitle.break',
    labelKey: 'flows.canvas.newBreakLabel',
    descriptionKey: 'flows.canvas.nodeDescription.break',
  },
  continue: {
    tone: 'control',
    Icon: ChevronRightIcon,
    titleKey: 'flows.canvas.nodeTitle.continue',
    labelKey: 'flows.canvas.newContinueLabel',
    descriptionKey: 'flows.canvas.nodeDescription.continue',
  },
  sleep: {
    tone: 'time',
    Icon: ClockIcon,
    titleKey: 'flows.canvas.nodeTitle.sleep',
    labelKey: 'flows.canvas.newSleepLabel',
    descriptionKey: 'flows.canvas.nodeDescription.sleep',
  },
  setVariables: {
    tone: 'data',
    Icon: VariablesIcon,
    titleKey: 'flows.canvas.nodeTitle.setVariables',
    labelKey: 'flows.canvas.newSetVariablesLabel',
    descriptionKey: 'flows.canvas.nodeDescription.setVariables',
  },
  log: {
    tone: 'output',
    Icon: TerminalIcon,
    titleKey: 'flows.canvas.nodeTitle.log',
    labelKey: 'flows.canvas.newLogLabel',
    descriptionKey: 'flows.canvas.nodeDescription.log',
  },
  display: {
    tone: 'output',
    Icon: EyeIcon,
    titleKey: 'flows.canvas.nodeTitle.display',
    labelKey: 'flows.canvas.newDisplayLabel',
    descriptionKey: 'flows.canvas.nodeDescription.display',
  },
  request: {
    tone: 'request',
    Icon: SendIcon,
    titleKey: 'flows.canvas.newRequestBlockLabel',
    labelKey: 'flows.canvas.newRequestBlockLabel',
    descriptionKey: 'flows.canvas.nodeDescription.request',
  },
  /** Os blocos de carga usam o mesmo cartão genérico até terem um renderer
   * próprio; a entrada mantém o mapa total e tipado por `FlowNodeKind`. */
  load: {
    tone: 'control',
    Icon: RunnerIcon,
    titleKey: 'flows.canvas.nodeTitle.load',
    labelKey: 'flows.canvas.nodeTitle.load',
    descriptionKey: 'flows.canvas.nodeDescription.load',
  },
  inlineRequest: {
    tone: 'request',
    Icon: GlobeIcon,
    titleKey: 'flows.canvas.newInlineRequestLabel',
    labelKey: 'flows.canvas.newInlineRequestLabel',
    descriptionKey: 'flows.canvas.nodeDescription.inlineRequest',
  },
  note: {
    tone: 'note',
    Icon: PencilIcon,
    titleKey: 'flows.canvas.nodeTitle.note',
    labelKey: 'flows.canvas.newNoteLabel',
    descriptionKey: 'flows.canvas.nodeDescription.note',
  },
  mockStart: {
    tone: 'mock',
    Icon: MockServerIcon,
    titleKey: 'flows.canvas.nodeTitle.mockStart',
    labelKey: 'flows.canvas.newMockStartLabel',
    descriptionKey: 'flows.canvas.nodeDescription.mockStart',
  },
  mockStop: {
    tone: 'mock',
    Icon: StopIcon,
    titleKey: 'flows.canvas.nodeTitle.mockStop',
    labelKey: 'flows.canvas.newMockStopLabel',
    descriptionKey: 'flows.canvas.nodeDescription.mockStop',
  },
  mockWaitRequest: {
    tone: 'mock',
    Icon: BellIcon,
    titleKey: 'flows.canvas.nodeTitle.mockWaitRequest',
    labelKey: 'flows.canvas.newMockWaitRequestLabel',
    descriptionKey: 'flows.canvas.nodeDescription.mockWaitRequest',
  },
  mockSetResponse: {
    tone: 'mock',
    Icon: GearIcon,
    titleKey: 'flows.canvas.nodeTitle.mockSetResponse',
    labelKey: 'flows.canvas.newMockSetResponseLabel',
    descriptionKey: 'flows.canvas.nodeDescription.mockSetResponse',
  },
  mockAssertCalls: {
    tone: 'mock',
    Icon: CheckIcon,
    titleKey: 'flows.canvas.nodeTitle.mockAssertCalls',
    labelKey: 'flows.canvas.newMockAssertCallsLabel',
    descriptionKey: 'flows.canvas.nodeDescription.mockAssertCalls',
  },
}
