function buildUserLinkFromEntity(entity) {
  const userId = entity?.id || entity?.userId || null
  const username = (entity?.username || '').toString().trim()
  if (username) {
    return {
      link: `https://t.me/${username}`,
      username: username.toLowerCase(),
      userId,
      source: 'username'
    }
  }
  if (userId) {
    return { link: `tg://user?id=${userId}`, username: null, userId, source: 'id' }
  }
  return null
}

export async function resolveSenderLink(parserClient, message) {
  try {
    if (!parserClient || !message) return null

    if (message.from) {
      const direct = buildUserLinkFromEntity(message.from)
      if (direct) return { ...direct, source: 'from' }
    }
    if (message.fromId?.userId) {
      try {
        const ent = await parserClient.client.getEntity(message.fromId.userId)
        const byId = buildUserLinkFromEntity(ent)
        if (byId) return { ...byId, source: 'fromId' }
      } catch {}
    }

    const fwd = message.fwdFrom
    if (fwd?.from) {
      const fwdRes = buildUserLinkFromEntity(fwd.from)
      if (fwdRes) return { ...fwdRes, source: 'fwd.from' }
    }
    if (fwd?.fromId?.userId) {
      try {
        const ent = await parserClient.client.getEntity(fwd.fromId.userId)
        const byId = buildUserLinkFromEntity(ent)
        if (byId) return { ...byId, source: 'fwd.userId' }
      } catch {}
    }

    if (message.replyTo?.userId) {
      try {
        const ent = await parserClient.client.getEntity(message.replyTo.userId)
        const byId = buildUserLinkFromEntity(ent)
        if (byId) return { ...byId, source: 'replyTo' }
      } catch {}
    }

    const entities = message.entities || []
    for (const ent of entities) {
      if (
        (ent.className === 'MessageEntityMentionName' ||
          ent.className === 'MessageEntityTextMention') &&
        ent.userId
      ) {
        try {
          const u = await parserClient.client.getEntity(ent.userId)
          const byId = buildUserLinkFromEntity(u)
          if (byId) return { ...byId, source: 'entity' }
        } catch {}
      }
    }

    return null
  } catch {
    return null
  }
}

export default resolveSenderLink
