#!/usr/bin/env node

import PQueue from 'p-queue'
import { getConfig } from './core/config.js'
import {
  logApp as logger,
  logStart,
  logEnd,
  logSuccess,
  logError,
  logWarning,
  logInfo,
  logStats,
  logPerformance,
  logTelegramSendResult,
  logBusinessMetrics,
  logFilterDecide
} from './core/logger.js'
import { timeManager } from './core/time.js'
import { watchdog } from './core/watchdog.js'
import { createTelegramClient } from './telegram/client.js'
import { createMessageFetcher } from './telegram/fetch.js'
import { createUpdatesHandler } from './telegram/updates.js'
import { createMessageLinkGenerator } from './telegram/link.js'
import { createMessageSender } from './telegram/send.js'
import { createDialogManager } from './telegram/dialogs.js'
import { createFilterRules } from './filter/rules.js'
import { createOpenAIClassifier } from './filter/openai.js'
import { createMessageDecider } from './filter/decide.js'
import { createMessageFormatter } from './format/message.js'
import { JsonMessagesDB } from './core/json-messages.js'
import { startChatsScanner } from './core/chats-scanner.js'

const appConfig = {
  defaultMode: 'run',
  supportedModes: ['run', 'dry-run'],
  metricsWindow: 1000,
  heartbeatIntervalMs: 10000,
  statsIntervalMs: 30000,
  backfillIntervalMs: 2 * 60 * 1000,
  recentProcessedTtlMs: 60000,
  metricsLogIntervalMs: 5 * 60 * 1000,
  jsonDbPath: 'messages_for_sender.json'
}

const EXCLUDED_CHANNELS = [
  'freelance7',
  'normrabota',
  'freelancehunt',
  'freelancejob',
  'workua',
  'djinni_jobs',
  'remotework',
  'itjobs',
  'webdev_jobs',
  'designjobs',
  'marketingjobs',
  'contentjobs',
  'seo_jobs',
  'admin',
  'support',
  'help',
  'info',
  'contact',
  'bot',
  'service'
]

const AUTHOR_PATTERNS = [
  /(?:автор|от|отправитель|заказчик|клиент)\s*[:\-]?\s*@?([a-zA-Z0-9_]{5,32})/gi,
  /(?:пишите|напишите|свяжитесь|контакт|телеграм|тг|tg)\s*[:\-]?\s*@?([a-zA-Z0-9_]{5,32})/gi,
  /(?:мой|мой аккаунт|аккаунт|профиль|юзернейм|username)\s*[:\-]?\s*@?([a-zA-Z0-9_]{5,32})/gi,
  /(?:добавляйтесь|добавьтесь|добавить|найти|найди|ищите|ищу)\s*[:\-]?\s*@?([a-zA-Z0-9_]{5,32})/gi,
  /(?:работать|сотрудничать|связаться|работа)\s*[:\-]?\s*@?([a-zA-Z0-9_]{5,32})/gi
]

const AUTHOR_CONFIDENCE = 0.8,
  MIN_USERNAME_LENGTH = 5

class ParserDelegator {
  constructor() {
    this.config = null
    this.telegramClient = null
    this.messageFetcher = null
    this.updatesHandler = null
    this.messageLinkGenerator = null
    this.messageSender = null
    this.dialogManager = null
    this.filterRules = null
    this.aiClassifier = null
    this.messageDecider = null
    this.messageFormatter = null
    this.rateLimiter = null
    this.classificationQueue = null
    this.jsonMessagesDB = null
    this.chatsScannerInterval = null
    this.isRunning = false
    this.dryRun = false
    this.recentlyProcessed = new Set()

    this.businessMetrics = {
      totalProcessed: 0,
      leadsFound: 0,
      leadsSent: 0,
      leadsSkipped: 0,
      errors: 0,
      processingTimes: [],
      confidences: [],
      startTime: Date.now(),
      lastMetricsLog: Date.now()
    }
  }

  async initialize() {
    const perf = logPerformance('инициализация приложения')

    try {
      logStart(logger, 'инициализация системы Telegram парсера')

      this.config = getConfig()
      const { backfillDays, target } = this.config

      logSuccess(logger, 'конфигурация системы загружена успешно', {
        backfillDays,
        targetGroupId: target.groupId
      })

      const { env, limits } = this.config
      this.telegramClient = createTelegramClient(env.TG_API_ID, env.TG_API_HASH, env.TG_SESSION)
      await this.telegramClient.connect()
      logSuccess(logger, 'Telegram клиент подключен и авторизован')

      this.rateLimiter = new PQueue({
        concurrency: 1,
        interval: 1000 / limits.maxTgRequestsPerSecond,
        intervalCap: limits.maxTgRequestsPerSecond
      })
      this.rateLimiter.acquire = () => this.rateLimiter.add(() => Promise.resolve())
      logSuccess(logger, 'система rate limiting для Telegram API инициализирована')

      this.classificationQueue = new PQueue({ concurrency: limits.maxParallelClassify })
      logSuccess(logger, 'очередь AI классификации сообщений настроена')

      const client = this.telegramClient.getClient()
      this.messageFetcher = createMessageFetcher(client, this.rateLimiter)
      this.messageLinkGenerator = createMessageLinkGenerator(client)
      this.messageSender = createMessageSender(client, target.groupId, this.rateLimiter)
      logSuccess(logger, 'компоненты обработки сообщений инициализированы')

      this.dialogManager = createDialogManager(client, this.config)
      this.filterRules = createFilterRules(this.config)
      this.aiClassifier = createOpenAIClassifier(this.config.env.OPENAI_API_KEY, this.config)
      logSuccess(logger, `OpenAI классификатор инициализирован с моделью: ${this.config.ai.model}`)

      this.messageDecider = createMessageDecider(this.filterRules, this.aiClassifier, this.config)
      this.messageFormatter = createMessageFormatter(this.config)

      this.jsonMessagesDB = new JsonMessagesDB(appConfig.jsonDbPath, logger)
      logSuccess(logger, 'все компоненты системы инициализированы')

      this.updatesHandler = createUpdatesHandler(client, this, this.rateLimiter)
      logSuccess(logger, 'обработчик live-обновлений Telegram настроен')

      this.chatsScannerInterval = startChatsScanner(client)
      logSuccess(logger, 'сканер чатов запущен (синхронизация каждые 10 минут)')

      this.setupErrorHandlers()
      this.setupWatchdog()

      perf(logger, { status: 'success' })
      logEnd(logger, 'инициализация системы Telegram парсера')
    } catch (error) {
      logError(logger, 'критическая ошибка при инициализации системы', error)
      perf(logger, { status: 'error' })
      throw error
    }
  }

  setupErrorHandlers() {
    process.on('uncaughtException', (error) => {
      if (error?.message?.includes('builder.resolve is not a function')) {
        logWarning(logger, 'подавлен краш gramJS live updates (uncaughtException)')
        return
      }
      throw error
    })

    process.on('unhandledRejection', (reason) => {
      const msg = reason?.message || String(reason)
      if (msg.includes('builder.resolve is not a function')) {
        logWarning(logger, 'подавлен краш gramJS live updates (unhandledRejection)')
        return
      }
      throw reason
    })
  }

  setupWatchdog() {
    watchdog.start(() => {
      logWarning(logger, 'watchdog timeout обнаружен, проверяем статус соединения')
      this.handleWatchdogTimeout()
    })
    logSuccess(logger, 'система мониторинга соединения запущена')
  }

  async runBackfill() {
    const startTime = performance.now()
    logStart(logger, 'обработка истории сообщений')

    const cutoffTime = timeManager.getCutoffTime(this.config.backfillDays),
      stats = {
        sources: 0,
        totalMessages: 0,
        processedMessages: 0,
        leadsFound: 0,
        errors: 0,
        startTime: Date.now()
      }

    try {
      logInfo(logger, 'обнаружение диалогов в аккаунте...')
      const dialogs = await this.dialogManager.getAllDialogs(),
        dialogStats = this.dialogManager.getDialogStats(dialogs)
      logSuccess(logger, 'обнаружение диалогов завершено', dialogStats)

      for (const dialogInfo of dialogs) {
        try {
          logInfo(logger, 'обработка диалога', {
            type: dialogInfo.type,
            username: dialogInfo.username,
            id: dialogInfo.id,
            title: dialogInfo.title
          })

          const peer = dialogInfo.entity
          stats.sources++

          const sourceStats = await this.messageFetcher.fetchHistory(
            peer,
            cutoffTime,
            (message) => this.processMessage(message, peer, 'backfill'),
            (progress) =>
              logInfo(logger, 'прогресс обработки диалога', {
                source: dialogInfo.username || dialogInfo.title || dialogInfo.id,
                ...progress
              })
          )

          stats.totalMessages += sourceStats.totalMessages
          stats.processedMessages += sourceStats.processedMessages
          stats.errors += sourceStats.errorMessages
        } catch (error) {
          logError(logger, 'ошибка обработки диалога', error, {
            dialog: {
              type: dialogInfo.type,
              username: dialogInfo.username,
              id: dialogInfo.id,
              title: dialogInfo.title
            }
          })
          stats.errors++
        }
      }

      const { aiApproved } = this.messageDecider.getStats()
      stats.duration = Date.now() - stats.startTime
      stats.leadsFound = aiApproved
      stats.durationMs = Math.round(performance.now() - startTime)

      logEnd(logger, 'обработка истории сообщений')
      logStats(logger, 'статистика backfill обработки', stats)
    } catch (error) {
      const durationMs = Math.round(performance.now() - startTime)
      logError(logger, 'ошибка обработки истории сообщений', error, { durationMs })
      throw error
    }
  }

  async startLiveUpdates() {
    const startTime = performance.now()

    if (!this.config.live.enable) {
      logWarning(logger, 'live updates отключены в конфигурации')
      return
    }

    logStart(logger, 'запуск live мониторинга новых сообщений')

    try {
      const dialogs = await this.dialogManager.getAllDialogs(),
        sources = dialogs.map((dialog) => ({
          type: dialog.type,
          username: dialog.username,
          id: parseInt(dialog.id, 10)
        })),
        { byType } = this.dialogManager.getDialogStats(dialogs)

      logger.info('app', 'запуск live updates для диалогов', {
        dialogsCount: dialogs.length,
        types: byType
      })

      await this.updatesHandler.startListening(sources, this.config.live.debounceMs)

      this.isRunning = true
      const durationMs = Math.round(performance.now() - startTime)
      logSuccess(logger, 'live мониторинг успешно запущен', { durationMs })
    } catch (error) {
      const durationMs = Math.round(performance.now() - startTime)
      logError(logger, 'ошибка запуска live мониторинга', error, { durationMs })
      logWarning(logger, 'переключение на режим polling')
      this.isRunning = true
    }
  }

  async processMessage(message, peer, source = 'live') {
    const processingStartTime = performance.now()

    try {
      const messageText = this.messageFormatter.extractMessageText(message)
      if (!messageText) {
        this.businessMetrics.leadsSkipped++
        return 'skipped'
      }

      const contentHash = this.jsonMessagesDB.generateContentHash(messageText)

      if (this.jsonMessagesDB.isMessageForwarded(parseInt(peer.id), parseInt(message.id))) {
        this.businessMetrics.leadsSkipped++
        logFilterDecide.debug(
          { messageId: message.id, peerId: peer.id, reason: 'already_forwarded' },
          'сообщение уже переслано, пропускаем'
        )
        return 'skipped'
      }

      if (this.jsonMessagesDB.isContentForwarded(contentHash)) {
        this.businessMetrics.leadsSkipped++
        logFilterDecide.debug(
          { messageId: message.id, peerId: peer.id, reason: 'duplicate_content' },
          'обнаружен дубликат контента, пропускаем'
        )
        return 'skipped'
      }

      const messageKey = `${peer.id}_${message.id}`
      if (this.recentlyProcessed.has(messageKey)) {
        this.businessMetrics.leadsSkipped++
        logFilterDecide.debug(
          { messageId: message.id, peerId: peer.id, reason: 'recently_processed' },
          'сообщение недавно обработано, пропускаем'
        )
        return 'skipped'
      }

      this.recentlyProcessed.add(messageKey)
      setTimeout(() => this.recentlyProcessed.delete(messageKey), appConfig.recentProcessedTtlMs)

      const decision = await this.messageDecider.processMessage(messageText, message)

      this.updateMetrics(processingStartTime, decision)

      if (decision.decision === 'approved')
        return await this.handleApprovedMessage(message, peer, messageText, contentHash, decision)

      return 'skipped'
    } catch (error) {
      this.businessMetrics.errors++
      logError(logger, 'ошибка обработки сообщения', error, {
        messageId: message.id,
        peerId: parseInt(peer.id)
      })
      return 'error'
    } finally {
      this.checkMetricsLog()
    }
  }

  updateMetrics(processingStartTime, decision) {
    this.businessMetrics.totalProcessed++
    const processingTime = Math.round(performance.now() - processingStartTime)
    this.businessMetrics.processingTimes.push(processingTime)

    if (this.businessMetrics.processingTimes.length > appConfig.metricsWindow) {
      this.businessMetrics.processingTimes.splice(
        0,
        this.businessMetrics.processingTimes.length - appConfig.metricsWindow
      )
    }

    if (decision.confidence) {
      this.businessMetrics.confidences.push(decision.confidence)
      if (this.businessMetrics.confidences.length > appConfig.metricsWindow) {
        this.businessMetrics.confidences.splice(
          0,
          this.businessMetrics.confidences.length - appConfig.metricsWindow
        )
      }
    }
  }

  async handleApprovedMessage(message, peer, messageText, contentHash, decision) {
    this.businessMetrics.leadsFound++

    const messageLink = await this.messageLinkGenerator.generateLink(peer, message.id),
      leadData = {
        messageText,
        messageDate: timeManager.fromTelegramDate(message.date),
        messageLink,
        peerName: this.messageFormatter.formatPeerName(peer)
      },
      formattedMessage = this.messageFormatter.formatLeadMessage(leadData)

    if (this.dryRun) {
      logInfo(logger, 'DRY RUN: сообщение лида было бы отправлено', {
        messageId: message.id,
        peerId: parseInt(peer.id),
        decision: decision.reason,
        confidence: decision.confidence
      })
      return 'processed'
    }

    const sendResult = await this.messageSender.sendMessage(formattedMessage),
      sendContext = {
        sourceMessageId: message.id,
        sourcePeerId: peer.id,
        sourcePeerName: this.messageFormatter.formatPeerName(peer),
        decision: decision.reason,
        confidence: decision.confidence,
        category: decision.category
      }

    logTelegramSendResult(logger, sendResult, sendContext)

    if (sendResult.success) {
      this.businessMetrics.leadsSent++
      this.saveMessageToJsonDatabase(
        message,
        peer,
        formattedMessage,
        sendResult,
        decision,
        contentHash
      )
      logSuccess(logger, 'сообщение лида успешно отправлено', {
        messageId: message.id,
        peerId: parseInt(peer.id),
        targetMessageId: sendResult.messageId,
        decision: decision.reason,
        confidence: decision.confidence
      })
      return 'processed'
    }

    this.businessMetrics.errors++
    logError(logger, 'ошибка отправки сообщения лида', new Error(sendResult.error), {
      messageId: message.id,
      peerId: parseInt(peer.id)
    })
    return 'error'
  }

  checkMetricsLog() {
    const now = Date.now()
    if (now - this.businessMetrics.lastMetricsLog > appConfig.metricsLogIntervalMs) {
      this.logBusinessMetrics()
      this.businessMetrics.lastMetricsLog = now
    }
  }

  logBusinessMetrics() {
    const {
        totalProcessed,
        leadsFound,
        leadsSent,
        leadsSkipped,
        errors,
        processingTimes,
        confidences,
        startTime
      } = this.businessMetrics,
      avgProcessingTime =
        processingTimes.length > 0
          ? Math.round(processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length)
          : 0,
      avgConfidence =
        confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0,
      timeWindow = Math.round((Date.now() - startTime) / 1000 / 60)

    logBusinessMetrics(logger, {
      totalProcessed,
      leadsFound,
      leadsSent,
      leadsSkipped,
      errors,
      avgProcessingTime,
      avgConfidence,
      timeWindow: `${timeWindow}m`
    })
  }

  async handleWatchdogTimeout() {
    try {
      if (this.telegramClient.isClientConnected()) {
        logInfo(logger, 'клиент все еще подключен, сбрасываем watchdog')
        watchdog.heartbeat()
        return
      }

      logWarning(logger, 'клиент отключен, пытаемся переподключиться...')
      await this.handleReconnection()
    } catch (error) {
      logError(logger, 'ошибка обработки watchdog timeout', error)
    }
  }

  async handleReconnection() {
    try {
      logInfo(logger, 'попытка переподключения к Telegram...')
      await this.telegramClient.reconnect()
      watchdog.heartbeat()
      logSuccess(logger, 'переподключение к Telegram успешно')
    } catch (error) {
      logError(logger, 'ошибка переподключения к Telegram', error)
    }
  }

  async shutdown() {
    logger.info('app', 'Завершение работы...')
    this.isRunning = false

    try {
      if (this.updatesHandler) this.updatesHandler.stopListening()
      if (this.chatsScannerInterval) clearInterval(this.chatsScannerInterval)

      watchdog.stop()

      if (this.jsonMessagesDB) await this.jsonMessagesDB.close()
      if (this.telegramClient) await this.telegramClient.disconnect()

      logSuccess(logger, 'завершение работы приложения выполнено')
    } catch (error) {
      logError(logger, 'ошибка при завершении работы', error)
    }
  }

  async run(mode = 'run') {
    this.dryRun = mode === 'dry-run'

    try {
      await this.initialize()

      setInterval(() => {
        const stats = this.messageDecider.getStats()
        logStats(logger, 'статистика очереди обработки', stats)
      }, appConfig.statsIntervalMs)

      await this.runBackfill()
      await this.startLiveUpdates()

      setInterval(async () => {
        try {
          if (!this.telegramClient.isClientConnected()) {
            logWarning(logger, 'клиент отключен, пропускаем периодическую проверку')
            return
          }

          logInfo(logger, 'запуск периодической проверки')
          await this.runBackfill()
        } catch (error) {
          logError(logger, 'ошибка в периодической проверке', error)
        }
      }, appConfig.backfillIntervalMs)

      if (this.isRunning) {
        logSuccess(logger, 'система переключена в режим live мониторинга')
        logInfo(logger, 'приложение запущено, нажмите Ctrl+C для остановки')

        process.on('SIGINT', async () => {
          logInfo(logger, 'получен SIGINT, завершаем работу...')
          await this.shutdown()
          process.exit(0)
        })

        process.on('SIGTERM', async () => {
          logInfo(logger, 'получен SIGTERM, завершаем работу...')
          await this.shutdown()
          process.exit(0)
        })

        setInterval(() => {
          if (this.telegramClient.isClientConnected()) watchdog.heartbeat()
          else logWarning(logger, 'клиент отключен, heartbeat не отправлен')
        }, appConfig.heartbeatIntervalMs)

        await new Promise(() => {})
      }
    } catch (error) {
      logger.error('app', 'Ошибка приложения', { error: error.message })
      await this.shutdown()
      process.exit(1)
    }
  }

  extractAuthorFromMessage(message) {
    try {
      const messageText = message.message || message.text || ''

      for (const pattern of AUTHOR_PATTERNS) {
        const match = pattern.exec(messageText)
        if (match) {
          const username = match[1].toLowerCase()

          if (!EXCLUDED_CHANNELS.includes(username) && username.length >= MIN_USERNAME_LENGTH) {
            return {
              username,
              displayName: `@${username}`,
              source: 'text_extraction',
              confidence: AUTHOR_CONFIDENCE
            }
          }
        }
      }

      return { username: null, displayName: null, source: 'not_found', confidence: 0 }
    } catch (error) {
      logError(logger, 'ошибка извлечения автора из сообщения', error)
      return { username: null, displayName: null, source: 'error', confidence: 0 }
    }
  }

  saveMessageToJsonDatabase(message, peer, formattedMessage, sendResult, decision, contentHash) {
    try {
      const authorInfo = this.extractAuthorFromMessage(message),
        messageData = {
          sourceMessageId: message.id,
          sourcePeerId: parseInt(peer.id),
          sourcePeerName: this.messageFormatter.formatPeerName(peer),
          targetMessageId: sendResult.messageId,
          fullContent: formattedMessage,
          originalMessage: message.message || message.text || '',
          contentHash,
          decision: decision.reason,
          confidence: decision.confidence,
          category: decision.category,
          contentLength: sendResult.contentLength,
          wasTruncated: sendResult.wasTruncated,
          sentAt: sendResult.sentAt,
          authorUsername: authorInfo.username,
          authorDisplayName: authorInfo.displayName,
          authorSource: authorInfo.source
        }

      this.jsonMessagesDB.addMessage(messageData)

      logInfo(logger, 'сообщение сохранено в JSON базу для sender', {
        sourceMessageId: message.id,
        sourcePeerName: messageData.sourcePeerName,
        category: decision.category
      })
    } catch (error) {
      logError(logger, 'не удалось сохранить сообщение в JSON базу', error, {
        sourceMessageId: message.id,
        sourcePeerId: parseInt(peer.id)
      })
    }
  }
}

const mode = process.argv[2] || appConfig.defaultMode

if (appConfig.supportedModes.includes(mode)) {
  const app = new ParserDelegator()
  app.run(mode).catch((error) => {
    console.error('Фатальная ошибка:\n', error.message)
    process.exit(1)
  })
} else {
  console.log('Использование: node src/app.js [run|dry-run]')
  process.exit(1)
}
