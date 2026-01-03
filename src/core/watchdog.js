import { logWatchdog } from './logger.js'

const watchdogConfig = {
  defaultIntervalMs: 30000,
  defaultTimeoutMs: 120000,
  maxTimeoutMs: 600000,
  minIntervalMs: 1000,
  minTimeoutMs: 5000
}

export class Watchdog {
  constructor(
    intervalMs = watchdogConfig.defaultIntervalMs,
    timeoutMs = watchdogConfig.defaultTimeoutMs
  ) {
    if (typeof intervalMs !== 'number' || intervalMs < watchdogConfig.minIntervalMs) {
      throw new Error(`Неверный intervalMs: должен быть >= ${watchdogConfig.minIntervalMs}`)
    }
    if (typeof timeoutMs !== 'number' || timeoutMs < watchdogConfig.minTimeoutMs) {
      throw new Error(`Неверный timeoutMs: должен быть >= ${watchdogConfig.minTimeoutMs}`)
    }

    this.intervalMs = Math.min(intervalMs, watchdogConfig.defaultIntervalMs)
    this.timeoutMs = Math.min(timeoutMs, watchdogConfig.maxTimeoutMs)
    this.lastHeartbeat = Date.now()
    this.intervalId = null
    this.isRunning = false
    this.onTimeout = null
    this.heartbeatCount = 0
    this.timeoutCount = 0

    logWatchdog.info(
      {
        intervalMs: this.intervalMs,
        timeoutMs: this.timeoutMs
      },
      'система мониторинга инициализирована'
    )
  }

  start(onTimeout) {
    if (this.isRunning) {
      logWatchdog.warn('watchdog уже запущен')
      return
    }
    if (typeof onTimeout !== 'function') {
      logWatchdog.error({ onTimeout }, 'неверный callback таймаута')
      throw new Error('onTimeout должен быть функцией')
    }

    this.onTimeout = onTimeout
    this.isRunning = true
    this.lastHeartbeat = Date.now()
    this.heartbeatCount = 0
    this.timeoutCount = 0

    this.intervalId = setInterval(() => this.check(), this.intervalMs)

    logWatchdog.info(
      {
        intervalMs: this.intervalMs,
        timeoutMs: this.timeoutMs
      },
      'watchdog запущен'
    )
  }

  stop() {
    if (!this.isRunning) {
      logWatchdog.debug('watchdog не запущен')
      return
    }
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.isRunning = false
    logWatchdog.info(
      {
        totalHeartbeats: this.heartbeatCount,
        totalTimeouts: this.timeoutCount
      },
      'watchdog остановлен'
    )
  }

  heartbeat() {
    this.lastHeartbeat = Date.now()
    this.heartbeatCount++
    logWatchdog.debug(
      {
        heartbeatCount: this.heartbeatCount,
        timeSinceLastCheck: Date.now() - this.lastHeartbeat
      },
      'heartbeat получен'
    )
  }

  check() {
    const now = Date.now(),
      timeSinceLastHeartbeat = now - this.lastHeartbeat

    if (timeSinceLastHeartbeat > this.timeoutMs) {
      this.timeoutCount++
      logWatchdog.error(
        {
          timeSinceLastHeartbeat,
          timeoutMs: this.timeoutMs,
          timeoutCount: this.timeoutCount
        },
        'обнаружен таймаут watchdog'
      )

      if (this.onTimeout) {
        try {
          this.onTimeout()
        } catch (error) {
          logWatchdog.error(
            {
              err: error,
              errorMessage: error.message,
              errorStack: error.stack
            },
            'ошибка в callback таймаута'
          )
        }
      }
    } else {
      logWatchdog.debug(
        {
          timeSinceLastHeartbeat,
          timeoutMs: this.timeoutMs,
          remainingMs: this.timeoutMs - timeSinceLastHeartbeat
        },
        'проверка watchdog пройдена'
      )
    }
  }

  getTimeSinceLastHeartbeat() {
    return Date.now() - this.lastHeartbeat
  }

  isActive() {
    return this.isRunning
  }

  getStats() {
    return {
      isRunning: this.isRunning,
      intervalMs: this.intervalMs,
      timeoutMs: this.timeoutMs,
      heartbeatCount: this.heartbeatCount,
      timeoutCount: this.timeoutCount,
      timeSinceLastHeartbeat: this.getTimeSinceLastHeartbeat()
    }
  }

  resetStats() {
    this.heartbeatCount = 0
    this.timeoutCount = 0
    logWatchdog.info('статистика watchdog сброшена')
  }
}

export const watchdog = new Watchdog()
