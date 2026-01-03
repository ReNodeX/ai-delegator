import { logTelegramUpdates } from '../core/logger.js'

const updatesConfig = {
  defaultDebounceMs: 300,
  maxDebounceMs: 5000,
  maxQueueSize: 1000,
  minDebounceMs: 100,
  debounceRatio: 0.8
}

export class UpdatesHandler {
  static create(client, messageProcessor, rateLimiter) {
    return new UpdatesHandler(client, messageProcessor, rateLimiter)
  }

  constructor(client, messageProcessor, rateLimiter) {
    if (!client) throw new Error('Telegram клиент обязателен')
    if (!messageProcessor) throw new Error('Обработчик сообщений обязателен')
    if (!rateLimiter) throw new Error('Rate limiter обязателен')

    this.client = client
    this.messageProcessor = messageProcessor
    this.rateLimiter = rateLimiter
    this.isListening = false
    this.sourcePeers = new Set()
    this.debounceQueue = new Map()
    this.debounceTimeout = null
    this.stats = {
      messagesReceived: 0,
      messagesProcessed: 0,
      messagesSkipped: 0,
      messagesErrored: 0,
      startTime: null
    }

    logTelegramUpdates.info('обработчик live-обновлений от Telegram инициализирован')
  }

  async startListening(sources, debounceMs = updatesConfig.defaultDebounceMs) {
    const startTime = performance.now()

    if (!Array.isArray(sources) || sources.length === 0)
      throw new Error('Массив источников обязателен и не должен быть пустым')

    if (this.isListening) {
      logTelegramUpdates.warn('уже слушаем обновления')
      return
    }

    try {
      const normalizedDebounceMs = Math.min(
        Math.max(debounceMs, updatesConfig.minDebounceMs),
        updatesConfig.maxDebounceMs
      )

      this.stats = {
        messagesReceived: 0,
        messagesProcessed: 0,
        messagesSkipped: 0,
        messagesErrored: 0,
        startTime: Date.now()
      }

      const resolvedPeers = []
      for (const source of sources) {
        try {
          const peer = await this.client.getEntity(source.username || source.id)
          this.sourcePeers.add(peer.id.toString())
          resolvedPeers.push({
            id: peer.id.toString(),
            username: source.username,
            type: source.type,
            className: peer.className
          })
        } catch (error) {
          logTelegramUpdates.error({ err: error, source }, 'не удалось разрешить source peer')
          throw error
        }
      }

      this.boundHandleNewMessage = this.handleNewMessage.bind(this)
      this.boundHandleEditedMessage = this.handleEditedMessage.bind(this)

      this.client.addEventHandler(this.boundHandleNewMessage, {
        chats: Array.from(this.sourcePeers)
      })
      this.client.addEventHandler(this.boundHandleEditedMessage, {
        chats: Array.from(this.sourcePeers)
      })

      this.isListening = true
      this.debounceMs = normalizedDebounceMs

      const durationMs = Math.round(performance.now() - startTime)
      logTelegramUpdates.info(
        {
          sourcesCount: sources.length,
          resolvedPeersCount: resolvedPeers.length,
          debounceMs: normalizedDebounceMs,
          durationMs
        },
        'начато прослушивание live-обновлений'
      )
    } catch (error) {
      const durationMs = Math.round(performance.now() - startTime)
      logTelegramUpdates.error(
        { err: error, sourcesCount: sources.length, durationMs },
        'не удалось начать прослушивание'
      )
      throw error
    }
  }

  stopListening() {
    if (!this.isListening) return

    try {
      if (this.boundHandleNewMessage) {
        this.client.removeEventHandler(this.boundHandleNewMessage)
        this.boundHandleNewMessage = null
      }
      if (this.boundHandleEditedMessage) {
        this.client.removeEventHandler(this.boundHandleEditedMessage)
        this.boundHandleEditedMessage = null
      }

      this.isListening = false
      this.sourcePeers.clear()
      this.debounceQueue.clear()

      if (this.debounceTimeout) {
        clearTimeout(this.debounceTimeout)
        this.debounceTimeout = null
      }

      const { messagesReceived, startTime } = this.stats,
        duration = startTime ? Date.now() - startTime : 0

      logTelegramUpdates.info(
        {
          messagesReceived,
          messagesProcessed: this.stats.messagesProcessed,
          messagesSkipped: this.stats.messagesSkipped,
          messagesErrored: this.stats.messagesErrored,
          duration
        },
        'прослушивание обновлений остановлено'
      )
    } catch (error) {
      logTelegramUpdates.error({ err: error }, 'ошибка при остановке обновлений')
    }
  }

  async handleNewMessage(event) {
    try {
      const message = event?.message
      if (!message) return

      const peerId = message.peerId?.toString()
      if (!peerId || !this.sourcePeers.has(peerId)) return

      this.stats.messagesReceived++
      this.addToDebounceQueue(message, 'new')
    } catch (error) {
      this.stats.messagesErrored++
      logTelegramUpdates.error(
        { err: error, messageId: event?.message?.id },
        'ошибка обработки нового сообщения'
      )
    }
  }

  async handleEditedMessage(event) {
    try {
      const message = event?.message
      if (!message) return

      const peerId = message.peerId?.toString()
      if (!peerId || !this.sourcePeers.has(peerId)) return

      this.stats.messagesReceived++
      this.addToDebounceQueue(message, 'edited')
    } catch (error) {
      this.stats.messagesErrored++
      logTelegramUpdates.error(
        { err: error, messageId: event?.message?.id },
        'ошибка обработки редактированного сообщения'
      )
    }
  }

  addToDebounceQueue(message, type) {
    if (!message || !message.peerId || !message.id) return
    if (this.debounceQueue.size >= updatesConfig.maxQueueSize) {
      logTelegramUpdates.warn({ queueSize: this.debounceQueue.size }, 'очередь debounce заполнена')
      return
    }

    const messageKey = `${message.peerId.toString()}_${message.id}`
    this.debounceQueue.set(messageKey, { message, type, timestamp: Date.now() })

    if (this.debounceTimeout) clearTimeout(this.debounceTimeout)
    this.debounceTimeout = setTimeout(() => this.processDebounceQueue(), this.debounceMs)
  }

  async processDebounceQueue() {
    if (this.debounceQueue.size === 0) return

    const messages = Array.from(this.debounceQueue.values())
    this.debounceQueue.clear()
    this.debounceTimeout = null

    const promises = messages.map(async ({ message, type }) => {
      try {
        await this.rateLimiter.acquire()
        const result = await this.messageProcessor.processMessage(message, type)

        if (result === 'processed') this.stats.messagesProcessed++
        else if (result === 'skipped') this.stats.messagesSkipped++
        else this.stats.messagesErrored++
      } catch (error) {
        this.stats.messagesErrored++
        logTelegramUpdates.error(
          { err: error, messageId: message.id },
          'ошибка обработки сообщения из очереди'
        )
      }
    })

    await Promise.allSettled(promises)

    logTelegramUpdates.info(
      { processedCount: messages.length, totalProcessed: this.stats.messagesProcessed },
      'обработка очереди debounce завершена'
    )
  }

  isCurrentlyListening() {
    return this.isListening
  }

  getQueueSize() {
    return this.debounceQueue.size
  }

  getStats() {
    const { messagesReceived, messagesProcessed, messagesSkipped, messagesErrored, startTime } =
      this.stats

    return {
      messagesReceived,
      messagesProcessed,
      messagesSkipped,
      messagesErrored,
      startTime,
      isListening: this.isListening,
      queueSize: this.debounceQueue.size,
      sourcePeersCount: this.sourcePeers.size,
      debounceMs: this.debounceMs
    }
  }
}

export function createUpdatesHandler(client, messageProcessor, rateLimiter) {
  return new UpdatesHandler(client, messageProcessor, rateLimiter)
}
