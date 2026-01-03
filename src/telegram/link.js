import { Api } from 'telegram'
import { logTelegramLink } from '../core/logger.js'

const linkConfig = {
  supergroupIdPrefix: '-100',
  channelIdPrefix: '-',
  telegramMeBase: 'https://t.me',
  telegramProtocolPrefix: 'tg://openmessage'
}

export class MessageLinkGenerator {
  constructor(client) {
    if (!client) throw new Error('Telegram клиент обязателен')
    this.client = client
    logTelegramLink.info('генератор ссылок на сообщения инициализирован')
  }

  async generateLink(peer, messageId) {
    if (!peer || !messageId) throw new Error('Peer и messageId обязательны')

    const startTime = performance.now()

    try {
      const permanentLink = await this.getPermanentLink(peer, messageId)
      if (permanentLink) {
        logTelegramLink.info(
          { peerId: peer.id.toString(), messageId, linkType: 'permanent' },
          'сгенерирована постоянная ссылка'
        )
        return permanentLink
      }

      if (this.isSupergroup(peer)) {
        const supergroupLink = this.getSupergroupLink(peer, messageId)
        logTelegramLink.info(
          { peerId: peer.id.toString(), messageId, linkType: 'supergroup' },
          'сгенерирована ссылка супергруппы'
        )
        return supergroupLink
      }

      const fallbackLink = this.getTelegramMeLink(peer, messageId)
      logTelegramLink.info(
        { peerId: peer.id.toString(), messageId, linkType: 'telegram_me_fallback' },
        'сгенерирована fallback ссылка'
      )
      return fallbackLink
    } catch (error) {
      const durationMs = Math.round(performance.now() - startTime)
      logTelegramLink.error(
        { err: error, peerId: peer?.id?.toString(), messageId, durationMs },
        'не удалось сгенерировать ссылку на сообщение'
      )

      return this.getTelegramLink(peer, messageId)
    }
  }

  async getPermanentLink(peer, messageId) {
    try {
      const result = await this.client.invoke(
        new Api.channels.ExportMessageLink({ channel: peer, id: messageId, grouped: false })
      )
      return result?.link || null
    } catch {
      return null
    }
  }

  getSupergroupLink(peer, messageId) {
    const channelId = peer.id.toString().replace(linkConfig.supergroupIdPrefix, '')
    return `${linkConfig.telegramMeBase}/c/${channelId}/${messageId}`
  }

  getTelegramLink(peer, messageId) {
    return `${linkConfig.telegramProtocolPrefix}?chat_id=${peer.id}&message_id=${messageId}`
  }

  getTelegramMeLink(peer, messageId) {
    const username = peer.username || `c/${peer.id.toString().replace('-100', '')}`
    return `${linkConfig.telegramMeBase}/${username}/${messageId}`
  }

  isSupergroup(peer) {
    if (!peer || !peer.id) return false
    return peer.id.toString().startsWith(linkConfig.supergroupIdPrefix)
  }

  isChannel(peer) {
    if (!peer || !peer.id) return false
    const id = peer.id.toString()
    return (
      id.startsWith(linkConfig.channelIdPrefix) && !id.startsWith(linkConfig.supergroupIdPrefix)
    )
  }

  getPeerType(peer) {
    if (!peer || !peer.id) return 'unknown'
    if (this.isSupergroup(peer)) return 'supergroup'
    if (this.isChannel(peer)) return 'channel'
    if (peer.className === 'User') return 'user'
    if (peer.className === 'Chat') return 'group'
    return 'unknown'
  }

  getPeerDisplayName(peer) {
    if (!peer) return 'Unknown'
    if (peer.username) return `@${peer.username}`
    if (peer.title) return peer.title
    if (peer.firstName) return peer.firstName
    return `Chat ${peer.id}`
  }
}

export function createMessageLinkGenerator(client) {
  return new MessageLinkGenerator(client)
}
