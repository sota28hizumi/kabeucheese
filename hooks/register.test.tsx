import { expect, test } from 'claude-code/testing'

import { folderOf, toSummary, UNSORTED } from './register'

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
  expect(JSON.parse(String((ctx as any).result))).toEqual({
    sessionId: SID,
    folder: 'jobHunting',
    artifactUrl: 'https://claude.ai/artifact/TEST',
  })

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
