import { jsonLanguage } from '@codemirror/lang-json'
import { Language, LanguageSupport, defineLanguageFacet, languageDataProp } from '@codemirror/language'
import { RangeSet, StateField, type EditorState, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutterLineClass, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { findJsonComments, maskJsonComments, type CommentRange } from './json-comments'

/**
 * JSON with `//` and `/* *\/` comments for the REST request body (spec 0146).
 *
 * The JSON grammar knows no comments: a `}` or a quote inside one would break
 * the tree that folding, indentation and highlighting rely on. So the stock
 * JSON parser reads the document with every comment turned into spaces (same
 * positions), and the comments are drawn by decorations instead.
 */

type Parser = Language['parser']
type ParseArgs = Parameters<Parser['createParse']>
type TreeFragments = ParseArgs[1]
type SyntaxTree = TreeFragments[number]['tree']
type PartialParse = ReturnType<Parser['createParse']>

/** Comment ranges each finished tree was parsed with, to tell which old fragments are still valid. */
const commentsByTree = new WeakMap<SyntaxTree, readonly CommentRange[]>()

/** How far around a reused fragment the comments must also be unchanged (parser lookahead). */
const FRAGMENT_MARGIN = 32

function clippedComments(ranges: readonly CommentRange[], from: number, to: number, offset: number): string {
  const parts: string[] = []
  for (const range of ranges) {
    const start = Math.max(range.from - offset, from)
    const end = Math.min(range.to - offset, to)
    if (start < end) parts.push(`${start}-${end}`)
  }
  return parts.join(',')
}

/** Fragments of the previous tree whose text is parsed the same way now: unchanged
 * text (the fragment itself guarantees that) with the same comments in and around it. */
function reusableFragments(fragments: TreeFragments, comments: readonly CommentRange[], length: number): TreeFragments {
  return fragments.filter((fragment) => {
    const previous = commentsByTree.get(fragment.tree)
    if (!previous) return false
    const from = Math.max(0, fragment.from - FRAGMENT_MARGIN)
    const to = Math.min(length, fragment.to + FRAGMENT_MARGIN)
    return clippedComments(previous, from, to, fragment.offset) === clippedComments(comments, from, to, 0)
  })
}

function recordingComments(parse: PartialParse, comments: readonly CommentRange[]): PartialParse {
  return {
    get parsedPos() {
      return parse.parsedPos
    },
    get stoppedAt() {
      return parse.stoppedAt
    },
    stopAt: (pos) => parse.stopAt(pos),
    advance() {
      const tree = parse.advance()
      if (tree) commentsByTree.set(tree, comments)
      return tree
    },
  }
}

const jsoncData = defineLanguageFacet({
  closeBrackets: { brackets: ['[', '{', '"'] },
  indentOnInput: /^\s*[}\]]$/,
  commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
})

const jsonParser = jsonLanguage.parser.configure({
  props: [languageDataProp.add((type) => (type.isTop ? jsoncData : undefined))],
})

// The stock parser with `createParse` reading the masked text. `startParse`
// (inherited) calls `createParse`; the inner `startParse` takes the string.
const jsoncParser: Parser = Object.create(jsonParser) as Parser
jsoncParser.createParse = (input, fragments, ranges) => {
  const text = input.read(0, input.length)
  const comments = findJsonComments(text)
  const masked = maskJsonComments(text, comments)
  return recordingComments(jsonParser.startParse(masked, reusableFragments(fragments, comments, text.length), ranges), comments)
}

const jsoncLanguage = new Language(jsoncData, jsoncParser, [], 'json')

/** Comment ranges of the document, rescanned only when the text changes. */
const commentsField = StateField.define<readonly CommentRange[]>({
  create: (state) => findJsonComments(state.doc.toString()),
  update: (value, tr) => (tr.docChanged ? findJsonComments(tr.state.doc.toString()) : value),
})

/** Start positions of the lines holding only comments and whitespace. */
export function commentedLineStarts(doc: Text, comments: readonly CommentRange[]): number[] {
  const starts: number[] = []
  let lastLine = 0
  for (let index = 0; index < comments.length; index++) {
    const first = Math.max(doc.lineAt(comments[index].from).number, lastLine + 1)
    const last = doc.lineAt(comments[index].to).number
    for (let number = first; number <= last; number++) {
      const line = doc.line(number)
      if (isCommentOnly(doc, line.from, line.to, comments, index)) starts.push(line.from)
      lastLine = number
    }
  }
  return starts
}

/** No text outside comments, other than whitespace, between `from` and `to`. `start` is a comment touching the line. */
function isCommentOnly(doc: Text, from: number, to: number, comments: readonly CommentRange[], start: number): boolean {
  let index = start
  while (index > 0 && comments[index - 1].to > from) index--
  let pos = from
  for (; index < comments.length && comments[index].from < to; index++) {
    const comment = comments[index]
    if (comment.to <= pos) continue
    if (comment.from > pos && doc.sliceString(pos, comment.from).trim() !== '') return false
    pos = Math.max(pos, comment.to)
  }
  return pos >= to || doc.sliceString(pos, to).trim() === ''
}

const commentMark = Decoration.mark({ class: 'cm-json-comment' })
const commentedLine = Decoration.line({ class: 'cm-json-commented-line' })

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const comments = state.field(commentsField)
  if (comments.length === 0) return Decoration.none
  const decorations = []
  for (const { from, to } of view.visibleRanges) {
    const visible = comments.filter((comment) => comment.to > from && comment.from < to)
    if (visible.length === 0) continue
    for (const start of commentedLineStarts(state.doc, visible)) {
      if (start >= from && start <= to) decorations.push(commentedLine.range(start))
    }
    for (const comment of visible) {
      const markFrom = Math.max(comment.from, from)
      const markTo = Math.min(comment.to, to)
      if (markFrom < markTo) decorations.push(commentMark.range(markFrom, markTo))
    }
  }
  return Decoration.set(decorations, true)
}

const commentDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = buildDecorations(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

class CommentedLineGutterMarker extends GutterMarker {
  elementClass = 'cm-json-commented-gutter'
}
const commentedLineGutterMarker = new CommentedLineGutterMarker()

const commentedLineGutter = gutterLineClass.compute([commentsField], (state: EditorState) =>
  RangeSet.of(commentedLineStarts(state.doc, state.field(commentsField)).map((start) => commentedLineGutterMarker.range(start))),
)

/** Comments step back: they are not sent. Selection and the active line stay
 * visible over the line tint; `{{variables}}` inside a comment are not
 * resolved, so they lose their chip and state. */
const commentTheme = EditorView.theme({
  '.cm-json-comment, .cm-json-comment *, .var-token:has(.cm-json-comment)': {
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },
  '.cm-json-comment': { opacity: 0.75 },
  '.cm-json-comment .var-token, .var-token:has(.cm-json-comment)': {
    background: 'none',
    boxShadow: 'none',
    textDecoration: 'none',
  },
  '.cm-json-commented-line': {
    backgroundColor: 'color-mix(in srgb, var(--text-muted) 9%, transparent)',
  },
  '.cm-json-commented-line.cm-activeLine': { backgroundColor: 'var(--accent-softer)' },
  '.cm-gutterElement.cm-json-commented-gutter': { opacity: 0.5 },
})

/** JSON with comments: language, comment decorations and their look. */
export function jsoncLanguageSupport(): Extension {
  return new LanguageSupport(jsoncLanguage, [commentsField, commentDecorations, commentedLineGutter, commentTheme])
}
