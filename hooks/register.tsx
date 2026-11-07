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
    read($, url),
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

/** 保存先の URL：config.json にあればそれ、なければ /kabemap <URL> でこの PC に保存したもの */
async function loadUrl($: Engine) {
  let next = ''
  try {
    const text = await $.fs.read(`${$.plugin.root}/config.json`)
    const parsed = JSON.parse(typeof text === 'string' ? text : '') as { artifactUrl?: unknown }
    if (isArtifactUrl(parsed.artifactUrl)) next = parsed.artifactUrl
  } catch {
    // 読めなければ下へ
  }
  if (!next) {
    const saved = await $.store.get(URL_KEY)
    if (isArtifactUrl(saved)) next = saved
  }
  if (next) await update($, url, () => next)
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

  // 保存先の Artifact への書き込みに、API キーなど機密らしい文字列が入っていたら止める
  on('tool.call', { tool: 'ArtifactData' }, async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const target = artifactIdOf(await read($, url))
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
    if (!(await read($, url))) {
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
    const href = await read($, url)
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
