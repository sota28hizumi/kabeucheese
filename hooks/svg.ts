// ペイン上部の件数タイル（SVG 文字列）。shukatsu-dashboard と同じ見た目にそろえる。
// 原色の塗りは使わず、薄い色面・細い線・色文字の三段階で使い分ける。

export const PALETTE = {
  question: '#3f7bd6', // 瑠璃
  decision: '#22a06b', // 若竹
  term: '#8b5cd6', // 菫
  superseded: '#8a8f98',
  continued: '#9a6a2f', // 続き：チーズの皮の茶
  muted: '#7d838c',
}

/** #rrggbb に透明度を付ける（0〜1） */
export const tint = (hex: string, alpha: number) =>
  `${hex}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const FONT = `font-family="'Hiragino Sans','Yu Gothic UI','Meiryo',sans-serif"`
const NUM = `font-family="'SF Pro Display','Segoe UI Variable Display','Segoe UI',sans-serif"`

export type Tile = { label: string; value: number; sub?: string; color: string }

/** 件数タイル：薄い色面と細い枠、数字だけを色で立たせる */
export function tilesSvg(tiles: Tile[], width: number): string {
  const gap = 8
  const h = 62
  const w = (width - gap * (tiles.length - 1)) / tiles.length
  const body = tiles
    .map((t, i) => {
      const x = i * (w + gap)
      return [
        `<rect x="${x + 0.5}" y="0.5" width="${w - 1}" height="${h - 1}" rx="8" fill="${tint(t.color, 0.12)}" stroke="${tint(t.color, 0.45)}"/>`,
        `<rect x="${x + 10}" y="12" width="3" height="10" rx="1.5" fill="${t.color}"/>`,
        `<text x="${x + 18}" y="21" font-size="10.5" fill="${PALETTE.muted}" ${FONT}>${esc(t.label)}</text>`,
        `<text x="${x + 10}" y="50" font-size="24" font-weight="600" fill="${t.color}" ${NUM}>${t.value}</text>`,
        t.sub
          ? `<text x="${x + w - 9}" y="49" font-size="9.5" text-anchor="end" fill="${PALETTE.muted}" ${FONT}>${esc(t.sub)}</text>`
          : '',
      ].join('')
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${body}</svg>`
}
