import { useLayoutEffect, useState, type RefObject } from 'react'

interface Props {
  boardRef: RefObject<HTMLElement | null>
  /** 节点内容变化时触发重绘 */
  revision: string | number
}

/**
 * 云效式「血管」连线：相邻阶段卡片之间用三次贝塞尔曲线连接。
 */
const PipeFlowEdges = ({ boardRef, revision }: Props): JSX.Element | null => {
  const [paths, setPaths] = useState<string[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const board = boardRef.current
    if (!board) return

    const redraw = (): void => {
      const boardRect = board.getBoundingClientRect()
      const w = Math.max(board.scrollWidth, board.clientWidth)
      const h = Math.max(board.scrollHeight, board.clientHeight)
      setSize({ w, h })

      const stageIds = Array.from(
        new Set(
          Array.from(board.querySelectorAll<HTMLElement>('[data-pipe-stage]')).map((el) =>
            el.getAttribute('data-pipe-stage')
          )
        )
      )
        .filter((id): id is string => id != null)
        .sort((a, b) => Number(a) - Number(b))

      const next: string[] = []
      for (let i = 0; i < stageIds.length - 1; i++) {
        const fromNodes = Array.from(
          board.querySelectorAll<HTMLElement>(`[data-pipe-stage="${stageIds[i]}"]`)
        )
        const toNodes = Array.from(
          board.querySelectorAll<HTMLElement>(`[data-pipe-stage="${stageIds[i + 1]}"]`)
        )
        if (!fromNodes.length || !toNodes.length) continue

        // 节点过多时改为扇入/扇出，避免 N×M 连线爆炸
        const pairs: Array<[HTMLElement, HTMLElement]> = []
        if (fromNodes.length * toNodes.length <= 12) {
          for (const from of fromNodes) {
            for (const to of toNodes) pairs.push([from, to])
          }
        } else if (fromNodes.length === 1) {
          for (const to of toNodes) pairs.push([fromNodes[0], to])
        } else if (toNodes.length === 1) {
          for (const from of fromNodes) pairs.push([from, toNodes[0]])
        } else {
          const midFrom = fromNodes[Math.floor((fromNodes.length - 1) / 2)]
          const midTo = toNodes[Math.floor((toNodes.length - 1) / 2)]
          for (const from of fromNodes) pairs.push([from, midTo])
          for (const to of toNodes) {
            if (to !== midTo) pairs.push([midFrom, to])
          }
        }

        for (const [from, to] of pairs) {
          const fr = from.getBoundingClientRect()
          const tr = to.getBoundingClientRect()
          const x1 = fr.right - boardRect.left + board.scrollLeft
          const y1 = fr.top + fr.height / 2 - boardRect.top + board.scrollTop
          const x2 = tr.left - boardRect.left + board.scrollLeft
          const y2 = tr.top + tr.height / 2 - boardRect.top + board.scrollTop
          const dx = Math.max(36, (x2 - x1) * 0.45)
          next.push(
            `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + dx).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`
          )
        }
      }
      setPaths(next)
    }

    redraw()
    const ro = new ResizeObserver(() => redraw())
    ro.observe(board)
    board.querySelectorAll('.pipe-flow-node').forEach((el) => ro.observe(el))
    window.addEventListener('resize', redraw)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', redraw)
    }
  }, [boardRef, revision])

  if (!size.w || !size.h) return null

  return (
    <svg
      className="pipe-flow-edges"
      width={size.w}
      height={size.h}
      viewBox={`0 0 ${size.w} ${size.h}`}
      aria-hidden
    >
      {paths.map((d, i) => (
        <path key={`${d}-${i}`} d={d} className="pipe-flow-edge" fill="none" />
      ))}
    </svg>
  )
}

export default PipeFlowEdges
