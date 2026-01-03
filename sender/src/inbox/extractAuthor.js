const USERNAME_PATTERN = /^[a-z0-9_]{4,32}$/

function normalizeUsername(raw) {
  if (!raw) return ''
  return String(raw).toLowerCase().replace(/^@+/, '')
}

export async function extractAuthorUsernameFromMessage(parserClient, message, denyList = []) {
  try {
    if (!message) return { reason: 'NO_USERNAME' }

    const deny = new Set((denyList || []).map((u) => normalizeUsername(u)))

    const checkUser = (user) => {
      const username = normalizeUsername(user?.username)
      if (!username) return { reason: 'NO_USERNAME' }
      if (!USERNAME_PATTERN.test(username)) return { reason: 'NO_USERNAME' }
      if (username.endsWith('bot')) return { reason: 'DENY' }
      if (deny.has(username)) return { reason: 'DENY' }
      return { username }
    }

    const resolveByUserId = async (userId) => {
      try {
        if (!userId) return { reason: 'NO_USERNAME' }
        const entity = await parserClient.client.getEntity(userId)
        return checkUser(entity)
      } catch {
        return { reason: 'NO_USERNAME' }
      }
    }

    if (message?.from?.className === 'User' || message?.fromId?.userId) {
      const user = message.from || message?.fromId
      let res = checkUser(user)
      if (!res.username && message?.fromId?.userId)
        res = await resolveByUserId(message.fromId.userId)
      if (res.username) return res
      return res
    }

    const fwd = message?.fwdFrom
    if (fwd?.from?.className === 'User' || fwd?.fromId?.userId) {
      const user = fwd.from || fwd.fromId
      let res = checkUser(user)
      if (!res.username && fwd?.fromId?.userId) res = await resolveByUserId(fwd.fromId.userId)
      if (res.username) return res
      return res
    }

    const replyTo = message?.replyTo
    if (replyTo?.userId) {
      const res = await resolveByUserId(replyTo.userId)
      if (res.username) return res
    }

    const entities = message?.entities || []
    for (const ent of entities) {
      if (
        (ent.className === 'MessageEntityMentionName' ||
          ent.className === 'MessageEntityTextMention') &&
        ent.userId
      ) {
        const res = await resolveByUserId(ent.userId)
        if (res.username) return res
      }
    }

    if (message?.from?.className === 'Channel' || message?.viaBotId)
      return { reason: 'CHANNEL_POST' }

    return { reason: 'NO_USERNAME' }
  } catch {
    return { reason: 'UNKNOWN' }
  }
}

export default extractAuthorUsernameFromMessage
