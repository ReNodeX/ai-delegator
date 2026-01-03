import pino from 'pino'

const REDACT_FIELDS = [
  'apiHash',
  'session',
  'password',
  'token',
  'key',
  'secret',
  'authorization',
  'cookie'
]

function createLoggerConfig(level) {
  return {
    level,
    redact: { paths: REDACT_FIELDS, censor: '***REDACTED***' },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime
  }
}

export function createRootLogger(loggingConfig) {
  return pino(createLoggerConfig(loggingConfig.level))
}

export function createModuleLogger(rootLogger, moduleName, extraFields) {
  return rootLogger.child({ module: moduleName, ...extraFields })
}

export function createTelegramLogger(rootLogger, clientType, peerId) {
  const bindings = { category: 'telegram', clientType }
  if (peerId) bindings.peerId = peerId
  return rootLogger.child(bindings)
}

export function createInboxLogger(rootLogger, operation) {
  return rootLogger.child({ category: 'inbox', operation })
}

export function createOutreachLogger(rootLogger, operation, contactKey) {
  const bindings = { category: 'outreach', operation }
  if (contactKey) bindings.contactKey = contactKey
  return rootLogger.child(bindings)
}

export function createReportLogger(rootLogger) {
  return rootLogger.child({ category: 'report' })
}

export function createDbLogger(rootLogger) {
  return rootLogger.child({ category: 'database' })
}

export function createRateLogger(rootLogger) {
  return rootLogger.child({ category: 'rate-limit' })
}

export function createUtilLogger(rootLogger) {
  return rootLogger.child({ category: 'util' })
}

export function logEvent(logger, event, data = {}) {
  logger.info({ event, ...data }, `Event: ${event}`)
}

export function logError(logger, error, context = {}) {
  if (!logger) {
    console.error('Logger не предоставлен для logError')
    return
  }
  logger.error(
    {
      error: error?.message || 'Неизвестная ошибка',
      stack: error?.stack || 'Нет stack trace',
      ...context
    },
    'Произошла ошибка'
  )
}

export function logWarning(logger, message, context = {}) {
  logger.warn({ ...context }, message)
}

export function logInfo(logger, message, context = {}) {
  logger.info({ ...context }, message)
}

export function logDebug(logger, message, context = {}) {
  logger.debug({ ...context }, message)
}
