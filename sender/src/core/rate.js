import { delay, getTimestamp } from './sender-time.js'
import { createRateLogger, logDebug, logWarning, logInfo } from './sender-logger.js'

const rateConfig = {
  defaultMaxMessages: 3,
  defaultIntervalMs: [60000, 120000],
  defaultBurstPauseMs: 900000,
  autoResetThresholdMs: 300000,
  maxWaitPerCycleMs: 5000,
  firstMessageWaitMs: 100,
  minWaitMs: 1000
}

export class RateLimiter {
  constructor(config, rootLogger) {
    this.config = config
    this.rootLogger = rootLogger

    this.maxMessages = config.maxMessages || rateConfig.defaultMaxMessages
    const [minInterval, maxInterval] = config.messageIntervalMs || rateConfig.defaultIntervalMs
    this.messageIntervalMs = minInterval + Math.random() * (maxInterval - minInterval)
    this.burstPauseMs = config.burstPauseMs || rateConfig.defaultBurstPauseMs

    this.sentMessages = []
    this.lastSentTime = 0
    this.burstStartTime = 0
    this.isFirstRun = true

    this.rateLogger = createRateLogger(this.rootLogger)

    logInfo(this.rateLogger, 'Rate limiter инициализирован с новой логикой', {
      maxMessages: this.maxMessages,
      messageIntervalMs: this.messageIntervalMs,
      burstPauseMs: this.burstPauseMs
    })
  }

  cleanupOldSends() {
    const now = getTimestamp(),
      cutoffTime = now - this.burstPauseMs

    this.sentMessages = this.sentMessages.filter((timestamp) => timestamp > cutoffTime)

    if (this.lastSentTime > 0 && now - this.lastSentTime > this.burstPauseMs) {
      logInfo(this.rateLogger, 'Авто-сброс rate limiter после долгой паузы', {
        timeSinceLastSent: now - this.lastSentTime,
        burstPauseMs: this.burstPauseMs
      })
      this.sentMessages = []
      this.burstStartTime = 0
      this.lastSentTime = 0
      this.isFirstRun = true
    }

    if (this.sentMessages.length === 0 && now - this.lastSentTime > rateConfig.autoResetThresholdMs)
      this.isFirstRun = true
  }

  canSendNow() {
    this.cleanupOldSends()
    const now = getTimestamp()

    if (this.isFirstRun && this.sentMessages.length < this.maxMessages) return true
    if (this.sentMessages.length === 0) return true

    const timeSinceLastMessage = now - this.lastSentTime
    if (timeSinceLastMessage < this.messageIntervalMs) return false

    if (this.sentMessages.length >= this.maxMessages) {
      const timeSinceBurstStart = now - this.burstStartTime
      if (timeSinceBurstStart < this.burstPauseMs) return false
      this.sentMessages = []
      this.burstStartTime = 0
      this.lastSentTime = 0
    }

    return true
  }

  tryConsume() {
    if (!this.canSendNow()) return false

    const now = getTimestamp()
    this.sentMessages.push(now)
    this.lastSentTime = now

    if (this.sentMessages.length === 1) this.burstStartTime = now

    if (this.isFirstRun && this.sentMessages.length >= this.maxMessages) {
      this.isFirstRun = false
      logInfo(this.rateLogger, 'Первый запуск завершен, переключение на обычное rate limiting', {
        sentMessages: this.sentMessages.length,
        maxMessages: this.maxMessages
      })
    }

    logDebug(this.rateLogger, 'Токен сообщения использован', {
      sentInBurst: this.sentMessages.length,
      maxMessages: this.maxMessages,
      timeSinceLastMessage: now - this.lastSentTime
    })

    return true
  }

  async waitForToken(timeoutMs = 60000) {
    const startTime = getTimestamp()

    while (getTimestamp() - startTime < timeoutMs) {
      if (this.tryConsume()) return true

      const now = getTimestamp()
      let waitTime

      if (this.sentMessages.length === 0) waitTime = rateConfig.firstMessageWaitMs
      else if (this.sentMessages.length < this.maxMessages) {
        const timeSinceLastMessage = now - this.lastSentTime
        waitTime = Math.max(rateConfig.minWaitMs, this.messageIntervalMs - timeSinceLastMessage)
      } else {
        const timeSinceBurstStart = now - this.burstStartTime
        waitTime = Math.max(rateConfig.minWaitMs, this.burstPauseMs - timeSinceBurstStart)
      }

      logDebug(this.rateLogger, 'Ожидание rate limit', {
        waitTimeMs: waitTime,
        sentInBurst: this.sentMessages.length,
        maxMessages: this.maxMessages,
        timeoutRemainingMs: timeoutMs - (getTimestamp() - startTime)
      })

      await delay(Math.min(waitTime, rateConfig.maxWaitPerCycleMs))
    }

    logWarning(this.rateLogger, 'Таймаут ожидания токена rate limit', {
      timeoutMs,
      waitedMs: getTimestamp() - startTime
    })
    return false
  }

  getAvailableTokens() {
    this.cleanupOldSends()
    return this.sentMessages.length < this.maxMessages ? 1 : 0
  }

  getStats() {
    this.cleanupOldSends()

    const now = getTimestamp()
    let timeToNextToken = 0

    if (this.sentMessages.length === 0) timeToNextToken = 0
    else if (this.sentMessages.length < this.maxMessages) {
      const timeSinceLastMessage = now - this.lastSentTime
      timeToNextToken = Math.max(0, this.messageIntervalMs - timeSinceLastMessage)
    } else {
      const timeSinceBurstStart = now - this.burstStartTime
      timeToNextToken = Math.max(0, this.burstPauseMs - timeSinceBurstStart)
    }

    return {
      availableTokens: this.getAvailableTokens(),
      sentInBurst: this.sentMessages.length,
      maxMessages: this.maxMessages,
      timeToNextToken,
      messageIntervalMs: this.messageIntervalMs,
      burstPauseMs: this.burstPauseMs,
      isFirstRun: this.isFirstRun
    }
  }
}

export function createRateLimiter(config, rootLogger) {
  return new RateLimiter(config, rootLogger)
}

export async function jitterDelay(minMs, maxMs) {
  const random = Math.random(),
    delayMs = Math.floor(random * (maxMs - minMs + 1)) + minMs
  await delay(delayMs)
}

export async function configJitterDelay(config) {
  const [minMs, maxMs] = config.messageIntervalMs || rateConfig.defaultIntervalMs
  await jitterDelay(minMs, maxMs)
}
