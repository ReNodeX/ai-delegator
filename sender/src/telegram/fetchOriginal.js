export async function fetchOriginalMessage(parserClient, linkParsed) {
  try {
    if (!parserClient || !linkParsed) return null

    const { client } = parserClient

    if (linkParsed.kind === 'c') {
      const peerId = BigInt(`-100${linkParsed.chatId}`)
      const messages = await client.getMessages(Number(peerId), { ids: [linkParsed.msgId] })
      const message = messages?.[0] || null
      return message ? { message, peerId, msgId: linkParsed.msgId } : null
    }

    if (linkParsed.kind === 'public') {
      const entity = await client.getEntity(linkParsed.username)
      const peerId = entity?.id
      if (!peerId) return null
      const messages = await client.getMessages(peerId, { ids: [linkParsed.msgId] })
      const message = messages?.[0] || null
      return message ? { message, peerId, msgId: linkParsed.msgId } : null
    }

    return null
  } catch (error) {
    return null
  }
}

export default fetchOriginalMessage
