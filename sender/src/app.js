import { loadConfig, getSenderConfig, getTelegramConfig } from './core/sender-config.js'
import { createRootLogger } from './core/sender-logger.js'
import { createDatabase } from './core/json-db.js'

process.on('uncaughtException', (error) => {
  if (error.message?.includes('Could not find a matching Constructor ID')) {
    console.log('Ошибка парсинга Telegram API - продолжаем...')
    return
  }
  console.error('Необработанное исключение:\n', error)
})

process.on('unhandledRejection', (reason, promise) => {
  if (reason?.message?.includes('Could not find a matching Constructor ID')) {
    console.log('Ошибка парсинга Telegram API - продолжаем...')
    return
  }
  console.error('Необработанный промис:\n', promise, '\nпричина:\n', reason)
})

import { createParserClient } from './telegram/clientParser.js'
import { createSenderClient } from './telegram/clientSender.js'
import { createReportClient } from './telegram/report.js'
import { createJsonScanner } from './core/json-scanner.js'
import { createContactDeduper } from './outreach/dedupe.js'
import { createMessageComposer } from './outreach/composer.js'
import { createRateLimiter } from './core/rate.js'
import { createOutreachSender } from './outreach/send.js'
import { createOutreachQueue } from './outreach/queue.js'
import { logInfo, logError } from './core/sender-logger.js'
import { formatDuration } from './core/sender-time.js'
import { extractAuthorUsernameFromMessage } from './inbox/extractAuthor.js'

const MONITORING_INTERVAL_MS = 5 * 60 * 1000

const startTime = Date.now()
let db,
  rootLogger,
  parserClient,
  senderClient,
  reportClient,
  jsonScanner,
  outreachSender,
  outreachQueue

async function start() {
  try {
    console.log('Запуск Telegram Outreach Sender')

    const config = loadConfig(),
      senderConfig = getSenderConfig(config),
      telegramConfig = getTelegramConfig(config)

    rootLogger = createRootLogger(senderConfig.logging)

    logInfo(rootLogger, 'Конфигурация загружена', {
      timezone: senderConfig.timezone,
      workWindow: senderConfig.window,
      rateLimit: senderConfig.rateLimit
    })

    db = createDatabase({}, rootLogger)
    await db.migrate()

    logInfo(rootLogger, 'База данных инициализирована')

    parserClient = createParserClient(telegramConfig.parser, senderConfig.leadInbox, rootLogger)
    senderClient = createSenderClient(telegramConfig.sender, rootLogger)
    reportClient = createReportClient(telegramConfig.parser, senderConfig.report, rootLogger)

    await Promise.all([parserClient.connect(), senderClient.connect(), reportClient.connect()])

    logInfo(rootLogger, 'Telegram клиенты подключены')

    try {
      console.log('Проверка извлечения автора из последнего сообщения...')
      const messages = await parserClient.client.getMessages(senderConfig.leadInbox.peerId, {
          limit: 1
        }),
        last = messages?.[0]
      if (last) {
        const denyList = Array.isArray(senderConfig.denyUsernames)
            ? senderConfig.denyUsernames
            : [],
          res = await extractAuthorUsernameFromMessage(parserClient, last, denyList)
        if (res?.username) {
          logInfo(rootLogger, 'Извлечение автора: УСПЕХ', {
            username: res.username,
            messageId: last.id
          })
          console.log(`Извлечен username: @${res.username}`)
        } else {
          logInfo(rootLogger, 'Извлечение автора: ПРОПУСК', {
            reason: res?.reason || 'UNKNOWN',
            messageId: last.id
          })
        }
      }
    } catch (e) {
      console.log('Ошибка извлечения автора:\n', e.message)
    }

    jsonScanner = createJsonScanner(senderConfig, rootLogger)
    if (parserClient && jsonScanner?.setParserClient) jsonScanner.setParserClient(parserClient)

    const contactDeduper = createContactDeduper(db, senderConfig.dedupe, rootLogger),
      messageComposer = createMessageComposer(senderConfig.message, rootLogger),
      rateLimiter = createRateLimiter(senderConfig.rateLimit, rootLogger)

    outreachSender = createOutreachSender(
      senderClient,
      reportClient,
      rateLimiter,
      contactDeduper,
      messageComposer,
      config,
      senderConfig.openai,
      rootLogger
    )

    outreachQueue = createOutreachQueue(outreachSender, config, rootLogger)

    console.log('Запуск компонентов outreach...')

    try {
      await outreachQueue.startProcessing()
      console.log('Очередь запущена')

      outreachSender
        .startSending()
        .catch((error) => console.error('Ошибка sender:\n', error.message))
      console.log('Sender запущен в фоне')
    } catch (error) {
      console.error('Ошибка запуска компонентов outreach:\n', error.message)
    }

    console.log('Запуск JSON сканера...')

    try {
      jsonScanner
        .start((contact) => {
          console.log('Добавление контакта:', contact.contact_key)
          try {
            db.addContact(contact)
            console.log('Контакт добавлен:', contact.contact_key)
          } catch (dbError) {
            console.error('Ошибка добавления контакта:\n', dbError.message)
          }
        })
        .then(() => console.log('JSON сканер запущен'))
        .catch((error) => console.error('Ошибка JSON сканера:\n', error.message))
    } catch (error) {
      console.error('Критическая ошибка JSON сканера:\n', error.message)
    }

    console.log('Система полностью инициализирована!')
    logInfo(rootLogger, 'Система outreach успешно запущена')

    startMonitoring()
    console.log('Все компоненты запущены!')
  } catch (error) {
    console.error('Ошибка запуска приложения:\n', error)
    process.exit(1)
  }
}

function startMonitoring() {
  const intervalId = setInterval(async () => {
    try {
      await logStats()
    } catch (error) {
      logError(null, error, { operation: 'monitoring' })
    }
  }, MONITORING_INTERVAL_MS)

  const shutdownHandler = async (signal) => {
    console.info(`Получен ${signal}, корректное завершение`)
    clearInterval(intervalId)
    await shutdown()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdownHandler('SIGINT'))
  process.on('SIGTERM', () => shutdownHandler('SIGTERM'))
}

async function logStats() {
  try {
    const uptime = formatDuration(Date.now() - startTime),
      [scannerStats, senderStats, queueStats, contactStats] = await Promise.all([
        jsonScanner.getStats(),
        outreachSender.getStats(),
        outreachQueue.getStats(),
        db.getContactStats()
      ])

    logInfo(rootLogger, 'Статистика системы', {
      uptime,
      scanner: scannerStats,
      sender: senderStats,
      queue: queueStats,
      contacts: contactStats
    })
  } catch (error) {
    logError(null, error, { operation: 'log_stats' })
  }
}

async function shutdown() {
  console.info('Завершение работы приложения')

  try {
    if (jsonScanner) jsonScanner.stop()
    if (outreachQueue) outreachQueue.stopProcessing()
    if (outreachSender) outreachSender.stopSending()

    await Promise.all(
      [parserClient?.disconnect(), senderClient?.disconnect(), reportClient?.disconnect()].filter(
        Boolean
      )
    )

    await db?.close()

    console.info('Завершение работы приложения выполнено')
  } catch (error) {
    logError(null, error, { operation: 'shutdown' })
  }
}

start().catch((error) => {
  console.error('Ошибка запуска приложения:\n', error)
  process.exit(1)
})
