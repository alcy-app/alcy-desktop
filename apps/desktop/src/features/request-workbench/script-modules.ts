import type { Completion } from '@codemirror/autocomplete'

/** Libraries bundled with the scripting sandbox (spec 0128); `npm:` packages
 * are downloaded on demand, so their members are unknown to the editor. */
export const BUNDLED_MODULES = ['lodash', 'crypto-js', 'moment', 'uuid'] as const
export type BundledModule = (typeof BUNDLED_MODULES)[number]

/** A member of a module value. For a function, `type` is what calling it
 * returns; for a property, the type of its value. */
interface ModuleMember extends Completion {
  type: 'function' | 'property'
  of?: TypeId
}

interface ModuleType {
  members: readonly ModuleMember[]
  /** Type returned when the value itself is called (`moment()`). */
  call?: TypeId
}

type TypeId =
  | BundledModule
  | 'crypto-js.enc'
  | 'crypto-js.encoder'
  | 'crypto-js.cipher'
  | 'crypto-js.cipherParams'
  | 'crypto-js.wordArray'
  | 'crypto-js.lib'
  | 'crypto-js.wordArrayStatic'
  | 'crypto-js.mode'
  | 'crypto-js.pad'
  | 'crypto-js.format'
  | 'moment.instance'
  | 'moment.duration'

const fns = (names: string, detail: string, of?: TypeId): ModuleMember[] =>
  names.split(' ').map((label) => ({ label, detail, type: 'function', of }))

const props = (names: string, detail: string, of?: TypeId): ModuleMember[] =>
  names.split(' ').map((label) => ({ label, detail, type: 'property', of }))

const fn = (label: string, detail: string, info: string, of?: TypeId): ModuleMember => ({ label, detail, info, type: 'function', of })
const prop = (label: string, detail: string, info: string, of?: TypeId): ModuleMember => ({ label, detail, info, type: 'property', of })

// Public lodash 4.17.21 API, without the helpers that only make sense in a
// page (`noConflict`, `runInContext`, `mixin`).
const LODASH_FUNCTIONS =
  'add after ary assign assignIn assignInWith assignWith at attempt before bind bindAll bindKey camelCase capitalize ' +
  'castArray ceil chain chunk clamp clone cloneDeep cloneDeepWith cloneWith compact concat cond conforms conformsTo ' +
  'constant countBy create curry curryRight debounce deburr defaultTo defaults defaultsDeep defer delay difference ' +
  'differenceBy differenceWith divide drop dropRight dropRightWhile dropWhile each eachRight endsWith entries entriesIn ' +
  'eq escape escapeRegExp every extend extendWith fill filter find findIndex findKey findLast findLastIndex findLastKey ' +
  'first flatMap flatMapDeep flatMapDepth flatten flattenDeep flattenDepth flip floor flow flowRight forEach ' +
  'forEachRight forIn forInRight forOwn forOwnRight fromPairs functions functionsIn get groupBy gt gte has hasIn head ' +
  'identity inRange includes indexOf initial intersection intersectionBy intersectionWith invert invertBy invoke ' +
  'invokeMap isArguments isArray isArrayBuffer isArrayLike isArrayLikeObject isBoolean isBuffer isDate isElement ' +
  'isEmpty isEqual isEqualWith isError isFinite isFunction isInteger isLength isMap isMatch isMatchWith isNaN isNative ' +
  'isNil isNull isNumber isObject isObjectLike isPlainObject isRegExp isSafeInteger isSet isString isSymbol ' +
  'isTypedArray isUndefined isWeakMap isWeakSet iteratee join kebabCase keyBy keys keysIn last lastIndexOf lowerCase ' +
  'lowerFirst lt lte map mapKeys mapValues matches matchesProperty max maxBy mean meanBy memoize merge mergeWith method ' +
  'methodOf min minBy multiply negate noop now nth nthArg omit omitBy once orderBy over overArgs overEvery overSome pad ' +
  'padEnd padStart parseInt partial partialRight partition pick pickBy property propertyOf pull pullAll pullAllBy ' +
  'pullAllWith pullAt random range rangeRight rearg reduce reduceRight reject remove repeat replace rest result reverse ' +
  'round sample sampleSize set setWith shuffle size slice snakeCase some sortBy sortedIndex sortedIndexBy sortedIndexOf ' +
  'sortedLastIndex sortedLastIndexBy sortedLastIndexOf sortedUniq sortedUniqBy split spread startCase startsWith ' +
  'stubArray stubFalse stubObject stubString stubTrue subtract sum sumBy tail take takeRight takeRightWhile takeWhile ' +
  'tap template throttle thru times toArray toFinite toInteger toLength toLower toNumber toPairs toPairsIn toPath ' +
  'toPlainObject toSafeInteger toString toUpper transform trim trimEnd trimStart truncate unary unescape union unionBy ' +
  'unionWith uniq uniqBy uniqWith uniqueId unset unzip unzipWith update updateWith upperCase upperFirst values valuesIn ' +
  'without words wrap xor xorBy xorWith zip zipObject zipObjectDeep zipWith'

const MOMENT_SELF = 'add subtract startOf endOf clone local utc set utcOffset parseZone locale'
const MOMENT_STRING = 'format fromNow from toNow to calendar toISOString toJSON toString zoneAbbr zoneName'
const MOMENT_NUMBER =
  'diff valueOf unix year month date day weekday isoWeekday dayOfYear week isoWeek weekYear isoWeekYear quarter hour ' +
  'minute second millisecond daysInMonth weeksInYear isoWeeksInYear'
const MOMENT_BOOLEAN = 'isBefore isAfter isSame isSameOrBefore isSameOrAfter isBetween isValid isLeapYear isDST isUTC isLocal'

const TYPES: Record<TypeId, ModuleType> = {
  lodash: { members: [...fns(LODASH_FUNCTIONS, 'lodash'), ...props('VERSION templateSettings', 'lodash')] },
  'crypto-js': {
    members: [
      ...fns('MD5 SHA1 SHA224 SHA256 SHA384 SHA512 SHA3 RIPEMD160', '(message) → WordArray', 'crypto-js.wordArray'),
      ...fns(
        'HmacMD5 HmacSHA1 HmacSHA224 HmacSHA256 HmacSHA384 HmacSHA512 HmacSHA3 HmacRIPEMD160',
        '(message, key) → WordArray',
        'crypto-js.wordArray',
      ),
      ...fns('PBKDF2 EvpKDF', '(password, salt, cfg) → WordArray', 'crypto-js.wordArray'),
      ...props('AES DES TripleDES Rabbit RabbitLegacy RC4 RC4Drop Blowfish', 'cifra', 'crypto-js.cipher'),
      prop('enc', 'encoders', 'Codificações: Hex, Base64, Base64url, Utf8, Utf16, Latin1.', 'crypto-js.enc'),
      prop('lib', 'lib', 'Tipos base, como WordArray.', 'crypto-js.lib'),
      prop('mode', 'modos', 'Modos de operação das cifras de bloco.', 'crypto-js.mode'),
      prop('pad', 'padding', 'Esquemas de padding das cifras de bloco.', 'crypto-js.pad'),
      prop('format', 'formatos', 'Formatos de serialização do resultado de encrypt.', 'crypto-js.format'),
      ...props('algo kdf x64', 'crypto-js'),
    ],
  },
  'crypto-js.enc': { members: props('Hex Base64 Base64url Utf8 Utf16 Utf16BE Utf16LE Latin1', 'encoder', 'crypto-js.encoder') },
  'crypto-js.encoder': {
    members: [
      fn('stringify', '(wordArray) → string', 'Converte um WordArray em texto nesta codificação.'),
      fn('parse', '(text) → WordArray', 'Lê um texto nesta codificação como WordArray.', 'crypto-js.wordArray'),
    ],
  },
  'crypto-js.cipher': {
    members: [
      fn('encrypt', '(message, key, cfg) → CipherParams', 'Cifra a mensagem; toString() dá o resultado em Base64.', 'crypto-js.cipherParams'),
      fn('decrypt', '(ciphertext, key, cfg) → WordArray', 'Decifra; use toString(CryptoJS.enc.Utf8) para ler o texto.', 'crypto-js.wordArray'),
    ],
  },
  'crypto-js.cipherParams': {
    members: [
      fn('toString', '(format?) → string', 'Resultado serializado (OpenSSL/Base64 por padrão).'),
      ...props('ciphertext key iv salt', 'WordArray', 'crypto-js.wordArray'),
      ...props('algorithm mode padding blockSize formatter', 'CipherParams'),
    ],
  },
  'crypto-js.wordArray': {
    members: [
      fn('toString', '(encoder?) → string', 'Texto no encoder informado; Hex por padrão.'),
      fn('concat', '(wordArray) → WordArray', 'Anexa outro WordArray a este.', 'crypto-js.wordArray'),
      fn('clone', '() → WordArray', 'Cópia deste WordArray.', 'crypto-js.wordArray'),
      ...props('words sigBytes', 'WordArray'),
    ],
  },
  'crypto-js.lib': { members: [prop('WordArray', 'WordArray', 'Cria WordArrays: create, random.', 'crypto-js.wordArrayStatic')] },
  'crypto-js.wordArrayStatic': {
    members: [
      fn('create', '(words?, sigBytes?) → WordArray', 'Cria um WordArray.', 'crypto-js.wordArray'),
      fn('random', '(nBytes) → WordArray', 'Bytes aleatórios (ex.: IV ou salt).', 'crypto-js.wordArray'),
    ],
  },
  'crypto-js.mode': { members: props('CBC CFB CTR CTRGladman OFB ECB', 'modo') },
  'crypto-js.pad': { members: props('Pkcs7 AnsiX923 Iso10126 Iso97971 ZeroPadding NoPadding', 'padding') },
  'crypto-js.format': { members: props('OpenSSL Hex', 'formato') },
  moment: {
    call: 'moment.instance',
    members: [
      fn('utc', '(input?, format?) → Moment', 'Data em UTC.', 'moment.instance'),
      fn('unix', '(seconds) → Moment', 'Data a partir de um timestamp Unix em segundos.', 'moment.instance'),
      fn('duration', '(value, unit?) → Duration', 'Duração (ex.: moment.duration(2, "hours")).', 'moment.duration'),
      fn('parseZone', '(input) → Moment', 'Data mantendo o fuso do texto.', 'moment.instance'),
      ...fns('max min', '(...moments) → Moment', 'moment.instance'),
      fn('invalid', '() → Moment', 'Data inválida.', 'moment.instance'),
      ...fns('isMoment isDuration isDate', '(value) → boolean'),
      ...fns('now', '() → number'),
      ...fns('locale locales localeData months monthsShort weekdays weekdaysShort weekdaysMin normalizeUnits', 'moment'),
      ...props('ISO_8601 RFC_2822 HTML5_FMT defaultFormat defaultFormatUtc version', 'moment'),
    ],
  },
  'moment.instance': {
    members: [
      ...fns(MOMENT_SELF, '→ Moment', 'moment.instance'),
      ...fns(MOMENT_STRING, '→ string'),
      ...fns(MOMENT_NUMBER, '→ number'),
      ...fns(MOMENT_BOOLEAN, '→ boolean'),
      fn('toDate', '() → Date', 'Converte para Date.'),
      ...fns('toArray toObject get', 'Moment'),
    ],
  },
  'moment.duration': {
    members: [
      ...fns('add subtract abs clone', '→ Duration', 'moment.duration'),
      ...fns('humanize toISOString toJSON', '→ string'),
      ...fns(
        'as asMilliseconds asSeconds asMinutes asHours asDays asWeeks asMonths asQuarters asYears ' +
          'milliseconds seconds minutes hours days weeks months years get valueOf',
        '→ number',
      ),
      ...fns('isValid', '→ boolean'),
    ],
  },
  uuid: {
    members: [
      fn('v4', '() → string', 'UUID aleatório.'),
      fn('v1', '() → string', 'UUID baseado em tempo.'),
      fn('v3', '(name, namespace) → string', 'UUID determinístico (MD5).'),
      fn('v5', '(name, namespace) → string', 'UUID determinístico (SHA-1).'),
      fn('validate', '(text) → boolean', 'Informa se o texto é um UUID válido.'),
      fn('version', '(uuid) → number', 'Versão do UUID.'),
      fn('parse', '(uuid) → Uint8Array', 'Bytes do UUID.'),
      fn('stringify', '(bytes) → string', 'UUID a partir dos bytes.'),
      prop('NIL', 'string', 'UUID nulo (só zeros).'),
    ],
  },
}

const MODULE_INFO: Record<BundledModule, string> = {
  lodash: 'lodash 4.17.21: utilitários de arrays, objetos e textos.',
  'crypto-js': 'crypto-js 4.2.0: hashes, HMAC e cifras.',
  moment: 'moment 2.30.1: datas e durações.',
  uuid: 'uuid 8.3.2: geração e validação de UUIDs.',
}

/** Names offered inside `require('…')`. */
export const MODULE_NAME_COMPLETIONS: readonly Completion[] = [
  ...BUNDLED_MODULES.map((name): Completion => ({ label: name, type: 'namespace', detail: 'embutido', info: MODULE_INFO[name] })),
  {
    label: 'npm:',
    type: 'namespace',
    detail: 'npm:<pacote>@<versão>',
    info: 'Baixa um pacote do npm na primeira execução e o guarda para uso offline.',
  },
]

function isBundledModule(name: string): name is BundledModule {
  return (BUNDLED_MODULES as readonly string[]).includes(name)
}

export function moduleMembers(module: string): readonly Completion[] {
  return isBundledModule(module) ? TYPES[module].members : []
}

/** One step of a member chain: `name` or `name(args)`. */
export interface ChainSegment {
  name: string
  call: boolean
  args: string
}

/** Index of the `(` matching the `)` at `close`, skipping string literals; -1 if unbalanced. */
function matchingOpen(text: string, close: number): number {
  let depth = 0
  for (let i = close; i >= 0; i--) {
    const char = text[i]
    if (char === '"' || char === "'" || char === '`') {
      i = text.lastIndexOf(char, i - 1)
      if (i < 0) return -1
    } else if (char === ')') depth++
    else if (char === '(') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

const skipSpacesBack = (text: string, end: number): number => {
  let i = end
  while (i > 0 && /\s/.test(text[i - 1])) i--
  return i
}

/** The member chain that ends at the end of `text` followed by a dot and
 * the word being typed: `CryptoJS.enc.Hex.str` → [CryptoJS, enc, Hex] and
 * `str`. Calls are kept with their arguments (`moment().add(1, 'd').`). */
export function memberChainBefore(text: string): { segments: ChainSegment[]; partial: string } | null {
  const partial = /[\w$]*$/.exec(text)?.[0] ?? ''
  let end = skipSpacesBack(text, text.length - partial.length)
  if (text[end - 1] !== '.') return null
  const segments: ChainSegment[] = []
  for (;;) {
    end = skipSpacesBack(text, end - 1)
    let call = false
    let args = ''
    if (text[end - 1] === ')') {
      const open = matchingOpen(text, end - 1)
      if (open < 0) return null
      call = true
      args = text.slice(open + 1, end - 1)
      end = skipSpacesBack(text, open)
    }
    const name = /[A-Za-z_$][\w$]*$/.exec(text.slice(0, end))?.[0]
    if (!name) return null
    segments.unshift({ name, call, args })
    end -= name.length
    const before = skipSpacesBack(text, end)
    if (text[before - 1] !== '.') return { segments, partial }
    end = before
  }
}

/** The module named by a single string literal argument (`'lodash'`). */
function literalModule(args: string): string | null {
  return /^\s*(['"`])([^'"`]+)\1\s*$/.exec(args)?.[2] ?? null
}

const REQUIRE_CALL = String.raw`(?:al\s*\.\s*)?require\s*\(\s*(?<quote>['"\x60])(?<module>[^'"\x60]+)\k<quote>\s*\)`

/** Variables bound to a module in `source`: `const _ = require('lodash')`,
 * also through `al.require`. A later binding of the same name wins. */
export function requiredModules(source: string): Map<string, string> {
  const bindings = new Map<string, string>()
  const pattern = new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*` + REQUIRE_CALL, 'g')
  for (const match of source.matchAll(pattern)) {
    if (match.groups) bindings.set(match[1], match.groups.module)
  }
  return bindings
}

/** Members available after `segments`, given the variables bound to modules;
 * `null` when the chain does not start at a module. */
export function moduleChainMembers(segments: readonly ChainSegment[], bindings: Map<string, string>): readonly Completion[] | null {
  const [head, ...rest] = segments
  let module: string | null = null
  let called = false
  let steps = rest
  if (head.name === 'require' && head.call) module = literalModule(head.args)
  else if (head.name === 'al' && !head.call && rest[0]?.name === 'require' && rest[0].call) {
    module = literalModule(rest[0].args)
    steps = rest.slice(1)
  } else if (bindings.has(head.name)) {
    module = bindings.get(head.name) ?? null
    called = head.call
  }
  if (module === null) return null
  if (!isBundledModule(module)) return []

  let type: TypeId | undefined = called ? TYPES[module].call : module
  for (const segment of steps) {
    if (!type) return []
    const member: ModuleMember | undefined = TYPES[type].members.find((candidate) => candidate.label === segment.name)
    type = member && (member.type === 'function') === segment.call ? member.of : undefined
  }
  return type ? TYPES[type].members : []
}

/** Module named by the destructuring the cursor is in, as in
 * `const { v4| } = require('uuid')`: `before` is the text up to the cursor
 * and `after` the text that follows it. Only where a name is expected
 * (after `{` or `,`, not after `name:`). */
export function destructuredModule(before: string, after: string): string | null {
  const open = /\b(?:const|let|var)\s*\{([\w$\s,:]*)$/.exec(before)
  if (!open) return null
  const inside = open[1].replace(/[\w$]*$/, '').trimEnd()
  if (inside !== '' && !inside.endsWith(',')) return null
  const close = new RegExp(String.raw`^[\w$\s,:]*\}\s*=\s*` + REQUIRE_CALL).exec(after)
  return close?.groups?.module ?? null
}
