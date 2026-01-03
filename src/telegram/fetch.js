import { logTelegramFetch } from '../core/logger.js'
import { timeManager } from '../core/time.js'

const fetchConfig = {
  defaultLimit: 100,
  maxLimit: 200,
  floodWaitRetryDelayMs: 1000,
  batchDelayMs: 100,
  floodWaitMultiplier: 1000
}

export class MessageFetcher {
  constructor(client, rateLimiter) {
    if (!client) throw new Error('Telegram клиент обязателен')
    if (!rateLimiter) throw new Error('Rate limiter обязателен')

    this.client = client
    this.rateLimiter = rateLimiter

    logTelegramFetch.info(
      { fetchLimit: fetchConfig.defaultLimit, maxLimit: fetchConfig.maxLimit },
      'загрузчик истории сообщений инициализирован'
    )
  }

  async resolvePeer(source) {
    if (!source || typeof source !== 'object') throw new Error('Неверная конфигурация источника')

    const startTime = performance.now()

    try {
      let peer
      if (source.username) peer = await this.client.getEntity(source.username)
      else if (source.id) peer = await this.client.getEntity(source.id)
      else throw new Error('Источник должен иметь username или id')

      const durationMs = Math.round(performance.now() - startTime)
      logTelegramFetch.info(
        { type: source.type, username: source.username, id: peer.id.toString(), durationMs },
        'peer разрешен успешно'
      )

      return peer
    } catch (error) {
      const durationMs = Math.round(performance.now() - startTime)
      logTelegramFetch.error({ err: error, source, durationMs }, 'не удалось разрешить peer')
      throw error
    }
  }

  async fetchHistory(peer, cutoffTime, onMessage, onProgress) {
    if (!peer || !cutoffTime || typeof onMessage !== 'function')
      throw new Error('Неверные параметры для fetchHistory')

    const startTime = performance.now(),
      stats = {
        totalMessages: 0,
        processedMessages: 0,
        skippedMessages: 0,
        errorMessages: 0,
        startTime: Date.now(),
        batchCount: 0,
        floodWaitCount: 0
      }

    try {
      logTelegramFetch.info(
        {
          peer: peer.username || peer.id.toString(),
          peerId: peer.id.toString(),
          cutoffTime: cutoffTime.format('YYYY-MM-DD HH:mm:ss')
        },
        'начало загрузки истории'
      )

      let offsetId = 0,
        hasMore = true

      while (hasMore) {
        await this.rateLimiter.add(() => Promise.resolve())

        try {
          const messages = await this.client.getMessages(peer, {
            limit: fetchConfig.defaultLimit,
            offsetId,
            minId: 0,
            maxId: 0
          })

          if (!messages || messages.length === 0) {
            hasMore = false
            break
          }

          stats.batchCount++
          stats.totalMessages += messages.length

          for (const message of messages) {
            try {
              if (!timeManager.isAfterCutoff(message.date, cutoffTime)) {
                hasMore = false
                break
              }

              const result = await onMessage(message, peer)
              if (result === 'processed') stats.processedMessages++
              else if (result === 'skipped') stats.skippedMessages++
            } catch (error) {
              logTelegramFetch.error(
                { err: error, messageId: message.id },
                'ошибка обработки сообщения'
              )
              stats.errorMessages++
            }
          }

          offsetId = messages[messages.length - 1].id

          if (typeof onProgress === 'function') {
            try {
              onProgress({
                batchCount: stats.batchCount,
                totalMessages: stats.totalMessages,
                processedMessages: stats.processedMessages,
                skippedMessages: stats.skippedMessages,
                errorMessages: stats.errorMessages
              })
            } catch (progressError) {
              logTelegramFetch.warn({ err: progressError }, 'ошибка в колбеке прогресса')
            }
          }

          await new Promise((resolve) => setTimeout(resolve, fetchConfig.batchDelayMs))
        } catch (error) {
          if (error.message.includes('FLOOD_WAIT')) {
            const waitTimeMatch = error.message.match(/\d+/),
              waitTime = waitTimeMatch ? parseInt(waitTimeMatch[0], 10) : 1

            stats.floodWaitCount++
            logTelegramFetch.warn(
              { waitTimeSeconds: waitTime, floodWaitCount: stats.floodWaitCount },
              'обнаружен flood wait'
            )

            await new Promise((resolve) =>
              setTimeout(resolve, waitTime * fetchConfig.floodWaitMultiplier)
            )
            continue
          }

          logTelegramFetch.error(
            { err: error, batchCount: stats.batchCount, offsetId },
            'ошибка загрузки пакета сообщений'
          )
          stats.errorMessages++
          offsetId += fetchConfig.defaultLimit
        }
      }

      const durationMs = Math.round(performance.now() - startTime)
      stats.duration = Date.now() - stats.startTime
      stats.avgMessagesPerSecond =
        stats.totalMessages > 0
          ? Math.round((stats.totalMessages / (stats.duration / 1000)) * 100) / 100
          : 0

      logTelegramFetch.info(
        {
          ...stats,
          peerId: peer.id.toString(),
          successRate:
            stats.totalMessages > 0
              ? Math.round(
                  ((stats.processedMessages + stats.skippedMessages) / stats.totalMessages) * 100
                )
              : 0,
          durationMs
        },
        'загрузка истории завершена'
      )

      return stats
    } catch (error) {
      const durationMs = Math.round(performance.now() - startTime)
      logTelegramFetch.error({ err: error, ...stats, durationMs }, 'не удалось загрузить историю')
      throw error
    }
  }

  getMessageText(message) {
    if (!message || typeof message !== 'object') return null
    return message.text || message.caption || null
  }

  hasTextContent(message) {
    if (!message || typeof message !== 'object') return false
    return this.getMessageText(message) !== null
  }

  getMessageMetadata(message) {
    if (!message || typeof message !== 'object') return { error: 'Неверное сообщение' }
    return {
      id: message.id,
      date: message.date,
      fromId: message.fromId?.toString(),
      peerId: message.peerId?.toString(),
      hasText: Boolean(message.text),
      hasCaption: Boolean(message.caption),
      textLength: message.text?.length || 0,
      captionLength: message.caption?.length || 0,
      className: message.className
    }
  }
}

export function createMessageFetcher(client, rateLimiter) {
  return new MessageFetcher(client, rateLimiter)
}
