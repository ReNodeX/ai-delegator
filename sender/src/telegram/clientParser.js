import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { createTelegramLogger, logError, logInfo, logDebug } from '../core/sender-logger.js'
import { retryWithBackoff } from '../core/util.js'

const clientConfig = {
  connectionRetries: 5,
  retryDelayMs: 1000,
  useWss: true,
  timeoutMs: 30000,
  backoffBaseMs: 1000,
  backoffMaxMs: 8000,
  backoffMaxAttempts: 5
}

export class ParserClient {
  constructor(config, inboxConfig, rootLogger) {
    this.config = config
    this.inboxConfig = inboxConfig
    this.rootLogger = rootLogger
    this.connected = false

    this.parserLogger = createTelegramLogger(rootLogger, 'parser', inboxConfig.peerId)

    const session = new StringSession(config.session)
    this.client = new TelegramClient(session, config.apiId, config.apiHash, {
      connectionRetries: clientConfig.connectionRetries,
      retryDelay: clientConfig.retryDelayMs,
      useWSS: clientConfig.useWss,
      timeout: clientConfig.timeoutMs
    })

    this.client.addEventHandler((update) => this.handleUpdate(update))
  }

  async connect() {
    try {
      logInfo(this.parserLogger, 'Подключение к Telegram', { apiId: this.config.apiId })

      await retryWithBackoff(
        () => this.client.connect(),
        clientConfig.backoffMaxAttempts,
        clientConfig.backoffBaseMs,
        clientConfig.backoffMaxMs
      )

      this.connected = true
      logInfo(this.parserLogger, 'Успешно подключено к Telegram')
    } catch (error) {
      logError(this.parserLogger, error, { operation: 'connect' })
      throw error
    }
  }

  async disconnect() {
    try {
      logInfo(this.parserLogger, 'Отключение от Telegram')

      if (this.connected) {
        await this.client.disconnect()
        this.connected = false
      }

      logInfo(this.parserLogger, 'Отключено от Telegram')
    } catch (error) {
      logError(this.parserLogger, error, { operation: 'disconnect' })
      throw error
    }
  }

  async isConnected() {
    try {
      return this.connected && (await this.client.connected)
    } catch {
      return false
    }
  }

  async getHistoryMessages(limit = 100, offsetId) {
    if (!this.connected) throw new Error('Клиент не подключен')

    try {
      logDebug(this.parserLogger, 'Получение истории сообщений', { limit, offsetId })

      const result = await this.client.getMessages(this.inboxConfig.peerId, {
          limit,
          offsetId: offsetId ? Number(offsetId) : undefined,
          reverse: false
        }),
        messages = []

      for (const message of result) {
        if (message.id && message.text)
          messages.push({
            id: BigInt(message.id),
            peerId: this.inboxConfig.peerId,
            text: message.text,
            date: message.date,
            contacts: []
          })
      }

      logDebug(this.parserLogger, 'История сообщений получена', {
        count: messages.length,
        oldestId: messages.length > 0 ? messages[0].id : null,
        newestId: messages.length > 0 ? messages[messages.length - 1].id : null
      })

      return messages
    } catch (error) {
      if (error.message && error.message.includes('Could not find a matching Constructor ID')) {
        logError(this.parserLogger, 'Ошибка парсинга Telegram API - пропускаем пакет', {
          operation: 'get_history',
          limit,
          offsetId,
          error: error.message
        })
        return []
      }

      logError(this.parserLogger, error, { operation: 'get_history', limit, offsetId })
      throw error
    }
  }

  async subscribeToUpdates(callback) {
    if (!this.connected) throw new Error('Клиент не подключен')

    logInfo(this.parserLogger, 'Подписка на обновления новых сообщений')

    this.client.addEventHandler(async (update) => {
      if (update.className === 'UpdateNewMessage') {
        const message = update.message

        if (message && message.peerId?.channelId === this.inboxConfig.peerId) {
          const parsedMessage = {
            id: message.id,
            peerId: this.inboxConfig.peerId,
            text: message.text || '',
            date: message.date,
            contacts: []
          }

          logDebug(this.parserLogger, 'Получено новое сообщение', {
            messageId: message.id,
            hasText: !!message.text
          })

          callback(parsedMessage)
        }
      }
    })
  }

  async getPeerInfo() {
    if (!this.connected) throw new Error('Клиент не подключен')

    try {
      logDebug(this.parserLogger, 'Получение информации о peer', {
        peerId: this.inboxConfig.peerId
      })

      const entity = await this.client.getEntity(this.inboxConfig.peerId)

      return {
        id: entity.id,
        title: entity.title,
        username: entity.username,
        participantsCount: entity.participantsCount
      }
    } catch (error) {
      logError(this.parserLogger, error, {
        operation: 'get_peer_info',
        peerId: this.inboxConfig.peerId
      })
      return null
    }
  }

  handleUpdate(update) {
    logDebug(this.parserLogger, 'Получено обновление', {
      className: update.className,
      updateId: update.updateId
    })
  }

  async healthCheck() {
    try {
      const connected = await this.isConnected()

      if (connected) {
        await this.client.getMe()
        return true
      }

      return false
    } catch (error) {
      logError(this.parserLogger, error, { operation: 'health_check' })
      return false
    }
  }

  getStats() {
    return {
      connected: this.connected,
      peerId: this.inboxConfig.peerId,
      sessionExists: !!this.config.session
    }
  }
}

export function createParserClient(config, inboxConfig, rootLogger) {
  return new ParserClient(config, inboxConfig, rootLogger)
}
