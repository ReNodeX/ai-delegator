import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import {
  createTelegramLogger,
  logError,
  logInfo,
  logDebug,
  logWarning
} from '../core/sender-logger.js'
import { retryWithBackoff, exponentialBackoff } from '../core/util.js'

const clientConfig = {
  connectionRetries: 5,
  retryDelay: 1000,
  useWss: true,
  timeout: 30000,
  autoReconnect: true,
  reconnectTimeout: 5000,
  maxReconnectAttempts: 5,
  maxSendAttempts: 3
}

export class SendResult {
  constructor(success, messageId, error, floodWaitSeconds) {
    this.success = success
    this.messageId = messageId
    this.error = error
    this.floodWaitSeconds = floodWaitSeconds
  }
}

export class SenderClient {
  constructor(config, rootLogger) {
    this.config = config
    this.rootLogger = rootLogger
    this.connected = false
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = clientConfig.maxReconnectAttempts

    this.senderLogger = createTelegramLogger(rootLogger, 'sender')

    const session = new StringSession(config.session)
    this.client = new TelegramClient(session, config.apiId, config.apiHash, {
      connectionRetries: clientConfig.connectionRetries,
      retryDelay: clientConfig.retryDelay,
      useWSS: clientConfig.useWss,
      timeout: clientConfig.timeout,
      autoReconnect: clientConfig.autoReconnect,
      reconnectTimeout: clientConfig.reconnectTimeout
    })

    this.client.addEventHandler((update) => this.handleUpdate(update))
    this.client.on('error', (error) =>
      logError(this.senderLogger, error, { context: 'client_error' })
    )
  }

  async connect() {
    try {
      logInfo(this.senderLogger, 'Подключение к Telegram', {
        apiId: this.config.apiId,
        attempt: this.reconnectAttempts + 1
      })

      await retryWithBackoff(() => this.client.connect(), 3, 1000, 5000)

      this.connected = true
      this.reconnectAttempts = 0

      logInfo(this.senderLogger, 'Успешно подключено к Telegram')
    } catch (error) {
      this.reconnectAttempts++
      logError(this.senderLogger, error, { operation: 'connect', attempt: this.reconnectAttempts })

      if (this.reconnectAttempts >= this.maxReconnectAttempts)
        throw new Error(`Не удалось подключиться после ${this.maxReconnectAttempts} попыток`)
      throw error
    }
  }

  async disconnect() {
    try {
      logInfo(this.senderLogger, 'Отключение от Telegram')

      if (this.connected) {
        await this.client.disconnect()
        this.connected = false
      }

      logInfo(this.senderLogger, 'Отключено от Telegram')
    } catch (error) {
      logError(this.senderLogger, error, { operation: 'disconnect' })
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

  async sendMessage(username, text, options = {}) {
    if (!this.connected) return new SendResult(false, null, 'Клиент не подключен')

    const startTime = Date.now()
    let attempts = 0

    while (attempts < clientConfig.maxSendAttempts) {
      attempts++

      try {
        logDebug(this.senderLogger, 'Отправка сообщения', {
          username,
          textLength: text.length,
          attempt: attempts
        })

        const result = await this.client.sendMessage(username, {
          message: text,
          parseMode: options.parseMode,
          linkPreview: options.linkPreview ?? false
        })

        logInfo(this.senderLogger, 'Сообщение отправлено успешно', {
          username,
          messageId: result.id,
          durationMs: Date.now() - startTime,
          attempts
        })

        return new SendResult(true, result.id)
      } catch (error) {
        const errorMessage = error.message || 'Неизвестная ошибка'

        logWarning(this.senderLogger, 'Не удалось отправить сообщение', {
          username,
          attempt: attempts,
          durationMs: Date.now() - startTime,
          error: errorMessage
        })

        if (errorMessage.includes('FLOOD_WAIT_')) {
          const floodMatch = errorMessage.match(/FLOOD_WAIT_(\d+)/),
            floodSeconds = floodMatch ? parseInt(floodMatch[1]) : 60

          logWarning(this.senderLogger, 'Rate limit от Telegram', {
            username,
            floodWaitSeconds: floodSeconds
          })

          if (attempts < clientConfig.maxSendAttempts) {
            await new Promise((resolve) =>
              setTimeout(resolve, (floodSeconds + Math.random() * 5) * 1000)
            )
            continue
          }

          return new SendResult(false, null, 'FLOOD_WAIT_EXCEEDED', floodSeconds)
        }

        if (errorMessage.includes('INPUT_USER_DEACTIVATED'))
          return new SendResult(false, null, 'USER_DEACTIVATED')
        if (errorMessage.includes('403') || errorMessage.includes('CHAT_WRITE_FORBIDDEN'))
          return new SendResult(false, null, 'CHAT_WRITE_FORBIDDEN')

        if (attempts === clientConfig.maxSendAttempts)
          return new SendResult(false, null, errorMessage)

        await exponentialBackoff(attempts, 500, 8000)
      }
    }

    return new SendResult(false, null, 'MAX_ATTEMPTS_EXCEEDED')
  }

  async getUserInfo(username) {
    if (!this.connected) throw new Error('Клиент не подключен')

    try {
      logDebug(this.senderLogger, 'Получение информации о пользователе', { username })
      const user = await this.client.getEntity(username)

      return {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        isBot: user.bot
      }
    } catch (error) {
      logError(this.senderLogger, error, { operation: 'get_user_info', username })
      return null
    }
  }

  async userExists(username) {
    return (await this.getUserInfo(username)) !== null
  }

  handleUpdate(update) {
    logDebug(this.senderLogger, 'Получено обновление', {
      className: update.className,
      updateId: update.updateId
    })
  }

  async healthCheck() {
    try {
      if (await this.isConnected()) {
        await this.client.getMe()
        return true
      }
      return false
    } catch (error) {
      logError(this.senderLogger, error, { operation: 'health_check' })
      return false
    }
  }

  getStats() {
    return {
      connected: this.connected,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      sessionExists: !!this.config.session
    }
  }

  async reconnect() {
    logInfo(this.senderLogger, 'Переподключение к Telegram')

    try {
      await this.disconnect()
      await this.connect()
    } catch (error) {
      logError(this.senderLogger, error, { operation: 'reconnect' })
      throw error
    }
  }

  async waitForConnection(timeoutMs = 30000) {
    const startTime = Date.now()

    while (Date.now() - startTime < timeoutMs) {
      if (await this.isConnected()) return true
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    return false
  }
}

export function createSenderClient(config, rootLogger) {
  return new SenderClient(config, rootLogger)
}
