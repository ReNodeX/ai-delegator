import { logTelegramSend } from '../core/logger.js'

const sendConfig = {
  maxMessageLength: 4096,
  maxRetryAttempts: 3,
  retryDelayMs: 1000,
  truncationBuffer: 3,
  minTruncationRatio: 0.8,
  ellipsis: '…'
}

const htmlEscapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' },
  RETRIABLE_ERRORS = ['FLOOD_WAIT', 'TIMEOUT', 'NETWORK_ERROR', 'CONNECTION_LOST']

export class MessageSender {
  constructor(client, targetGroupId, rateLimiter) {
    if (!client) throw new Error('Telegram клиент обязателен')
    if (!targetGroupId) throw new Error('ID целевой группы обязателен')
    if (!rateLimiter) throw new Error('Rate limiter обязателен')

    this.client = client
    this.targetGroupId = targetGroupId
    this.rateLimiter = rateLimiter
    this.stats = { sentCount: 0, errorCount: 0, retryCount: 0, startTime: Date.now() }

    logTelegramSend.info(
      { targetGroupId: this.targetGroupId, maxMessageLength: sendConfig.maxMessageLength },
      'отправитель сообщений в целевую группу инициализирован'
    )
  }

  async sendMessage(htmlContent, options = {}) {
    const startTime = performance.now()

    if (!htmlContent || typeof htmlContent !== 'string')
      throw new Error('HTML контент обязателен и должен быть строкой')

    try {
      await this.rateLimiter.acquire()

      let finalContent = htmlContent
      if (htmlContent.length > sendConfig.maxMessageLength) {
        logTelegramSend.warn(
          { originalLength: htmlContent.length },
          'сообщение слишком длинное, обрезаем'
        )
        finalContent = this.truncateHtml(htmlContent, sendConfig.maxMessageLength)
      }

      const result = await this.client.sendMessage(this.targetGroupId, {
        message: finalContent,
        parseMode: 'html',
        ...options
      })

      this.stats.sentCount++

      const durationMs = Math.round(performance.now() - startTime)
      logTelegramSend.info(
        {
          messageId: result.id,
          contentLength: finalContent.length,
          wasTruncated: finalContent.length < htmlContent.length,
          durationMs
        },
        'сообщение отправлено успешно'
      )

      return {
        success: true,
        messageId: result.id,
        contentLength: finalContent.length,
        originalLength: htmlContent.length,
        wasTruncated: finalContent.length < htmlContent.length,
        sentAt: new Date()
      }
    } catch (error) {
      this.stats.errorCount++

      const durationMs = Math.round(performance.now() - startTime)
      logTelegramSend.error(
        { err: error, errorMessage: error.message, contentLength: htmlContent.length, durationMs },
        'не удалось отправить сообщение'
      )

      return {
        success: false,
        error: error.message,
        errorCode: error.code,
        contentLength: htmlContent.length,
        retriable: this.isRetriableError(error),
        sentAt: new Date()
      }
    }
  }

  truncateHtml(html, maxLength) {
    if (!html || typeof html !== 'string') return ''
    if (html.length <= maxLength) return html

    let cutPoint = maxLength - sendConfig.truncationBuffer

    while (cutPoint > 0 && html[cutPoint] !== ' ' && html[cutPoint] !== '>') cutPoint--

    if (cutPoint < maxLength * sendConfig.minTruncationRatio)
      cutPoint = maxLength - sendConfig.truncationBuffer

    const truncated = html.substring(0, cutPoint).trim() + sendConfig.ellipsis,
      openTags = (truncated.match(/<[^/][^>]*>/g) || []).length,
      closeTags = (truncated.match(/<\/[^>]*>/g) || []).length,
      unclosedTags = openTags - closeTags

    let result = truncated
    for (let i = 0; i < unclosedTags; i++) result += '…'

    return result + '…'
  }

  async sendLead(leadData) {
    const startTime = performance.now()

    if (!leadData || typeof leadData !== 'object') throw new Error('Данные лида обязательны')

    const { messageText, messageDate, messageLink, requestTime, hashtags } = leadData
    if (!messageText || !messageDate || !messageLink || !requestTime)
      throw new Error('Отсутствуют обязательные поля данных лида')

    const htmlContent = this.buildLeadHtml({
        messageText,
        messageDate,
        messageLink,
        requestTime,
        hashtags: hashtags || []
      }),
      result = await this.sendMessage(htmlContent),
      durationMs = Math.round(performance.now() - startTime)

    if (result.success)
      logTelegramSend.info(
        { leadId: leadData.id, messageId: result.messageId, durationMs },
        'лид отправлен успешно'
      )
    else
      logTelegramSend.error(
        { leadId: leadData.id, error: result.error, durationMs },
        'не удалось отправить лид'
      )

    return result
  }

  buildLeadHtml(data) {
    const { messageText, messageDate, messageLink, requestTime, hashtags } = data

    if (!messageText || !messageDate || !messageLink || !requestTime)
      return '<b>Ошибка:</b> Неполные данные заявки'

    const escapedText = this.escapeHtml(messageText),
      hashtagString = Array.isArray(hashtags) ? hashtags.join(' ') : ''

    return `<b>Новая заявка!</b>

Описание сообщения:
- Время заявки: <i>${requestTime}</i>
- Дата сообщения: <i>${messageDate}</i>
- Ссылка: <a href="${messageLink}">открыть сообщение</a>

Описание запроса:
> ${escapedText}

Просьба отписать!
${hashtagString}`
  }

  escapeHtml(text) {
    if (!text || typeof text !== 'string') return ''
    return text.replace(/[&<>"']/g, (char) => htmlEscapes[char])
  }

  isRetriableError(error) {
    if (!error || !error.message) return false
    return RETRIABLE_ERRORS.some((e) => error.message.includes(e))
  }

  getStats() {
    const { sentCount, errorCount, startTime } = this.stats,
      total = sentCount + errorCount,
      duration = Date.now() - startTime

    return {
      sentCount,
      errorCount,
      retryCount: this.stats.retryCount,
      successRate: total > 0 ? Math.round((sentCount / total) * 100) : 0,
      avgMessagesPerMinute:
        duration > 0 ? Math.round((sentCount / (duration / 60000)) * 100) / 100 : 0,
      duration,
      lastSentTime: this.stats.lastSentTime
    }
  }

  resetStats() {
    this.stats = {
      sentCount: 0,
      errorCount: 0,
      retryCount: 0,
      startTime: Date.now(),
      lastSentTime: null
    }
    logTelegramSend.info('статистика отправителя сообщений сброшена')
  }
}

export function createMessageSender(client, targetGroupId, rateLimiter) {
  return new MessageSender(client, targetGroupId, rateLimiter)
}
