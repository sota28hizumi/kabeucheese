import { expect, test } from 'claude-code/testing'

import { artifactIdOf, findSecret, folderOf, toSummary, UNSORTED } from './register'

const PANE = {
  plugin: 'kabeucheese',
  component: 'Pane',
  requestId: 'kabeucheese',
  props: {
    title: '思考マップ',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SID = '11111111-2222-3333-4444-555555555555'

function engine(on: any, store: Map<string, unknown>, opened: string[], configUrl = 'https://claude.ai/artifact/TEST') {
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('tool.register', (_: unknown, e: { name: string }) => ({ value: { tool: `mcp__kabeucheese__${e.name}` } }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.id', () => ({ value: SID }))
  on('session.cwd', () => ({ value: 'C:\\Users\\me\\myGoogleDrive\\jobHunting' }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('fs.read', () => ({ value: JSON.stringify({ artifactUrl: configUrl }) }))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
}

test('フォルダ名：末尾のフォルダ名、フォルダなしは未分類', () => {
  expect(folderOf('C:\\Users\\me\\myGoogleDrive\\jobHunting', 'C:\\Users\\me')).toBe('jobHunting')
  expect(folderOf('G:/マイドライブ/researchNotes/', 'C:\\Users\\me')).toBe('researchNotes')
  expect(folderOf('C:\\Users\\me', 'C:\\Users\\me')).toBe(UNSORTED)
  expect(folderOf('C:\\Users\\me\\AppData\\Local\\Temp\\claude\\x', 'C:\\Users\\me')).toBe(UNSORTED)
  expect(folderOf('', 'C:\\Users\\me')).toBe(UNSORTED)
})

test('show の入力：崩れた項目は捨て、件数がなければ数える', () => {
  const s = toSummary(
    {
      title: 'kabeucheese の設計',
      items: [
        { kind: 'question', label: '表示先は？' },
        { kind: 'decision', label: 'Artifact', superseded: false },
        { kind: 'decision', label: 'ペインだけ', superseded: true },
        { kind: 'note', label: '捨てる' },
        { kind: 'question' },
        'x',
      ],
      newTerms: ['ローカルマーケットプレイス', 3],
    },
    SID,
    'side-project',
    1000,
  )
  expect(s.items.length).toBe(3)
  expect(s.counts.questions).toBe(1)
  expect(s.counts.decisions).toBe(1)
  expect(s.newTerms).toEqual(['ローカルマーケットプレイス'])
  expect(s.folder).toBe('side-project')
})

test('show ツールで概要を保存してペインを開き、問いと決定を出す', async ($, on) => {
  const store = new Map<string, unknown>()
  const opened: string[] = []
  engine(on, store, opened)
  await $.session.start({ cwd: 'C:\\Users\\me\\myGoogleDrive\\jobHunting', surface: 'desktop', isInteractive: true })

  const ctx = await $.tool.call({ tool: 'mcp__kabeucheese__context' } as any)
  const parsed = JSON.parse(String((ctx as any).result))
  expect(parsed.sessionId).toBe(SID)
  expect(parsed.folder).toBe('jobHunting')
  expect(parsed.artifactUrl).toBe('https://claude.ai/artifact/TEST')
  // 時刻は UTC の ISO 文字列（Z で終わる）
  expect(parsed.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  await $.tool.call({
    tool: 'mcp__kabeucheese__show',
    title: '逆質問の方針',
    summary: '面接の逆質問をどう組むかを考えた。',
    items: [
      { kind: 'question', label: '逆質問は何個用意するか' },
      { kind: 'decision', label: '2個', superseded: true },
      { kind: 'decision', label: '3個', superseded: false },
    ],
    counts: { questions: 1, decisions: 1, terms: 2 },
    newTerms: ['STAR法'],
  } as any)
  expect(opened).toContain('kabeucheese')
  expect((store.get(`summary:${SID}`) as any).title).toBe('逆質問の方針')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /逆質問は何個/ }))?.text).toBe('逆質問は何個用意するか')
  const old = await ui.find({ type: 'Text', text: /^2個$/ })
  expect(old?.props?.strikethrough).toBe(true)
  expect(await ui.find({ type: 'Text', text: /STAR法/ })).toBeTruthy()
  const link = await ui.find({ type: 'Link' })
  expect(link?.props?.href).toBe(`https://claude.ai/artifact/TEST#s-${SID}`)
  await ui.unmount()
})

test('/kabeview：保存済みの概要を読み直して開く。なければ案内', async ($, on) => {
  const store = new Map<string, unknown>()
  const opened: string[] = []
  engine(on, store, opened)
  await $.session.start({ cwd: 'C:\\Users\\me', surface: 'terminal', isInteractive: true })

  const none = await $.command.run({ command: 'kabeview' })
  expect(none.text).toMatch(/まだありません/)

  store.set(`summary:${SID}`, toSummary({ title: '保存済み', items: [{ kind: 'question', label: '問いA' }] }, SID, UNSORTED, 5))
  const found = await $.command.run({ command: 'kabeview' })
  expect(found.text).toMatch(/開きました/)
  expect(opened.length).toBe(2)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /問いA/ }))?.text).toBe('問いA')
  await ui.unmount()
})

test('まだ作っていないときは案内と Artifact へのリンク', async ($, on) => {
  engine(on, new Map(), [])
  await $.session.start({ cwd: 'C:\\Users\\me', surface: 'mobile', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect((await ui.find({ type: 'Text', text: /まだありません/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Link' }))?.props?.href).toBe('https://claude.ai/artifact/TEST')
  await ui.unmount()
})

test('保存先が未設定：/kabemap は案内を返し、/kabemap <URL> で保存できる', async ($, on) => {
  const store = new Map<string, unknown>()
  const opened: string[] = []
  engine(on, store, opened, '')
  await $.session.start({ cwd: 'C:\\Users\\me', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /未設定/ })).toBeTruthy()
  await ui.unmount()

  const first = await $.command.run({ command: 'kabemap' })
  expect(first.text).toMatch(/はじめての設定/)

  const bad = await $.command.run({ command: 'kabemap', args: 'https://example.com/x' })
  expect(bad.text).toMatch(/Artifact の URL/)

  const set = await $.command.run({ command: 'kabemap', args: 'https://claude.ai/artifact/MINE' })
  expect(set.text).toMatch(/設定しました/)
  expect(store.get('artifactUrl')).toBe('https://claude.ai/artifact/MINE')

  const ctx = await $.tool.call({ tool: 'mcp__kabeucheese__context' } as any)
  expect(JSON.parse(String((ctx as any).result)).artifactUrl).toBe('https://claude.ai/artifact/MINE')
})

test('前回の続き：ペインに前回のセッション名と、前回のマップで覆した決定を出す', async ($, on) => {
  const store = new Map<string, unknown>()
  engine(on, store, [])
  await $.session.start({ cwd: 'C:\\Users\\me\\research', surface: 'desktop', isInteractive: true })

  await $.tool.call({
    tool: 'mcp__kabeucheese__show',
    title: '実験条件の続き',
    continuesFrom: '実験条件の決め方',
    items: [
      { kind: 'decision', label: 'サンプル数は20', superseded: true, previous: true },
      { kind: 'question', label: 'サンプル数を増やすか' },
      { kind: 'decision', label: 'サンプル数は40', superseded: false },
    ],
  } as any)
  const saved = store.get(`summary:${SID}`) as any
  expect(saved.continuesFrom).toBe('実験条件の決め方')
  // 前回の分は最後にまとめられ、覆った扱いになる
  expect(saved.items.map((i: any) => i.label)).toEqual(['サンプル数を増やすか', 'サンプル数は40', 'サンプル数は20'])
  expect(saved.items[2].superseded).toBe(true)
  expect(saved.counts.decisions).toBe(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /前回「実験条件の決め方」の続き/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /前回のマップで覆した決定/ }))).toBeTruthy()
  const old = await ui.find({ type: 'Text', text: /^サンプル数は20$/ })
  expect(old?.props?.strikethrough).toBe(true)
  await ui.unmount()
})

test('前の版で保存した概要（continuesFrom・previous が無い）も読み直せる', async ($, on) => {
  const store = new Map<string, unknown>()
  store.set(`summary:${SID}`, {
    sessionId: SID, folder: 'x', title: '古い概要', summary: '', items: [{ kind: 'question', label: '古い問い', superseded: false }],
    counts: { questions: 1, decisions: 0, terms: 0 }, newTerms: [], updatedAt: 5,
  })
  engine(on, store, [])
  await $.session.start({ cwd: 'C:\\Users\\me', surface: 'desktop', isInteractive: true })
  const r = await $.command.run({ command: 'kabeview' })
  expect(r.text).toMatch(/開きました/)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /古い問い/ }))?.text).toBe('古い問い')
  expect(await ui.find({ type: 'Text', text: /の続き/ })).toBeFalsy()
  await ui.unmount()
})

test('機密の検査：API キーやトークンらしい文字列を見つけ、ふつうの文は通す', () => {
  expect(findSecret({ detail: 'キーは sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 だった' })).toMatch(/API キー/)
  expect(findSecret([{ data: { nodes: [{ label: 'x', detail: 'ghp_' + 'a'.repeat(36) }] } }])).toMatch(/GitHub/)
  expect(findSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe('秘密鍵')
  expect(findSecret({ note: 'password = hunter2hunter2' })).toMatch(/パスワード/)
  expect(findSecret({ label: 'API キーは環境変数に置くことにした', terms: ['token', 'secret'] })).toBeNull()
  expect(findSecret({ detail: 'sk-learn と scikit-learn を比べた' })).toBeNull()
  expect(artifactIdOf('https://claude.ai/code/artifact/AbC-1?x=1')).toBe('AbC-1')
  expect(artifactIdOf('https://example.com/artifact/AbC')).toBe('')
})

test('ArtifactData：保存先への書き込みに機密があれば止め、それ以外は通す', async ($, on) => {
  const ran: string[] = []
  engine(on, new Map(), [])
  on('tool.call', (_: unknown, e: { tool: string; action?: string }) => {
    if (e.tool === 'ArtifactData') ran.push(String(e.action))
    return { result: 'ok' }
  })
  await $.session.start({ cwd: 'C:\Users\me\research', surface: 'desktop', isInteractive: true })
  const secret = { nodes: [{ id: 'd1', detail: 'AKIAABCDEFGHIJKLMNOP を使う' }] }

  const denied = await $.tool.call({
    tool: 'ArtifactData', action: 'batch', url: 'https://claude.ai/artifact/TEST',
    writes: [{ op: 'set', collection: 'sessions', doc_id: 's1', data: secret }],
  } as any)
  expect((denied as any).deny).toMatch(/AWS のアクセスキー/)
  expect((denied as any).deny).not.toMatch(/AKIA/)
  expect(ran).toEqual([])

  // 読み取り、別の Artifact への書き込み、機密の無い書き込みは通る
  await $.tool.call({ tool: 'ArtifactData', action: 'get', url: 'https://claude.ai/artifact/TEST', collection: 'sessions', doc_id: 's1' } as any)
  await $.tool.call({ tool: 'ArtifactData', action: 'set', url: 'https://claude.ai/artifact/OTHER', collection: 'x', doc_id: 'y', data: secret } as any)
  const ok = await $.tool.call({
    tool: 'ArtifactData', action: 'set', url: 'https://claude.ai/code/artifact/TEST', collection: 'sessions', doc_id: 's1',
    data: { nodes: [{ id: 'q1', label: 'API キーの置き場所をどうするか' }] },
  } as any)
  expect((ok as any).result).toBe('ok')
  expect(ran).toEqual(['get', 'set', 'set'])
})

test('未決の問い：ペインに「未決」と出す', async ($, on) => {
  const store = new Map<string, unknown>()
  engine(on, store, [])
  await $.session.start({ cwd: 'C:\Users\me\research', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__kabeucheese__show',
    title: '手法の比較',
    items: [
      { kind: 'question', label: 'A と B のどちらにするか', open: true },
      { kind: 'question', label: '評価指標は何にするか' },
      { kind: 'decision', label: 'F1 を使う', open: true },
    ],
  } as any)
  const saved = store.get(`summary:${SID}`) as any
  expect(saved.items[0].open).toBe(true)
  expect(saved.items[1].open).toBeUndefined()
  expect(saved.items[2].open).toBeUndefined()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^未決$/ })).toBeTruthy()
  await ui.unmount()
})
