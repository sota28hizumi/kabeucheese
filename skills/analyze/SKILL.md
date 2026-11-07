---
name: analyze
description: thinkmap の解析手順。今のセッションの会話を見直して、問い・選択肢・決定・用語を thinkmap Artifact のデータベースに差分で書き込み、ペインを開く。ユーザーが /thinkmap を送ったとき、または「思考マップを更新して」「thinkmap を作って」と頼んだときに使う。
---

# thinkmap：会話を論点の地図にする

このセッションの壁打ちを、あとから見返せる「問い → 選択肢 → 決定」の地図と用語カードにして、thinkmap Artifact のデータベースに保存する。最後にペインを開く。

## 0. 前提を取る

1. `mcp__thinkmap__context`（名前が見つからなければ ToolSearch で `thinkmap context` を探す）を呼ぶ。`sessionId`・`folder`・`artifactUrl` が返る。`artifactUrl` が空なら保存先が未設定なので、ここで止まり、README の「はじめての設定」を案内する。ツールが無い環境では、`sessionId` は不明として止まり、ユーザーに thinkmap Mod が入っているか確かめてもらう。
2. `ArtifactData` を ToolSearch で読み込む（`select:ArtifactData`）。以降の読み書きはすべて `url: artifactUrl` で行う。

## 1. 前回のデータを読む

- `get` で `sessions/<sessionId>` を読む。あれば、その `version` を控える（書き込み時の `if_version`）。無ければ新規。
- `list` で `terms` を全部読む（`query.limit: 1000`）。既存の用語の `id`・`name`・`occurrences`・`version` を控える。
- `get` で `meta/current` を読み、あれば `version` を控える。
- `memos` コレクションには**触らない**（読みも書きもしない）。ユーザーがページで書いたメモはそこにあり、論点・用語の id で結び付いている。だから**既存の論点・用語の id は変えない**。

## 2. 会話全体を見直して論点を作る

このセッションの最初から今までの会話を読み、ユーザーが何を考え、何を比べ、何を決めたかを拾う。会話の原文は書かず、短く要約した言葉で書く。

### ノード（`nodes` の各要素）

| フィールド | 中身 |
|---|---|
| `id` | セッション内で一意。英数字と `-` `_` だけ（例：`q1`, `o1-2`, `d1`）。既存のノードは id をそのまま使う |
| `kind` | `question`（問い）／`option`（選択肢）／`decision`（決定）／`superseded`（覆った決定） |
| `label` | 一行の見出し。30字前後まで。問いは「〜か？」「〜をどうするか」の形 |
| `detail` | 2〜4文の中身。なぜそう考えたか、何が決め手か |
| `status` | `active`／`rejected`（選ばなかった案）／`superseded`（変更前の決定） |
| `parent` | 流れ図での親ノードの id。問いの根は `null` |
| `parentKind` | 親との関係。ふつうは `derived`（派生）。決定の根拠になった選択肢なら `reason`、前提から出た問いなら `premise` |
| `order` | 兄弟の中での並び順（数値） |
| `terms` | このノードに付ける用語の id の配列 |

作り方：

- 問いを根にして、その下に選択肢、選んだ選択肢の下（または問いの直下）に決定を置く。決定から次の問いが生まれたら、その問いを決定の子にする。
- 選ばなかった選択肢も消さずに `status: rejected` で残す（ページでは灰色になる）。
- ユーザーが「既定で」「おまかせ」と了承したことも決定として残す。
- 細かすぎる話（ツールの使い方の確認、誤字の修正など）はノードにしない。目安は1セッションで問い3〜15個。

### 枝をまたぐ線（`edges` の各要素）

親子関係で表せないつながりだけを書く：`{ "id": "e1", "from": "<node id>", "to": "<node id>", "kind": "..." }`

- `compared`：選択肢どうしを比べた
- `reason`：あるノードが別の枝の決定の理由になった
- `premise`：あるノードが別の枝の前提になった
- `revised`：覆った決定（from）→ 新しい決定（to）
- `reference`：別のセッション（別フォルダでもよい）の論点を参照した。`toSession` に相手のセッション id を入れる。相手は `query` で `sessions` を `folder` で絞って探し、その `nodes` から一致する論点の id を `to` に入れる。見つからなければ線は引かない

## 3. 前回との差分のとり方（再実行時）

- 前回のノードは id を保ったまま残す。中身が深まっていれば `label` や `detail` を書き直してよい。
- 新しい論点は新しい id で足す（前回の最大番号の続き）。
- 決定が覆ったら、古い決定を `kind: superseded`、`status: superseded` に変え、新しい決定を足して `revised` の線で結ぶ。古い決定は消さない。
- 前回のノードを消すのは、明らかな誤りだったときだけ。

## 4. 用語カード

ユーザーが「○○について教えて」「○○って何？」と聞いた言葉、または壁打ちの中で説明が必要だった専門用語を用語にする。用語集は全セッション共通。

| フィールド | 中身 |
|---|---|
| doc id | 英数字と `-` の短い名前（例：`artifact-db`、`local-marketplace`）。既存の用語と同じものなら、その id を使う（`name` で照合） |
| `name` | 表示名 |
| `definition` | ひとこと定義（40字前後） |
| `contextMeaning` | ユーザーの今の文脈で何を意味するか（1〜2文） |
| `explanation` | 詳しい説明。段落ごとの文字列の配列（2〜4段落） |
| `examples` | 具体例の配列（1〜3個） |
| `related` | 関連用語の id（または名前）の配列 |
| `source` | `{ "type": "web", "urls": [...] }` は、このセッションで WebSearch や WebFetch などで実際に確かめた URL があるときだけ。それ以外は `{ "type": "claude", "urls": [] }` |
| `occurrences` | `[{ "folder", "sessionId", "nodeId" }]`。既存の用語では、前回の配列にこのセッションの分を足した全体を書く（配列は丸ごと置き換わるため） |
| `updatedAt` | ISO 時刻 |

用語のためだけに新しく Web 検索はしない（ユーザーが頼んだときは別）。

## 5. 書き込む

`ArtifactData` の `batch` で書く。1回に50件まで。多ければ分ける。

1. `sessions/<sessionId>` を `set`：
   ```json
   { "id": "<sessionId>", "folder": "<folder>", "title": "<20字前後のセッション名>",
     "summary": "<このセッションで考えたことを2〜3文>", "startedAt": "<前回の値。新規なら今>",
     "updatedAt": "<今>", "nodes": [...], "edges": [...] }
   ```
   既存なら `if_version` に控えた version を付ける。
2. 用語：新しい用語は `set`（`if_version` なし）、既存の用語は `update` で変わったフィールドだけ（`occurrences` は全体）を `if_version` 付きで。
3. `meta/current` を `set`：`{ "folder": "<folder>", "sessionId": "<sessionId>", "updatedAt": "<今>" }`（既存なら `if_version`）。

version の不一致で断られたら、その文書を読み直してから書き直す（相手の変更を上書きしない）。

## 6. ペインを開く

`mcp__thinkmap__show`（見つからなければ ToolSearch で `thinkmap show`）を、次の形で呼ぶ：

```json
{
  "title": "<セッション名>",
  "summary": "<2〜3文>",
  "items": [
    { "kind": "question", "label": "…" },
    { "kind": "decision", "label": "…", "superseded": false },
    { "kind": "decision", "label": "…", "superseded": true }
  ],
  "counts": { "questions": 0, "decisions": 0, "terms": 0 },
  "newTerms": ["このセッションで新しく登録した用語名"]
}
```

`items` は流れ図の順（問いのあとにその決定）。`counts.decisions` は覆っていない決定の数、`counts.terms` はこのセッションのノードに付いた用語の数。

最後にユーザーへ、足した論点・覆った決定・新しい用語を2〜4行で伝え、Artifact の URL を示す。

## 守ること

- **会話の原文を書かない**。要約した論点・決定・用語だけを書く。
- 学籍番号・住所・電話番号・メールアドレス・パスワード・個人名など、個人を特定できる情報は書かない。企業名や研究テーマは論点に必要なら書いてよい。
- Artifact は自分専用のまま。共有の設定は変えない。
- `memos` には書かない。既存の id を変えない。
