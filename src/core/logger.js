import pino from 'pino'
import { createHash } from 'crypto'

const loggerConfig = {
  level: process.env.LOG_LEVEL || 'info',
  excerpts: process.env.LOG_EXCERPTS === 'true',
  randomIdLen: 9,
  excerptLen: 120,
  hashDisplayLen: 8,
  hashAlgo: 'sha256'
}

const RUN_ID = `${new Date().toISOString()}#${Math.random().toString(36).substr(2, loggerConfig.randomIdLen)}`

const baseLogger = pino({
  level: loggerConfig.level,
  redact: {
    paths: ['TG_SESSION', 'DATABASE_URL', 'TG_API_HASH', 'OPENAI_API_KEY'],
    censor: '[REDACTED]'
  },
  formatters: {
    level: (label) => ({ lvl: label })
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
      messageFormat: '{msg}'
    }
  }
})

export const logApp = baseLogger.child({ module: 'app', runId: RUN_ID }),
  logConfig = baseLogger.child({ module: 'core.config' }),
  logTime = baseLogger.child({ module: 'core.time' }),
  logWatchdog = baseLogger.child({ module: 'core.watchdog' }),
  logTelegram = baseLogger.child({ module: 'telegram' }),
  logTelegramClient = baseLogger.child({ module: 'telegram.client' }),
  logTelegramFetch = baseLogger.child({ module: 'telegram.fetch' }),
  logTelegramUpdates = baseLogger.child({ module: 'telegram.updates' }),
  logTelegramLink = baseLogger.child({ module: 'telegram.link' }),
  logTelegramSend = baseLogger.child({ module: 'telegram.send' }),
  logTelegramDialogs = baseLogger.child({ module: 'telegram.dialogs' }),
  logFilterRules = baseLogger.child({ module: 'filter.rules' }),
  logFilterOpenai = baseLogger.child({ module: 'filter.openai' }),
  logFilterDecide = baseLogger.child({ module: 'filter.decide' }),
  logFormat = baseLogger.child({ module: 'format.message' })

export function generateRequestId(peerId, messageId) {
  return `peer-${peerId}/${messageId}`
}

export function sanitizeMessageText(text) {
  if (!text || typeof text !== 'string') return { omitted: true }
  if (!loggerConfig.excerpts) return { omitted: true }

  return {
    excerpt: text.substring(0, loggerConfig.excerptLen),
    length: text.length,
    sha256:
      text.length > 0
        ? createHash(loggerConfig.hashAlgo)
            .update(text)
            .digest('hex')
            .substring(0, loggerConfig.hashDisplayLen)
        : null
  }
}

export function logPerformance(operation, metadata = {}) {
  const startTime = performance.now()

  return (logger, additionalData = {}) => {
    const durationMs = Math.round(performance.now() - startTime),
      status = durationMs < 1000 ? 'fast' : durationMs < 5000 ? 'normal' : 'slow'

    logger.info(
      {
        operation,
        durationMs,
        status,
        ...metadata,
        ...additionalData
      },
      `${operation} завершено за ${durationMs}мс`
    )
  }
}

export function logSuccess(logger, message, data = {}) {
  logger.info({ ...data, status: 'success' }, `[УСПЕХ] ${message}`)
}

export function logError(logger, message, error, context = {}) {
  logger.error(
    {
      ...context,
      error: error.message,
      stack: error.stack,
      status: 'error'
    },
    `[ОШИБКА] ${message}: ${error.message}`
  )
}

export function logWarning(logger, message, data = {}) {
  logger.warn({ ...data, status: 'warning' }, `[ВНИМАНИЕ] ${message}`)
}

export function logInfo(logger, message, data = {}) {
  logger.info({ ...data, status: 'info' }, message)
}

export function logDebug(logger, message, data = {}) {
  logger.debug({ ...data, status: 'debug' }, message)
}

export function logStart(logger, operation, data = {}) {
  logger.info({ ...data, status: 'start' }, `[СТАРТ] ${operation}`)
}

export function logEnd(logger, operation, data = {}) {
  logger.info({ ...data, status: 'end' }, `[ЗАВЕРШЕНО] ${operation}`)
}

export function logStats(logger, title, stats = {}) {
  logger.info({ ...stats, status: 'stats' }, `[СТАТИСТИКА] ${title}`)
}

export function logConnection(logger, service, data = {}) {
  logger.info({ ...data, status: 'connection' }, `Подключение к ${service}`)
}

export function logDisconnection(logger, service, data = {}) {
  logger.info({ ...data, status: 'disconnection' }, `Отключение от ${service}`)
}

export function logMessage(logger, action, message, data = {}) {
  logger.info(
    {
      ...data,
      messageId: message.id,
      peerId: message.peerId,
      status: action
    },
    `${action}: сообщение ${message.id} от ${message.peerId}`
  )
}

export function logPostProcessing(logger, postData, processingResult) {
  const {
      messageId,
      peerId,
      peerName,
      textLength,
      textSample,
      processingTimeMs,
      source = 'live'
    } = postData,
    { decision, confidence, category, reason, stage, isLead = false } = processingResult

  logger.info(
    {
      messageId,
      peerId,
      peerName,
      textLength,
      textSample: textSample || sanitizeMessageText(postData.text || '').excerpt,
      processingTimeMs,
      source,
      decision,
      confidence,
      category,
      reason,
      stage,
      isLead,
      status: 'post_processed'
    },
    `ОБРАБОТАНО: ${decision.toUpperCase()} | ${peerName} | ${category || 'unknown'} | ${confidence ? `${Math.round(confidence * 100)}%` : 'N/A'} | ${processingTimeMs}мс`
  )
}

export function logAIVerdict(logger, aiResult, context = {}) {
  const {
      confidence,
      category,
      reason,
      valid = true,
      processingTimeMs,
      model = 'unknown'
    } = aiResult,
    { messageId, peerId, peerName, textLength } = context,
    confidenceLevel = confidence >= 0.9 ? 'HIGH' : confidence >= 0.75 ? 'MEDIUM' : 'LOW'

  logger.info(
    {
      messageId,
      peerId,
      peerName,
      textLength,
      confidence,
      confidenceLevel,
      category,
      reason,
      valid,
      processingTimeMs,
      model,
      status: 'ai_verdict'
    },
    `AI ВЕРДИКТ: ${valid ? 'ВАЛИДНО' : 'НЕВАЛИДНО'} | ${category || 'unknown'} | ${confidenceLevel} (${Math.round(confidence * 100)}%) | ${reason || 'Нет причины'} | ${processingTimeMs || 0}мс`
  )
}

export function logTelegramSendResult(logger, sendResult, context = {}) {
  const {
      success,
      messageId: targetMessageId,
      contentLength,
      originalLength,
      wasTruncated,
      sentAt,
      error
    } = sendResult,
    { sourceMessageId, sourcePeerId, sourcePeerName, decision, confidence, category } = context

  if (success) {
    logger.info(
      {
        sourceMessageId,
        sourcePeerId,
        sourcePeerName,
        targetMessageId,
        contentLength,
        originalLength,
        wasTruncated,
        sentAt,
        decision,
        confidence,
        category,
        status: 'telegram_sent'
      },
      `TELEGRAM ОТПРАВЛЕНО: Лид переслан | ${sourcePeerName} -> Целевая группа | ${category || 'unknown'} | ${Math.round(confidence * 100)}% | ${contentLength} символов`
    )
  } else {
    logger.error(
      {
        sourceMessageId,
        sourcePeerId,
        sourcePeerName,
        error: error?.message || 'Неизвестная ошибка',
        decision,
        confidence,
        category,
        status: 'telegram_send_failed'
      },
      `TELEGRAM ОШИБКА ОТПРАВКИ: ${error?.message || 'Неизвестная ошибка'} | ${sourcePeerName} | ${category || 'unknown'}`
    )
  }
}

export function logBusinessMetrics(logger, metrics) {
  const {
      totalProcessed,
      leadsFound,
      leadsSent,
      leadsSkipped,
      errors,
      avgProcessingTime,
      avgConfidence,
      timeWindow = '1h'
    } = metrics,
    leadRate = totalProcessed > 0 ? ((leadsFound / totalProcessed) * 100).toFixed(1) : 0,
    sendRate = leadsFound > 0 ? ((leadsSent / leadsFound) * 100).toFixed(1) : 0

  logger.info(
    {
      totalProcessed,
      leadsFound,
      leadsSent,
      leadsSkipped,
      errors,
      leadRate: `${leadRate}%`,
      sendRate: `${sendRate}%`,
      avgProcessingTime: `${avgProcessingTime}мс`,
      avgConfidence: `${Math.round(avgConfidence * 100)}%`,
      timeWindow,
      status: 'business_metrics'
    },
    `БИЗНЕС МЕТРИКИ (${timeWindow}): Обработано: ${totalProcessed} | Лиды: ${leadsFound} (${leadRate}%) | Отправлено: ${leadsSent} (${sendRate}%) | Ошибки: ${errors} | Сред. время: ${avgProcessingTime}мс | Сред. уверенность: ${Math.round(avgConfidence * 100)}%`
  )
}

export { RUN_ID }
