import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { Item, Summary } from '../types'

import { PALETTE, tilesSvg, tint } from './svg'

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

const PANE = 'thinkmap'
const TITLE = '思考マップ'
export const UNSORTED = '未分類'

/** config.json に URL が無いとき（未設定）。README の「はじめての設定」で自分の Artifact を作って書く */
const FALLBACK_URL = ''

const EMPTY: Summary = {
  sessionId: '',
  folder: '',
  title: '',
  summary: '',
  items: [],
  counts: { questions: 0, decisions: 0, terms: 0 },
  newTerms: [],
  updatedAt: 0,
}

const summary = atom({ plugin: 'thinkmap', key: 'summary' } as const, EMPTY, { shape: 'summary-1' })
const url = atom({ plugin: 'thinkmap', key: 'url' } as const, FALLBACK_URL, { shape: 'url-1' })

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

/** 保存先の URL：config.json にあればそれ、なければ /thinkmap <URL> でこの PC に保存したもの */
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
      return { kind, label, superseded: o.superseded === true }
    })
    .filter((it): it is Item => it !== null)
    .slice(0, 80)
  const counts = (input.counts && typeof input.counts === 'object' ? input.counts : {}) as Record<string, unknown>
  return {
    sessionId,
    folder,
    title: str(input.title, 80),
    summary: str(input.summary, 400),
    items,
    counts: {
      questions: num(counts.questions) || items.filter(i => i.kind === 'question').length,
      decisions: num(counts.decisions) || items.filter(i => i.kind === 'decision' && !i.superseded).length,
      terms: num(counts.terms),
    },
    newTerms: (Array.isArray(input.newTerms) ? input.newTerms : []).map(t => str(t, 40)).filter(Boolean).slice(0, 30),
    updatedAt: now,
  }
}

async function loadStored($: Engine): Promise<boolean> {
  const sessionId = await $.session.id()
  const stored = (await $.store.get(storeKey(sessionId))) as Summary | undefined
  if (!stored || typeof stored !== 'object' || stored.sessionId !== sessionId || !Array.isArray(stored.items)) return false
  await update($, summary, () => stored)
  return true
}

const openPane = ($: Engine) => $.ui.open({ id: PANE, title: TITLE })

export const SETUP_TEXT =
  '思考マップの保存先がまだ設定されていません。README の「はじめての設定」に沿って Artifact を公開し、/thinkmap <その URL> を送ってください。'

const ANALYZE_PROMPT =
  'thinkmap:analyze スキルの手順で、このセッションの会話を見直して思考マップを更新し、最後にペインを開いてください。'

// ---------------------------------------------------------------------------
// フック
// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await loadUrl($)
    await $.command.register({
      name: 'thinkmap',
      description: '会話を解析して思考マップ（Artifact）を更新し、概要のペインを開く（初回は /thinkmap <Artifact の URL> で保存先を設定）',
      argumentHint: '[Artifact の URL]',
    })
    await $.command.register({
      name: 'thinkview',
      description: '解析せずに、保存済みの思考マップの概要ペインを開き直す',
    })
    await $.tool.register({
      name: 'context',
      description:
        'thinkmap の解析に使う前提（このセッションの sessionId、作業フォルダ名 folder、Artifact の URL artifactUrl）を返す。thinkmap:analyze スキルの最初に呼ぶ。',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'show',
      description:
        'thinkmap:analyze スキルの最後に呼ぶ。このセッションの問いと決定の一覧・件数・新しい用語をペイン用に保存し、思考マップのペインを開く。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'セッション名（20字前後）' },
          summary: { type: 'string', description: 'このセッションで考えたことを2〜3文' },
          items: {
            type: 'array',
            description: '流れ図の順に、問いとその決定',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['question', 'decision'] },
                label: { type: 'string' },
                superseded: { type: 'boolean', description: '覆った決定なら true' },
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
        },
        required: ['title', 'items'],
      },
      isDeferred: false,
    })
    await loadStored($)
    return result
  })

  on('tool.call', { tool: 'mcp__thinkmap__context' }, async $ => {
    const ctx = await contextOf($)
    return { result: JSON.stringify({ sessionId: ctx.sessionId, folder: ctx.folder, artifactUrl: ctx.artifactUrl }) }
  })

  on('tool.call', { tool: 'mcp__thinkmap__show' }, async ($, e) => {
    const input = ((e as { input?: unknown }).input ?? e) as Record<string, unknown>
    const ctx = await contextOf($)
    const next = toSummary(input, ctx.sessionId, ctx.folder, Date.now())
    await update($, summary, () => next)
    await $.store.set(storeKey(ctx.sessionId), next)
    await openPane($)
    return { result: `ペインを開きました（問い${next.counts.questions}・決定${next.counts.decisions}・新しい用語${next.newTerms.length}）。` }
  })

  on('command.run', { command: 'thinkmap' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg) {
      if (!isArtifactUrl(arg)) return { text: 'claude.ai の Artifact の URL（https://claude.ai/artifact/...）を指定してください。' }
      await $.store.set(URL_KEY, arg)
      await update($, url, () => arg)
      return { text: `保存先を設定しました：${arg}\nもう一度 /thinkmap を送ると、このセッションのマップを作ります。` }
    }
    if (!(await read($, url))) {
      await openPane($)
      return { text: SETUP_TEXT }
    }
    // コマンドの処理が終わってから、Claude への依頼として送る
    $.clock.after(0, () => void $.prompt.submit({ text: ANALYZE_PROMPT, asUser: true }).catch(() => {}))
    return { text: '思考マップを更新します。' }
  })

  on('command.run', { command: 'thinkview' }, async $ => {
    const found = await loadStored($)
    await openPane($)
    return {
      text: found ? '保存済みの思考マップを開きました。' : 'このセッションの思考マップはまだありません。/thinkmap で作れます。',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Link } = els
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
            /thinkmap を送ると、会話から問い・選択肢・決定と用語を拾って Artifact に保存し、ここに概要を出します。
          </Text>
          <Link href={href} label="思考マップを開く（全セッション）" />
        </Box>
      )
    }

    const d = new Date(s.updatedAt + 9 * 3_600_000)
    const stamp = `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor>{`${s.folder}　最終更新 ${stamp}`}</Text>
          <Text bold wrap="wrap">
            {s.title || '（無題）'}
          </Text>
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

        {head('問いと決定', PALETTE.question, `${s.items.length}件`)}
        <Box flexDirection="column">
          {s.items.map((it, i) =>
            it.kind === 'question' ? (
              <Box key={`q-${i}`} flexDirection="row" gap={1}>
                <Text color={PALETTE.question} bold>
                  問
                </Text>
                <Text wrap="wrap" bold>
                  {it.label}
                </Text>
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
