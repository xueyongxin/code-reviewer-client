import { message } from 'antd'

/** 复制文本到剪贴板并提示 */
export const copyText = async (
  text: string,
  okMsg = '已复制'
): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    message.success(okMsg)
    return true
  } catch {
    message.error('复制失败')
    return false
  }
}
