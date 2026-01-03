import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { logTelegramClient } from '../core/logger.js'

const clientConfig = {
  connectionRetries: 3,
  timeout: 30000,
  retryDelay: 5000,
  useWSS: false,
  floodSleepThreshold: 60,
  autoReconnect: false,
  maxConcurrentDownloads: 1
}

const reconnectConfig = {
  maxAttempts: 3,
  initialDelayMs: 10000,
  maxDelayMs: 120000,
  backoffMultiplier: 2.0,
  connectionTimeoutMs: 60000
}

const RETRIABLE_ERRORS = [
    'CONNECTION_LOST',
    'TIMEOUT',
    'FLOOD_WAIT',
    'NETWORK_ERROR',
    'CONNECTION_RESET',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ECONNREFUSED'
  ],
  AUTH_ERRORS = [
    'AUTH_KEY_UNREGISTERED',
    'AUTH_KEY_INVALID',
    'SESSION_PASSWORD_NEEDED',
    'USER_DEACTIVATED',
    'USER_DEACTIVATED_BAN',
    'PHONE_NUMBER_INVALID',
    'PHONE_CODE_INVALID',
    'PHONE_CODE_EXPIRED',
    'SESSION_REVOKED',
    'SESSION_EXPIRED'
  ]

export class TelegramClientWrapper {
  constructor(apiId, apiHash, sessionString = null) {
    if (!apiId || !apiHash) throw new Error('API ID и API Hash обязательны')
    if (typeof apiId !== 'number' || apiId <= 0)
      throw new Error('API ID должен быть положительным числом')
    if (typeof apiHash !== 'string' || apiHash.length < 20)
      throw new Error('API Hash должен быть валидной строкой')
    if (sessionString && (typeof sessionString !== 'string' || sessionString.length < 10))
      throw new Error('Session string должен быть валидной строкой')

    this.apiId = apiId
    this.apiHash = apiHash
    this.sessionString = sessionString
    this.client = null
    this.isConnected = false
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = reconnectConfig.maxAttempts
    this.reconnectDelay = reconnectConfig.initialDelayMs
    this.userInfo = null

    logTelegramClient.info(
      { apiId, hasSession: !!sessionString, maxReconnectAttempts: this.maxReconnectAttempts },
      'обертка Telegram клиента инициализирована'
    )
  }

  async connect() {
    const startTime = performance.now()

    try {
      const session = this.sessionString
        ? new StringSession(this.sessionString)
        : new StringSession('')
      this.client = new TelegramClient(session, this.apiId, this.apiHash, clientConfig)

      logTelegramClient.info('попытка подключения к Telegram API...')
      await this.attemptConnection()
      logTelegramClient.info('подключено к Telegram API, проверка авторизации...')

      try {
        const isAuthorized = await Promise.race([
          this.client.checkAuthorization(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Таймаут проверки авторизации')), 30000)
          )
        ])

        if (!isAuthorized) {
          logTelegramClient.error('не авторизован - критическая ошибка')
          throw new Error('Telegram клиент не авторизован')
        }
        logTelegramClient.info('проверка авторизации пройдена')
      } catch (error) {
        logTelegramClient.error({ errorMessage: error.message }, 'проверка авторизации не удалась')
        throw new Error(`Ошибка авторизации: ${error.message}`)
      }

      this.isConnected = true
      this.reconnectAttempts = 0
      this.reconnectDelay = reconnectConfig.initialDelayMs

      try {
        this.userInfo = await Promise.race([
          this.client.getMe(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Таймаут получения информации о пользователе')),
              20000
            )
          )
        ])

        logTelegramClient.info(
          {
            userId: this.userInfo?.id,
            username: this.userInfo?.username,
            firstName: this.userInfo?.firstName
          },
          'информация о пользователе получена'
        )
      } catch (error) {
        logTelegramClient.error(
          { errorMessage: error.message },
          'не удалось получить информацию о пользователе'
        )
        throw new Error(`Не удалось получить информацию о пользователе: ${error.message}`)
      }

      const durationMs = Math.round(performance.now() - startTime)
      logTelegramClient.info(
        { userId: this.userInfo?.id, username: this.userInfo?.username, durationMs },
        'успешное подключение к Telegram API'
      )
    } catch (error) {
      const durationMs = Math.round(performance.now() - startTime)
      logTelegramClient.error(
        { err: error, errorMessage: error.message, durationMs },
        'ошибка подключения к Telegram API'
      )
      throw error
    }
  }

  async attemptConnection() {
    const strategies = [
      () =>
        Promise.race([
          this.client.connect(),
          new Promise((_, r) => setTimeout(() => r(new Error('Быстрый таймаут')), 15000))
        ]),
      () =>
        Promise.race([
          this.client.connect(),
          new Promise((_, r) => setTimeout(() => r(new Error('Средний таймаут')), 30000))
        ]),
      () =>
        Promise.race([
          this.client.connect(),
          new Promise((_, r) =>
            setTimeout(() => r(new Error('Долгий таймаут')), reconnectConfig.connectionTimeoutMs)
          )
        ])
    ]

    let lastError = null

    for (let i = 0; i < strategies.length; i++) {
      try {
        logTelegramClient.info(`попытка стратегии подключения ${i + 1}...`)
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1000))
        await strategies[i]()
        logTelegramClient.info(`стратегия подключения ${i + 1} успешна`)
        return
      } catch (error) {
        lastError = error
        logTelegramClient.warn(
          { strategy: i + 1, errorMessage: error.message },
          `стратегия подключения ${i + 1} не удалась`
        )
        if (!error.message.includes('таймаут') && i < strategies.length - 1)
          await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }

    throw lastError || new Error('Все стратегии подключения не удались')
  }

  async disconnect() {
    if (!this.client || !this.isConnected) {
      logTelegramClient.debug('клиент не подключен, нечего отключать')
      return
    }

    try {
      await this.client.disconnect()
      this.isConnected = false
      this.userInfo = null
      logTelegramClient.info('отключен от telegram')
    } catch (error) {
      logTelegramClient.error({ err: error, errorMessage: error.message }, 'ошибка при отключении')
    }
  }

  async reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logTelegramClient.error(
        { reconnectAttempts: this.reconnectAttempts },
        'достигнуто максимальное количество попыток переподключения'
      )
      throw new Error('Достигнуто максимальное количество попыток переподключения')
    }

    this.reconnectAttempts++
    this.isConnected = false

    logTelegramClient.warn(
      {
        attempt: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts,
        delayMs: this.reconnectDelay
      },
      'попытка переподключения'
    )

    await new Promise((resolve) => setTimeout(resolve, this.reconnectDelay))
    this.reconnectDelay = Math.min(
      this.reconnectDelay * reconnectConfig.backoffMultiplier,
      reconnectConfig.maxDelayMs
    )

    try {
      await this.connect()
      logTelegramClient.info({ attempt: this.reconnectAttempts }, 'переподключение успешно')
    } catch (error) {
      logTelegramClient.error(
        { err: error, attempt: this.reconnectAttempts },
        'переподключение не удалось'
      )
      throw error
    }
  }

  getClient() {
    if (!this.client || !this.isConnected) throw new Error('Клиент не подключен')
    return this.client
  }

  getSessionString() {
    if (!this.client) throw new Error('Клиент не инициализирован')
    return this.client.session.save()
  }

  isClientConnected() {
    return this.isConnected && this.client && this.client.connected
  }

  shouldReconnect(error) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return false
    if (AUTH_ERRORS.some((e) => error.message.includes(e))) return false
    return RETRIABLE_ERRORS.some((e) => error.message.includes(e))
  }

  getUserInfo() {
    return this.userInfo
  }

  async handleConnectionError(error) {
    logTelegramClient.error(
      { err: error, errorMessage: error.message },
      'обнаружена ошибка соединения'
    )
    if (!this.shouldReconnect(error)) throw error
    if (!this.isClientConnected()) throw error

    try {
      await this.reconnect()
    } catch (reconnectError) {
      logTelegramClient.error({ err: reconnectError }, 'не удалось переподключиться после ошибки')
      throw reconnectError
    }
  }

  async executeWithReconnect(fn) {
    if (typeof fn !== 'function') throw new Error('Параметр функции обязателен')

    try {
      return await fn(this.getClient())
    } catch (error) {
      if (!this.shouldReconnect(error)) throw error
      logTelegramClient.warn(
        { errorMessage: error.message },
        'обнаружена повторяемая ошибка, попытка переподключения'
      )
      await this.handleConnectionError(error)
      return await fn(this.getClient())
    }
  }

  disableReconnection() {
    this.maxReconnectAttempts = 0
    logTelegramClient.info('попытки переподключения отключены')
  }

  enableReconnection(maxAttempts = 3) {
    this.maxReconnectAttempts = maxAttempts
    this.reconnectAttempts = 0
    logTelegramClient.info({ maxAttempts }, 'попытки переподключения включены')
  }

  getStats() {
    return {
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      reconnectDelay: this.reconnectDelay,
      hasUserInfo: Boolean(this.userInfo),
      userId: this.userInfo?.id,
      reconnectionEnabled: this.maxReconnectAttempts > 0
    }
  }
}

export function createTelegramClient(apiId, apiHash, sessionString = null) {
  return new TelegramClientWrapper(apiId, apiHash, sessionString)
}
