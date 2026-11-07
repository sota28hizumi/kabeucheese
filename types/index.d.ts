export type Item = {
  kind: 'question' | 'decision'
  label: string
  /** 覆った決定（取り消し線で出す） */
  superseded: boolean
  /** 前回のセッションのマップにある決定（この会話で覆したもの） */
  previous: boolean
  /** まだ決めていない問い（question のときだけ） */
  open?: boolean
}

/** 会話に出てきたが用語集に無い言葉（解析のときに Claude が拾う） */
export type Candidate = {
  name: string
  /** ひとこと定義（追加したときの下書き） */
  definition: string
  /** この会話の文脈での意味 */
  contextMeaning: string
  /** 出てきた論点の id（無ければ空文字） */
  nodeId: string
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
  /** 未登録の言葉の候補 */
  candidates?: Candidate[]
  /** 候補のうち、このセッションで用語集に追加したものの名前 */
  added?: string[]
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
