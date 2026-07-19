/** 侧栏折叠图标（与 Cursor / 系统侧栏切换同款） */
const SiderToggleIcon = ({
  side = 'left'
}: {
  side?: 'left' | 'right'
}): JSX.Element => (
  <svg
    className="sider-toggle-svg"
    viewBox="0 0 16 16"
    width="16"
    height="16"
    aria-hidden="true"
  >
    <rect
      x="1.5"
      y="1.5"
      width="13"
      height="13"
      rx="2.2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path
      d={side === 'right' ? 'M10.5 2v12' : 'M5.5 2v12'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    />
  </svg>
)

export default SiderToggleIcon
