import { timeManager } from '../core/time.js'
import { logFormat } from '../core/logger.js'

const formatterConfig = {
  defaultHashtags: {
    exact: ['#заказ', '#новый заказ'],
    normalized: ['#заказ', '#новый_заказ'],
    useNormalized: false
  },
  truncationBuffer: 3,
  minTruncationRatio: 0.8,
  defaultLogLen: 200,
  ellipsis: '...'
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export class MessageFormatter {
  constructor(config) {
    if (!config) throw new Error('Конфигурация обязательна')
    this.config = config
    this.hashtags = config.hashtags || formatterConfig.defaultHashtags
  }

  formatLeadMessage(leadData) {
    if (!leadData || typeof leadData !== 'object') throw new Error('Данные лида обязательны')

    const { messageText, messageDate, messageLink, peerName = 'Unknown source' } = leadData,
      now = timeManager.now(),
      requestTime = timeManager.formatTime(now),
      formattedDate = timeManager.formatDate(messageDate),
      escapedText = this.escapeHtml(messageText),
      hashtagString = this.getHashtags()

    const htmlMessage = `<b>Новая заявка!</b>

Описание сообщения:
- Время заявки: <i>${requestTime}</i>
- Дата сообщения: <i>${formattedDate}</i>
- Ссылка: <a href="${messageLink}">открыть сообщение</a>

Описание запроса:
> ${escapedText}

Просьба отписать!
${hashtagString}`

    logFormat.debug(
      {
        messageLength: htmlMessage.length,
        originalLength: messageText.length,
        hashtags: this.hashtags.useNormalized ? this.hashtags.normalized : this.hashtags.exact
      },
      'сообщение лида отформатировано'
    )

    return htmlMessage
  }

  getHashtags() {
    const { useNormalized, normalized, exact } = this.hashtags
    return (useNormalized ? normalized : exact).join(' ')
  }

  escapeHtml(text) {
    if (typeof text !== 'string') return ''
    return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char])
  }

  truncateText(text, maxLength) {
    if (text.length <= maxLength) return text

    let cutPoint = maxLength - formatterConfig.truncationBuffer
    const sentenceEndings = ['.', '!', '?']

    while (cutPoint > 0 && !sentenceEndings.includes(text[cutPoint])) cutPoint--

    if (cutPoint < maxLength * formatterConfig.minTruncationRatio) {
      cutPoint = maxLength - formatterConfig.truncationBuffer
      while (cutPoint > 0 && text[cutPoint] !== ' ') cutPoint--
    }

    if (cutPoint < maxLength * formatterConfig.minTruncationRatio)
      cutPoint = maxLength - formatterConfig.truncationBuffer

    return text.substring(0, cutPoint).trim() + formatterConfig.ellipsis
  }

  formatForLogging(text, maxLength = formatterConfig.defaultLogLen) {
    if (!text || typeof text !== 'string') return '[Нет текста]'
    return this.truncateText(text, maxLength).replace(/\s+/g, ' ').trim()
  }

  extractMessageText(message) {
    if (!message || typeof message !== 'object') return null
    const text = message.text || message.caption || null
    if (!text) return null
    if (text.includes('Новая заявка!') && text.includes('Описание сообщения:')) return null
    return text
  }

  hasTextContent(message) {
    return this.extractMessageText(message) !== null
  }

  formatPeerName(peer) {
    if (!peer || typeof peer !== 'object') return 'Unknown peer'
    if (peer.username) return `@${peer.username}`
    if (peer.title) return peer.title
    return `Chat ${peer.id}`
  }

  getConfig() {
    return { hashtags: this.hashtags }
  }
}

export function createMessageFormatter(config) {
  return new MessageFormatter(config)
}
