export type Item = {
  kind: 'question' | 'decision'
  label: string
  /** 覆った決定（取り消し線で出す） */
  superseded: boolean
}

export type Summary = {
  sessionId: string
  folder: string
  title: string
  summary: string
  items: Item[]
  counts: { questions: number; decisions: number; terms: number }
  newTerms: string[]
  /** 最後に /thinkmap で更新した時刻（epoch ms）。未作成は 0 */
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    thinkmap: {
      summary: Shaped<Summary>
      /** Artifact の URL（config.json から読む） */
      url: Shaped<string>
    }
  }
}
