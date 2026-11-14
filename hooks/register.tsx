import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { Candidate, Item, Summary } from '../types'

import { PALETTE, tilesSvg, tint } from './svg'

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

const PANE = 'kabeucheese'
const TITLE = '思考マップ'
export const UNSORTED = '未分類'

/** config.json に URL が無いとき（未設定）。README の「はじめての設定」で自分の Artifact を作って書く */
const FALLBACK_URL = ''

const EMPTY: Summary = {
  sessionId: '',
  folder: '',
  title: '',
  summary: '',
  continuesFrom: '',
  items: [],
  counts: { questions: 0, decisions: 0, terms: 0 },
  newTerms: [],
  updatedAt: 0,
}

const summary = atom({ plugin: 'kabeucheese', key: 'summary' } as const, EMPTY, { shape: 'summary-2' })
const url = atom({ plugin: 'kabeucheese', key: 'url' } as const, FALLBACK_URL, { shape: 'url-1' })

const storeKey = (sessionId: string) => `summary:${sessionId}`
const URL_KEY = 'artifactUrl'

// ---------------------------------------------------------------------------
// フォルダ名
// ---------------------------------------------------------------------------

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/**
 * 作業フォルダの名前（末尾のフォルダ名）。フォルダを選ばずに始めたセッション
 * （ホームそのもの、一時フォルダ、アプリのデータフォルダ）は「未分類」にまとめる。
 */
export function folderOf(cwd: string, home: string): string {
  const path = norm(cwd)
  const lower = path.toLowerCase()
  const h = norm(home).toLowerCase()
  if (!path || lower === h || lower === '' || /^[a-z]:$/i.test(path)) return UNSORTED
  if (/\/(appdata|tmp|temp)(\/|$)/i.test(lower) || lower.startsWith('/tmp') || lower.startsWith('/var/folders')) return UNSORTED
  const base = path.split('/').filter(Boolean).pop() ?? ''
  return base || UNSORTED
}

async function homeOf($: Engine) {
  return (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
}

async function contextOf($: Engine) {
  const [sessionId, cwd, home, artifactUrl] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
    homeOf($),
    urlOf($),
  ])
  return { sessionId, folder: folderOf(cwd, home), cwd, artifactUrl }
}

export const isArtifactUrl = (v: unknown): v is string =>
  typeof v === 'string' && /^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9-]+/.test(v)

/** Artifact の URL から id を取り出す（/artifact/ と /code/artifact/ の書き方の違いを吸収する） */
export const artifactIdOf = (v: unknown) =>
  typeof v === 'string' ? (/^https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9-]+)/.exec(v)?.[1] ?? '') : ''

// ---------------------------------------------------------------------------
// 機密らしい文字列の検査（保存先への書き込みだけを見る）
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: [string, RegExp][] = [
  ['API キー（sk-）', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['GitHub のトークン', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['AWS のアクセスキー', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google の API キー', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack のトークン', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['秘密鍵', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['パスワードやトークンの値', /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[^\s"']{8,}/i],
]

/** 値の中の文字列をすべて調べ、機密らしいものがあればその種類を返す（値そのものは返さない） */
export function findSecret(value: unknown, depth = 0): string | null {
  if (depth > 20 || value == null) return null
  if (typeof value === 'string') {
    for (const [kind, re] of SECRET_PATTERNS) if (re.test(value)) return kind
    return null
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findSecret(v, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const hit = findSecret(k, depth + 1) ?? findSecret(v, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

const WRITE_ACTIONS = new Set(['set', 'update', 'str_replace', 'batch'])

export const SECRET_DENY = (kind: string) =>
  `kabeucheese：保存しようとした内容に${kind}らしい文字列があるため、書き込みを止めました。その部分を消すか伏せ字にしてから書き直してください。`

/** 保存先の URL：config.json にあればそれ、なければ /kabemap <URL> でこの PC に保存したもの（書き込みはしない） */
async function resolveUrl($: Engine) {
  try {
    const text = await $.fs.read(`${$.plugin.root}/config.json`)
    const parsed = JSON.parse(typeof text === 'string' ? text : '') as { artifactUrl?: unknown }
    if (isArtifactUrl(parsed.artifactUrl)) return parsed.artifactUrl
  } catch {
    // 読めなければ下へ
  }
  const saved = await $.store.get(URL_KEY)
  return isArtifactUrl(saved) ? saved : ''
}

async function loadUrl($: Engine) {
  const next = await resolveUrl($)
  if (next) await update($, url, () => next)
  return next
}

/**
 * 今の保存先。/clear のあとは新しいセッション id で続き、session.start が来ないので
 * $.state の url は初期値（空）に戻る。空なら config.json と store から読み直す。
 */
async function urlOf($: Engine) {
  return (await read($, url)) || (await loadUrl($))
}

// ---------------------------------------------------------------------------
// スキルから届く概要
// ---------------------------------------------------------------------------

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)

/** show ツールの入力を Summary に整える（形の崩れた値は捨てる） */
export function toSummary(input: Record<string, unknown>, sessionId: string, folder: string, now: number): Summary {
  const rawItems = Array.isArray(input.items) ? input.items : []
  const items: Item[] = rawItems
    .map((it): Item | null => {
      if (!it || typeof it !== 'object') return null
      const o = it as Record<string, unknown>
      const kind = o.kind === 'question' || o.kind === 'decision' ? o.kind : null
      const label = str(o.label, 120)
      if (!kind || !label) return null
      const previous = kind === 'decision' && o.previous === true
      const item: Item = { kind, label, superseded: o.superseded === true || previous, previous }
      if (kind === 'question' && o.open === true) item.open = true
      return item
    })
    .filter((it): it is Item => it !== null)
    .slice(0, 80)
  // 前回のセッションで覆した決定は最後にまとめる
  items.sort((a, b) => Number(a.previous) - Number(b.previous))
  const counts = (input.counts && typeof input.counts === 'object' ? input.counts : {}) as Record<string, unknown>
  return {
    sessionId,
    folder,
    title: str(input.title, 80),
    summary: str(input.summary, 400),
    continuesFrom: str(input.continuesFrom, 80),
    items,
    counts: {
      questions: num(counts.questions) || items.filter(i => i.kind === 'question').length,
      decisions: num(counts.decisions) || items.filter(i => i.kind === 'decision' && !i.superseded).length,
      terms: num(counts.terms),
    },
    newTerms: (Array.isArray(input.newTerms) ? input.newTerms : []).map(t => str(t, 40)).filter(Boolean).slice(0, 30),
    candidates: toCandidates(input.candidates),
    added: [],
    updatedAt: now,
  }
}

/** show ツールの candidates を整える（名前の無いもの・重複は捨てる） */
export function toCandidates(raw: unknown): Candidate[] {
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const it of Array.isArray(raw) ? raw : []) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    const name = str(o.name, 40)
    const key = normName(name)
    if (!name || seen.has(key)) continue
    seen.add(key)
    out.push({ name, definition: str(o.definition, 120), contextMeaning: str(o.contextMeaning, 200), nodeId: str(o.nodeId, 40) })
    if (out.length >= 20) break
  }
  return out
}

// ---------------------------------------------------------------------------
// 用語の id と照合（ページと同じ決め方）
// ---------------------------------------------------------------------------

/** 照合用に名前をそろえる：全角英数を半角に、大文字を小文字に、空白と「・」「の」の有無を無視 */
export const normName = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・･\-_]/g, '')
    .replace(/の/g, '')

/** 用語の doc id：英数字だけの名前はその綴り、それ以外は名前から決まるハッシュ（ページでも同じ式） */
export function termIdOf(name: string): string {
  const ascii = name.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (ascii && /^[\x00-\x7f]+$/.test(name.normalize('NFKC'))) return ascii.slice(0, 60)
  let h = 0x811c9dc5
  for (const ch of normName(name)) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `u-${h.toString(36)}`
}

// ---------------------------------------------------------------------------
// 資料の取り込み（/kabeimport）：作業フォルダの資料と git の履歴を一覧にする
// ---------------------------------------------------------------------------

/** 中を見ないフォルダ（依存物・生成物・環境） */
const SKIP_DIRS = new Set([
  'node_modules', '__pycache__', 'venv', '.venv', 'env', 'site-packages', 'dist', 'build', 'out', 'target',
  '.git', '.svn', '.hg', '.idea', '.vscode', '.cache', '.next', '.ipynb_checkpoints', 'wandb', 'mlruns', 'lightning_logs',
])

/** 機密が入っていそうなファイル名（一覧に出さず、数だけ数える） */
export const isSecretName = (name: string) =>
  /^\.env(\.|$)|\.(pem|key|p12|pfx|keystore|jks)$|^id_(rsa|ed25519|ecdsa)|(^|[._-])(credentials?|secrets?|tokens?|passwords?|passwd)([._-]|$)|^\.(netrc|npmrc|pypirc)$/i.test(name)

const KINDS: [string, RegExp][] = [
  ['note', /\.(md|markdown|txt|org|rst|tex|bib)$/i],
  ['office', /\.(docx?|pptx?|xlsx?|odt|key|pages)$/i],
  ['pdf', /\.pdf$/i],
  ['notebook', /\.ipynb$/i],
  ['code', /\.(py|r|m|jl|js|ts|tsx|c|cc|cpp|h|hpp|java|kt|go|rs|sh|ps1|ya?ml|toml|cfg|ini)$/i],
  ['data', /\.(csv|tsv|json|jsonl|parquet|h5|hdf5|npy|npz|mat|pkl|pt|pth|ckpt|safetensors|ply|bin)$/i],
  ['image', /\.(png|jpe?g|gif|svg|webp|bmp|tiff?|mp4|mov)$/i],
]
export const kindOf = (name: string) => KINDS.find(([, re]) => re.test(name))?.[0] ?? 'other'

/** 中身を読む価値が高い順（同じ日付なら先に並べ、件数が多いときに残す） */
const KIND_RANK: Record<string, number> = { note: 0, office: 1, pdf: 1, notebook: 2, code: 3, data: 5, image: 5, other: 6 }

export type ScanFile = { path: string; kind: string; size: number; modified: string; firstCommit?: string; lastCommit?: string }
export type ScanCommit = { date: string; subject: string; files: number }

/** `git log --name-only --date=short --pretty=format:@@%ad%x09%s` の出力を読む */
export function parseGitLog(out: string): { commits: ScanCommit[]; first: Map<string, string>; last: Map<string, string> } {
  const commits: ScanCommit[] = []
  const first = new Map<string, string>()
  const last = new Map<string, string>()
  let cur: ScanCommit | null = null
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('@@')) {
      const [date = '', ...rest] = line.slice(2).split('\t')
      cur = { date: date.slice(0, 10), subject: rest.join('\t').slice(0, 160), files: 0 }
      commits.push(cur)
      continue
    }
    if (!cur) continue
    cur.files++
    const p = line.replace(/\\/g, '/')
    // log は新しい順：最初に見た日付が最後の更新、最後に見た日付が最初の追加
    if (!last.has(p)) last.set(p, cur.date)
    first.set(p, cur.date)
  }
  return { commits, first, last }
}

const MAX_VISIT = 4000
const MAX_FILES = 500
const MAX_DEPTH = 7

/** 作業フォルダを歩いて資料の一覧を作る（中身は読まない） */
export async function scanFolder($: Engine, root: string) {
  const files: ScanFile[] = []
  let visited = 0
  let secret = 0
  let truncated = false
  const queue: [string, number][] = [['', 0]]
  while (queue.length) {
    const [rel, depth] = queue.shift()!
    let entries: Awaited<ReturnType<Engine['fs']['list']>> = []
    try {
      entries = await $.fs.list(rel ? `${root}/${rel}` : root)
    } catch {
      continue
    }
    for (const e of entries) {
      if (++visited > MAX_VISIT) {
        truncated = true
        break
      }
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.kind === 'dir') {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push([path, depth + 1])
        continue
      }
      if (e.kind !== 'file') continue
      if (isSecretName(e.name)) {
        secret++
        continue
      }
      if (e.name.startsWith('~$') || /^(thumbs\.db|desktop\.ini|\.ds_store)$/i.test(e.name)) continue
      files.push({ path, kind: kindOf(e.name), size: e.size, modified: e.mtimeMs ? new Date(e.mtimeMs).toISOString().slice(0, 10) : '' })
    }
    if (truncated) break
  }

  let commits: ScanCommit[] = []
  try {
    const r = await $.process.run(
      ['git', 'log', '--name-only', '--date=short', '--pretty=format:@@%ad%x09%s', '-n', '1500', '--', '.'],
      { cwd: root, timeoutMs: 20000 },
    )
    if (r.exitCode === 0) {
      const top = await $.process.run(['git', 'rev-parse', '--show-prefix'], { cwd: root, timeoutMs: 5000 })
      const prefix = top.exitCode === 0 ? top.stdout.trim() : ''
      const g = parseGitLog(r.stdout)
      commits = g.commits
      for (const f of files) {
        const key = prefix + f.path
        if (g.first.has(key)) f.firstCommit = g.first.get(key)
        if (g.last.has(key)) f.lastCommit = g.last.get(key)
      }
    }
  } catch {
    // git が無い・リポジトリでない
  }

  const dateOf = (f: ScanFile) => f.firstCommit || f.modified || '9999'
  const byKind: Record<string, number> = {}
  for (const f of files) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1
  let shown = files
  if (files.length > MAX_FILES) {
    truncated = true
    shown = [...files].sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)).slice(0, MAX_FILES)
  }
  shown = [...shown].sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || a.path.localeCompare(b.path))
  const dates = [...shown.map(dateOf), ...commits.map(c => c.date)].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
  return {
    files: shown,
    totalFiles: files.length,
    byKind,
    excludedSecretFiles: secret,
    truncated,
    commits: commits.slice(0, 400).reverse(),
    totalCommits: commits.length,
    dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
  }
}

/** 取り込んだ時期のセッション id：フォルダと時期の始まりから決まる（再取り込みでも同じ） */
export const importSessionId = (folder: string, from: string) => `imp-${termIdOf(folder)}-${from.replace(/-/g, '').slice(0, 8)}`

/** 候補のうち、まだ追加していないもの */
const pendingCandidates = (s: Summary) => {
  const added = new Set((s.added ?? []).map(normName))
  return (s.candidates ?? []).filter(c => !added.has(normName(c.name)))
}

/** 候補を用語集に追加する（ArtifactData で新しい用語を作る）。結果の一文を返す */
async function addCandidate($: Engine, c: Candidate): Promise<string> {
  const ctx = await contextOf($)
  if (!ctx.artifactUrl) return SETUP_TEXT
  const now = new Date().toISOString()
  const res = (await $.tool.call({
    tool: 'ArtifactData',
    action: 'set',
    url: ctx.artifactUrl,
    collection: 'terms',
    doc_id: termIdOf(c.name),
    data: {
      name: c.name,
      definition: c.definition,
      contextMeaning: c.contextMeaning,
      explanation: [],
      examples: [],
      related: [],
      aliases: [],
      source: { type: 'claude', urls: [] },
      addedBy: 'pick',
      review: 'pending',
      occurrences: [{ folder: ctx.folder, sessionId: ctx.sessionId, nodeId: c.nodeId }],
      createdAt: now,
      updatedAt: now,
    },
  } as never)) as { deny?: string; isError?: boolean; text?: string }
  if (res.deny || res.isError) {
    const why = String(res.deny ?? res.text ?? '').slice(0, 120)
    return `「${c.name}」を追加できませんでした（すでに用語集にあるか、書き込みが断られました）。${why}`
  }
  await update($, summary, s => ({ ...s, added: [...(s.added ?? []), c.name] }))
  await $.store.set(storeKey(ctx.sessionId), await read($, summary))
  return `「${c.name}」を用語集に追加しました。詳しい説明は、ページで「Claude に確かめてもらう」を押すか、次の /kabemap で入ります。`
}

async function loadStored($: Engine): Promise<boolean> {
  const sessionId = await $.session.id()
  const stored = (await $.store.get(storeKey(sessionId))) as Summary | undefined
  if (!stored || typeof stored !== 'object' || stored.sessionId !== sessionId || !Array.isArray(stored.items)) return false
  // 前の版で保存した概要にも、あとから足した項目を補う
  const next: Summary = {
    ...EMPTY,
    ...stored,
    continuesFrom: typeof stored.continuesFrom === 'string' ? stored.continuesFrom : '',
    items: stored.items.map(it => ({ ...it, previous: it.previous === true })),
  }
  await update($, summary, () => next)
  return true
}

const openPane = ($: Engine) => $.ui.open({ id: PANE, title: TITLE })

export const SETUP_TEXT =
  '思考マップの保存先がまだ設定されていません。README の「はじめての設定」に沿って Artifact を公開し、/kabemap <その URL> を送ってください。'

const ANALYZE_PROMPT =
  'kabeucheese:analyze スキルの手順で、このセッションの会話を見直して思考マップを更新し、最後にペインを開いてください。'

const IMPORT_PROMPT =
  'kabeucheese:import スキルの手順で、この作業フォルダの資料と git の履歴を読み、kabeucheese を入れる前からの経緯を時期ごとの思考マップとして取り込んでください。'

// ---------------------------------------------------------------------------
// フック
// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await loadUrl($)
    await $.command.register({
      name: 'kabemap',
      description: '会話を解析して思考マップ（Artifact）を更新し、概要のペインを開く（初回は /kabemap <Artifact の URL> で保存先を設定）',
      argumentHint: '[Artifact の URL]',
    })
    await $.command.register({
      name: 'kabeimport',
      description: 'kabeucheese を入れる前からの活動を、作業フォルダの資料と git の履歴から時期ごとのマップにして取り込む',
      argumentHint: '[読む範囲や時期の指定（任意）]',
    })
    await $.tool.register({
      name: 'scan',
      description:
        'kabeucheese:import スキルで使う。作業フォルダの資料の一覧（相対パス・種類・更新日・git で最初に入った日）と git のコミット履歴、フォルダの key、取り込み用のセッション id の付け方を返す。中身は読まない。',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.command.register({
      name: 'kabeview',
      description: '解析せずに、保存済みの思考マップの概要ペインを開き直す',
    })
    await $.tool.register({
      name: 'context',
      description:
        'kabeucheese の解析に使う前提（このセッションの sessionId、作業フォルダ名 folder、Artifact の URL artifactUrl、今の時刻 now）を返す。kabeucheese:analyze スキルの最初に呼ぶ。',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'show',
      description:
        'kabeucheese:analyze スキルの最後に呼ぶ。このセッションの問いと決定の一覧・件数・新しい用語をペイン用に保存し、思考マップのペインを開く。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'セッション名（20字前後）' },
          summary: { type: 'string', description: 'このセッションで考えたことを2〜3文' },
          continuesFrom: { type: 'string', description: '続きとして結んだ前回のセッション名（前回なしは空文字）' },
          items: {
            type: 'array',
            description: '流れ図の順に、問いとその決定。この会話で覆した前回のセッションの決定は previous: true で最後に',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['question', 'decision'] },
                label: { type: 'string' },
                superseded: { type: 'boolean', description: '覆った決定なら true' },
                previous: { type: 'boolean', description: '前回のセッションのマップにある決定なら true' },
                open: { type: 'boolean', description: 'まだ決めていない問いなら true（question のときだけ）' },
              },
              required: ['kind', 'label'],
            },
          },
          counts: {
            type: 'object',
            properties: {
              questions: { type: 'number' },
              decisions: { type: 'number', description: '覆っていない決定の数' },
              terms: { type: 'number', description: 'このセッションの論点に付いた用語の数' },
            },
          },
          newTerms: { type: 'array', items: { type: 'string' }, description: 'このセッションで新しく登録した用語名' },
          candidates: {
            type: 'array',
            description: '会話に出てきたが用語集に無い言葉（登録はしていないもの）。ペインと返答の下に「＋ 追加」付きで出る',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                definition: { type: 'string', description: 'ひとこと定義（40字前後）' },
                contextMeaning: { type: 'string', description: 'この会話での意味（1文）' },
                nodeId: { type: 'string', description: '出てきた論点の id' },
              },
              required: ['name'],
            },
          },
        },
        required: ['title', 'items'],
      },
      isDeferred: false,
    })
    await loadStored($)
    return result
  })

  on('tool.call', { tool: 'mcp__kabeucheese__context' }, async $ => {
    const ctx = await contextOf($)
    // 時刻は Claude に推測させず、ここで UTC の ISO 文字列で渡す（文字列のまま並べ替えるので書き方をそろえる）
    const now = new Date().toISOString()
    return { result: JSON.stringify({ sessionId: ctx.sessionId, folder: ctx.folder, artifactUrl: ctx.artifactUrl, now }) }
  })

  on('tool.call', { tool: 'mcp__kabeucheese__scan' }, async $ => {
    const ctx = await contextOf($)
    const scan = await scanFolder($, ctx.cwd)
    return {
      result: JSON.stringify({
        folder: ctx.folder,
        folderKey: termIdOf(ctx.folder),
        root: ctx.cwd,
        artifactUrl: ctx.artifactUrl,
        now: new Date().toISOString(),
        sessionIdPattern: `imp-${termIdOf(ctx.folder)}-<時期の始まりの YYYYMMDD>`,
        ...scan,
      }),
    }
  })

  on('command.run', { command: 'kabeimport' }, async ($, e) => {
    const ctx = await contextOf($)
    if (!ctx.artifactUrl) {
      await openPane($)
      return { text: SETUP_TEXT }
    }
    if (ctx.folder === UNSORTED) {
      return { text: '作業フォルダを選んで始めたセッションで使ってください（今は「未分類」のため、どの資料を読むか決められません）。' }
    }
    const hint = (e.args ?? '').trim().slice(0, 300)
    const text = IMPORT_PROMPT + (hint ? `\n読む範囲・時期の指定：${hint}` : '')
    $.clock.after(0, () => void $.prompt.submit({ text, asUser: true }).catch(() => {}))
    return { text: `「${ctx.folder}」の資料を読んで、これまでの経緯を取り込みます。` }
  })

  // 保存先の Artifact への書き込みに、API キーなど機密らしい文字列が入っていたら止める
  on('tool.call', { tool: 'ArtifactData' }, async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const target = artifactIdOf(await urlOf($))
    if (!target || artifactIdOf(input.url) !== target || !WRITE_ACTIONS.has(String(input.action))) return next(e)
    const payloads: unknown[] = [input.data, input.new_str, input.writes]
    const files = [input.file_path, ...(Array.isArray(input.writes) ? input.writes.map(w => (w as Record<string, unknown>)?.file_path) : [])]
    for (const f of files) {
      if (typeof f !== 'string' || !f) continue
      try {
        payloads.push(await $.fs.read(f))
      } catch {
        // 読めないファイルはツール側で失敗する
      }
    }
    const hit = findSecret(payloads)
    return hit ? { deny: SECRET_DENY(hit) } : next(e)
  })

  on('tool.call', { tool: 'mcp__kabeucheese__show' }, async ($, e) => {
    const input = ((e as { input?: unknown }).input ?? e) as Record<string, unknown>
    const ctx = await contextOf($)
    const next = toSummary(input, ctx.sessionId, ctx.folder, Date.now())
    await update($, summary, () => next)
    await $.store.set(storeKey(ctx.sessionId), next)
    await openPane($)
    return { result: `ペインを開きました（問い${next.counts.questions}・決定${next.counts.decisions}・新しい用語${next.newTerms.length}）。` }
  })

  on('command.run', { command: 'kabemap' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg) {
      if (!isArtifactUrl(arg)) return { text: 'claude.ai の Artifact の URL（https://claude.ai/artifact/...）を指定してください。' }
      await $.store.set(URL_KEY, arg)
      await update($, url, () => arg)
      return { text: `保存先を設定しました：${arg}\nもう一度 /kabemap を送ると、このセッションのマップを作ります。` }
    }
    if (!(await urlOf($))) {
      await openPane($)
      return { text: SETUP_TEXT }
    }
    // コマンドの処理が終わってから、Claude への依頼として送る
    $.clock.after(0, () => void $.prompt.submit({ text: ANALYZE_PROMPT, asUser: true }).catch(() => {}))
    return { text: '思考マップを更新します。' }
  })

  on('command.run', { command: 'kabeview' }, async $ => {
    const found = await loadStored($)
    await openPane($)
    return {
      text: found ? '保存済みの思考マップを開きました。' : 'このセッションの思考マップはまだありません。/kabemap で作れます。',
    }
  })

  // 返答の下に、その返答に出てきた未登録の言葉を並べる。カーソルを合わせると「＋」が出て、押すと用語集に入る
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    const cands = pendingCandidates(await read($, summary))
    if (!cands.length) return drawn
    const text = normName(String((e.props as { text?: unknown } | undefined)?.text ?? ''))
    const hits = cands.filter(c => text.includes(normName(c.name))).slice(0, 6)
    if (!hits.length) return drawn
    const { Box, Text, Button } = $.ui.resolve(e)
    const reveal = e.surface === 'desktop'
    return (
      <Box flexDirection="column">
        {drawn}
        <Box flexDirection="row" flexWrap="wrap" gap={1} paddingLeft={2}>
          <Text dimColor>用語集にない言葉：</Text>
          {hits.map((c, i) => (
            <Box key={`kc-${i}`} flexDirection="row">
              <Text color={PALETTE.term}>{c.name}</Text>
              <Box paddingLeft={1} {...(reveal ? { display: 'none' as const, hover: { display: 'flex' as const } } : {})}>
                <Button
                  key={`kc-add-${termIdOf(c.name)}`}
                  plain
                  dimColor
                  label="＋ 追加"
                  onPress={async () => $.ui.toast(await addCandidate($, c))}
                />
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Link, Button } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const s = await read($, summary)
    // 描画中は書き込まず、空なら設定から読むだけにする（/clear のあと）
    const href = (await read($, url)) || (await resolveUrl($))
    const cols = e.props?.bodyColumns ?? 48
    const px = Math.max(260, Math.min(560, Math.round(cols * 8.2)))
    const link = s.sessionId ? `${href}#s-${s.sessionId}` : href

    const head = (label: string, color: string, count: string) => (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text color={color}>●</Text>
        <Text bold>{label}</Text>
        <Text dimColor>{count}</Text>
      </Box>
    )

    if (!href) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold wrap="wrap">
            保存先の Artifact が未設定です
          </Text>
          <Text dimColor wrap="wrap">
            {SETUP_TEXT}
          </Text>
        </Box>
      )
    }

    if (!s.updatedAt) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text wrap="wrap">このセッションの思考マップはまだありません。</Text>
          <Text dimColor wrap="wrap">
            /kabemap を送ると、会話から問い・選択肢・決定と用語を拾って Artifact に保存し、ここに概要を出します。
          </Text>
          <Link href={href} label="思考マップを開く（全セッション）" />
        </Box>
      )
    }

    const cands = pendingCandidates(s)
    const reveal = e.surface === 'desktop'
    const current = s.items.filter(it => !it.previous)
    const previous = s.items.filter(it => it.previous)
    const d = new Date(s.updatedAt + 9 * 3_600_000)
    const stamp = `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor>{`${s.folder}　最終更新 ${stamp}`}</Text>
          <Text bold wrap="wrap">
            {s.title || '（無題）'}
          </Text>
          {s.continuesFrom ? (
            <Text color={PALETTE.continued} wrap="wrap">
              {`↩ 前回「${s.continuesFrom}」の続き`}
            </Text>
          ) : null}
          {s.summary ? (
            <Text dimColor wrap="wrap">
              {s.summary}
            </Text>
          ) : null}
        </Box>
        {Svg ? (
          <Svg
            alt={`問い${s.counts.questions}件、決定${s.counts.decisions}件、新しい用語${s.newTerms.length}件`}
            width={px}
            source={tilesSvg(
              [
                { label: '問い', value: s.counts.questions, color: PALETTE.question },
                { label: '決定', value: s.counts.decisions, color: PALETTE.decision },
                {
                  label: '新しい用語',
                  value: s.newTerms.length,
                  sub: s.counts.terms ? `計${s.counts.terms}` : undefined,
                  color: PALETTE.term,
                },
              ],
              px,
            )}
          />
        ) : (
          <Text>{`問い ${s.counts.questions}　決定 ${s.counts.decisions}　新しい用語 ${s.newTerms.length}`}</Text>
        )}
        <Link href={link} label="思考マップを開く →" />

        {head('問いと決定', PALETTE.question, `${current.length}件`)}
        <Box flexDirection="column">
          {current.map((it, i) =>
            it.kind === 'question' ? (
              <Box key={`q-${i}`} flexDirection="row" gap={1}>
                <Text color={PALETTE.question} bold>
                  問
                </Text>
                <Text wrap="wrap" bold>
                  {it.label}
                </Text>
                {it.open ? <Text dimColor>未決</Text> : null}
              </Box>
            ) : (
              <Box key={`d-${i}`} flexDirection="row" gap={1} paddingLeft={2}>
                <Text color={it.superseded ? PALETTE.superseded : PALETTE.decision}>{it.superseded ? '×' : '→'}</Text>
                <Text wrap="wrap" strikethrough={it.superseded} dimColor={it.superseded}>
                  {it.label}
                </Text>
              </Box>
            ),
          )}
        </Box>

        {previous.length > 0 ? (
          <Box flexDirection="column">
            {head('前回のマップで覆した決定', PALETTE.continued, `${previous.length}件`)}
            {previous.map((it, i) => (
              <Box key={`p-${i}`} flexDirection="row" gap={1} paddingLeft={2}>
                <Text color={PALETTE.superseded}>×</Text>
                <Text wrap="wrap" strikethrough dimColor>
                  {it.label}
                </Text>
              </Box>
            ))}
          </Box>
        ) : null}

        {cands.length > 0 ? (
          <Box flexDirection="column">
            {head('会話に出てきた未登録の言葉', PALETTE.term, `${cands.length}件`)}
            {cands.map((c, i) => (
              <Box key={`pc-${i}`} flexDirection="row" gap={1} paddingLeft={2}>
                <Text color={PALETTE.term}>{c.name}</Text>
                <Text dimColor wrap="wrap">
                  {c.definition}
                </Text>
                <Box {...(reveal ? { display: 'none' as const, hover: { display: 'flex' as const } } : {})}>
                  <Button
                    key={`pc-add-${termIdOf(c.name)}`}
                    plain
                    label="＋ 追加"
                    onPress={async () => $.ui.toast(await addCandidate($, c))}
                  />
                </Box>
              </Box>
            ))}
          </Box>
        ) : null}

        {s.newTerms.length > 0 ? (
          <Box flexDirection="column" gap={1}>
            {head('新しい用語', PALETTE.term, `${s.newTerms.length}件`)}
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              {s.newTerms.map(t => (
                <Text key={`t-${t}`} backgroundColor={tint(PALETTE.term, 0.14)} color={PALETTE.term}>
                  {` ${t} `}
                </Text>
              ))}
            </Box>
          </Box>
        ) : null}
      </Box>
    )
  })
}
