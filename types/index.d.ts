export type Item = {
  kind: 'question' | 'decision'
  label: string
  /** 覆った決定（取り消し線で出す） */
  superseded: boolean
  /** 前回のセッションのマップにある決定（この会話で覆したもの） */
  previous: boolean
}

export type Summary = {
  sessionId: string
  folder: string
  title: string
  summary: string
  /** 続きとして結んだ前回のセッション名。前回なしは空文字 */
  continuesFrom: string
  items: Item[]
  counts: { questions: number; decisions: number; terms: number }
  newTerms: string[]
  /** 最後に /kabemap で更新した時刻（epoch ms）。未作成は 0 */
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    kabeucheese: {
      summary: Shaped<Summary>
      /** Artifact の URL（config.json から読む） */
      url: Shaped<string>
    }
  }
}
