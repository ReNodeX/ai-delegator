const C_LINK = /(?:https?:\/\/)?t\.me\/c\/(\d{5,20})\/(\d{1,10})/i,
  PUBLIC_LINK = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,32})\/(\d{1,10})/i

export function parseLeadLink(leadText) {
  if (!leadText || typeof leadText !== 'string') return null

  const cMatch = C_LINK.exec(leadText)
  if (cMatch) {
    const chatId = cMatch[1],
      msgId = Number(cMatch[2])
    if (chatId && Number.isFinite(msgId)) return { kind: 'c', chatId, msgId }
  }

  const pMatch = PUBLIC_LINK.exec(leadText)
  if (pMatch) {
    const username = pMatch[1],
      msgId = Number(pMatch[2])
    if (username && Number.isFinite(msgId)) return { kind: 'public', username, msgId }
  }

  return null
}

export default parseLeadLink
