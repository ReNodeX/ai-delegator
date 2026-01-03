import { isInWorkWindow, getTimeUntilSenderWindowOpen, delay } from '../core/sender-time.js'
import { configJitterDelay } from '../core/rate.js'
import { createOutreachReportHtml, createSkipReportHtml } from '../telegram/links.js'
import {
  createOutreachLogger,
  logDebug,
  logInfo,
  logWarning,
  logError
} from '../core/sender-logger.js'
import { createSentHistory } from '../core/sent-history.js'
import { createCheckpointManager } from '../core/checkpoint.js'

const sendConfig = {
  rateLimitTimeoutMs: 30000,
  noTasksDelayMs: 5000,
  windowCheckDelayMs: 60000,
  contactsBatchSize: 10,
  requeueBatchSize: 50,
  ensureTasksLimit: 1,
  requeueLimit: 10
}

export class OutreachSender {
  constructor(
    senderClient,
    reportClient,
    rateLimiter,
    contactDeduper,
    messageComposer,
    config,
    openaiConfig,
    rootLogger
  ) {
    this.senderClient = senderClient
    this.reportClient = reportClient
    this.rateLimiter = rateLimiter
    this.contactDeduper = contactDeduper
    this.messageComposer = messageComposer
    this.config = config
    this.openaiConfig = openaiConfig
    this.rootLogger = rootLogger

    this.outreachLogger = createOutreachLogger(this.rootLogger, 'send')
    this.sentHistory = createSentHistory(this.outreachLogger)
    this.checkpointManager = createCheckpointManager(this.outreachLogger)

    this.isRunning = false
    this.shouldStop = false

    logInfo(this.outreachLogger, 'Outreach sender инициализирован')
  }

  async startSending() {
    if (this.isRunning) throw new Error('Sender уже запущен')

    this.isRunning = true
    this.shouldStop = false

    logInfo(this.outreachLogger, 'Запуск процесса outreach отправки')

    try {
      while (!this.shouldStop) {
        const hasTasks = await this.ensureTasksAvailable()
        if (!hasTasks) {
          logDebug(this.outreachLogger, 'Задач нет, ждем')
          await delay(sendConfig.noTasksDelayMs)
          continue
        }

        if (!isInWorkWindow(this.config.sender.window, this.config.sender.timezone)) {
          const waitTime = getTimeUntilSenderWindowOpen(this.config)

          logInfo(this.outreachLogger, 'Вне рабочего окна, ждем', {
            waitTimeMs: waitTime,
            window: this.config.sender.window
          })

          await delay(Math.min(waitTime, sendConfig.windowCheckDelayMs))
          continue
        }

        const hasToken = await this.rateLimiter.waitForToken(sendConfig.rateLimitTimeoutMs)

        if (!hasToken) {
          logWarning(this.outreachLogger, 'Таймаут ожидания токена rate limit')
          await delay(sendConfig.noTasksDelayMs)
          continue
        }

        const sent = await this.processNextTask()

        if (!sent) await delay(sendConfig.noTasksDelayMs)
        else await configJitterDelay(this.config.sender.rateLimit)
      }
    } catch (error) {
      logError(this.outreachLogger, error, { operation: 'start_sending' })
    } finally {
      this.isRunning = false
      logInfo(this.outreachLogger, 'Процесс outreach отправки остановлен')
    }
  }

  async ensureTasksAvailable() {
    try {
      let contacts = await this.contactDeduper.getContactsForSending(sendConfig.ensureTasksLimit)
      if (contacts.length > 0) return true

      if (typeof this.contactDeduper.db.requeueFailed === 'function') {
        const requeued = await this.contactDeduper.db.requeueFailed(sendConfig.requeueLimit)
        if (requeued > 0) {
          contacts = await this.contactDeduper.getContactsForSending(sendConfig.ensureTasksLimit)
          if (contacts.length > 0) {
            logInfo(this.outreachLogger, 'Неудачные контакты переставлены в очередь', {
              count: requeued
            })
            return true
          }
        }
      }
      return false
    } catch {
      logWarning(this.outreachLogger, 'Не удалось проверить наличие задач')
      return false
    }
  }

  stopSending() {
    logInfo(this.outreachLogger, 'Остановка процесса outreach отправки')
    this.shouldStop = true
  }

  isRunningProcess() {
    return this.isRunning
  }

  async processNextTask() {
    try {
      let contacts = await this.contactDeduper.getContactsForSending(sendConfig.contactsBatchSize)
      logDebug(this.outreachLogger, 'Ожидающие контакты получены', { count: contacts.length })

      if (contacts.length === 0) {
        if (typeof this.contactDeduper.db.requeueFailed === 'function') {
          const requeued = await this.contactDeduper.db.requeueFailed(sendConfig.requeueBatchSize)
          if (requeued > 0) {
            contacts = await this.contactDeduper.getContactsForSending(sendConfig.contactsBatchSize)
            logDebug(this.outreachLogger, 'Ожидающие после requeue', {
              count: contacts.length,
              requeued
            })
          }
        }
        if (contacts.length === 0) {
          logDebug(this.outreachLogger, 'Нет контактов для отправки')
          return false
        }
      }

      const contact = contacts[0]

      logInfo(this.outreachLogger, 'Обработка контакта для отправки', {
        contactKey: contact.contact_key,
        status: contact.status,
        sourceMessageId: contact.source_message_id
      })

      const result = await this.sendToContact(contact)

      if (result?.error === 'DUPLICATE_CONTACT') {
        try {
          const skipHtml = createSkipReportHtml(contact.contact_key, 'DUPLICATE_CONTACT')
          await this.reportClient.sendReport(skipHtml)
        } catch (e) {
          logWarning(this.outreachLogger, 'Не удалось отправить skip отчет для дубликата', {
            contactKey: contact.contact_key,
            error: e.message
          })
        }

        await this.contactDeduper.updateContactStatus(
          contact.contact_key,
          'skipped',
          'DUPLICATE_CONTACT'
        )
        return true
      }

      await this.sendReport(contact, result)

      await this.contactDeduper.updateContactStatus(
        contact.contact_key,
        result.success ? 'sent' : 'failed',
        result.error
      )

      return true
    } catch (error) {
      logError(this.outreachLogger, error, { operation: 'process_next_task' })
      return false
    }
  }

  async sendToContact(contact) {
    const startTime = Date.now(),
      contactKey = contact.contact_key

    if (this.sentHistory.isAlreadySent(contactKey)) {
      const sentInfo = this.sentHistory.getSentInfo(contactKey)

      logWarning(this.outreachLogger, 'Пропуск дубликата контакта - уже отправлен', {
        contactKey,
        sourceMessageId: contact.source_message_id,
        previousSent: {
          firstSent: sentInfo.first_sent,
          lastSent: sentInfo.last_sent,
          count: sentInfo.count,
          sourceMessageIds: sentInfo.source_message_ids
        }
      })

      try {
        await this.contactDeduper.updateContactStatus(contactKey, 'skipped', 'DUPLICATE_CONTACT')
      } catch (e) {
        logWarning(this.outreachLogger, 'Не удалось отметить дубликат как пропущенный', {
          contactKey,
          error: e.message
        })
      }

      return {
        success: false,
        error: 'DUPLICATE_CONTACT',
        contactKey,
        durationMs: Date.now() - startTime,
        sentInfo
      }
    }

    try {
      const leadContext = this.messageComposer.createLeadContext(
          contact.lead_description || 'Запрос на дизайн/разработку',
          contactKey,
          contact.source_message_id,
          this.detectCategory(contact.lead_description)
        ),
        effectiveOpenAI = { ...(this.config?.sender?.openai || {}), ...(this.openaiConfig || {}) }

      logDebug(this.outreachLogger, 'Эффективный OpenAI конфиг', {
        hasApiKey: !!effectiveOpenAI.apiKey,
        model: effectiveOpenAI.model,
        maxTokens: effectiveOpenAI.maxTokens,
        temperature: effectiveOpenAI.temperature
      })

      const composed = await this.messageComposer.composeMessage(
        contactKey,
        leadContext,
        effectiveOpenAI,
        this.rootLogger
      )

      logDebug(this.outreachLogger, 'AI сообщение сгенерировано для контакта', {
        contactKey,
        templateId: composed.templateId,
        textLength: composed.text.length,
        aiTokens: composed.variables?.tokens
      })

      const userInfo = await this.senderClient.getUserInfo(contactKey)
      if (!userInfo) {
        logWarning(this.outreachLogger, 'Контакт не существует, пропускаем', {
          contactKey,
          reason: 'Пользователь не найден в Telegram'
        })

        return {
          contactKey,
          success: false,
          messageId: null,
          error: `Cannot find any entity corresponding to "${contactKey}"`,
          floodWaitSeconds: null,
          attempts: 0,
          durationMs: Date.now() - startTime
        }
      }

      const sendResult = await this.senderClient.sendMessage(contactKey, composed.text, {
          parseMode: 'html'
        }),
        duration = Date.now() - startTime,
        result = {
          contactKey,
          success: sendResult.success,
          messageId: sendResult.messageId,
          error: sendResult.error,
          floodWaitSeconds: sendResult.floodWaitSeconds,
          attempts: 1,
          durationMs: duration
        }

      logInfo(this.outreachLogger, 'Результат отправки AI сообщения', {
        contactKey,
        success: result.success,
        durationMs: result.durationMs,
        error: result.error,
        aiTokens: composed.variables?.tokens
      })

      if (result.success) this.sentHistory.recordSent(contactKey, contact.source_message_id)

      this.checkpointManager.updateProgress(contactKey, result.success)

      return result
    } catch (error) {
      const duration = Date.now() - startTime

      logError(this.outreachLogger, error, {
        operation: 'send_to_contact',
        contactKey,
        durationMs: duration
      })

      return { contactKey, success: false, error: error.message, attempts: 1, durationMs: duration }
    }
  }

  async sendReport(contact, result) {
    try {
      if (result.success) {
        const reportHtml = createOutreachReportHtml(
          contact.contact_key,
          contact.source_peer_id,
          contact.source_message_id,
          'v1',
          'OK'
        )

        await this.reportClient.sendReport(reportHtml)

        logDebug(this.outreachLogger, 'Отчет успеха отправлен', { contactKey: contact.contact_key })
      } else {
        const reportHtml = createOutreachReportHtml(
          contact.contact_key,
          contact.source_peer_id,
          contact.source_message_id,
          'v1',
          'ERROR',
          result.error
        )

        await this.reportClient.sendReport(reportHtml)

        logDebug(this.outreachLogger, 'Отчет ошибки отправлен', {
          contactKey: contact.contact_key,
          error: result.error
        })
      }
    } catch (error) {
      logWarning(this.outreachLogger, 'Не удалось отправить отчет', {
        contactKey: contact.contact_key,
        error: error.message
      })
    }
  }

  async addSendTask(contactKey, contactType, sourcePeerId, sourceMessageId, leadDescription) {
    try {
      const duplicateCheck = await this.contactDeduper.checkDuplicate(contactKey)

      if (duplicateCheck.isDuplicate) {
        logDebug(this.outreachLogger, 'Контакт уже обработан, отправляем skip отчет', {
          contactKey,
          reason: duplicateCheck.reason
        })

        const skipReportHtml = createSkipReportHtml(
          contactKey,
          duplicateCheck.reason || 'Already processed'
        )
        await this.reportClient.sendReport(skipReportHtml)

        return
      }

      const leadContext = this.messageComposer.createLeadContext(
          leadDescription || 'Запрос на дизайн/разработку',
          contactKey,
          sourceMessageId,
          this.detectCategory(leadDescription || '')
        ),
        composed = await this.messageComposer.composeMessage(
          contactKey,
          leadContext,
          this.openaiConfig,
          this.rootLogger
        )

      await this.contactDeduper.registerContact(
        contactKey,
        contactType,
        sourcePeerId,
        sourceMessageId,
        composed.text,
        undefined,
        leadDescription
      )

      logInfo(this.outreachLogger, 'AI задача отправки добавлена', {
        contactKey,
        contactType,
        sourceMessageId,
        descriptionLength: leadDescription?.length || 0,
        aiTokens: composed.variables?.tokens
      })
    } catch (error) {
      logError(this.outreachLogger, error, {
        operation: 'add_send_task',
        contactKey,
        sourceMessageId
      })
      throw error
    }
  }

  getAIApiKey() {
    return this.openaiConfig?.apiKey || this.config?.sender?.openai?.apiKey || ''
  }

  detectCategory(description) {
    const lowerDesc = description.toLowerCase()

    if (
      lowerDesc.includes('дизайн') ||
      lowerDesc.includes('дизайнер') ||
      lowerDesc.includes('афиш') ||
      lowerDesc.includes('баннер')
    )
      return 'дизайн'
    if (
      lowerDesc.includes('разработк') ||
      lowerDesc.includes('сайт') ||
      lowerDesc.includes('приложени') ||
      lowerDesc.includes('программист')
    )
      return 'разработка'
    if (
      lowerDesc.includes('маркетинг') ||
      lowerDesc.includes('реклам') ||
      lowerDesc.includes('продвижени')
    )
      return 'маркетинг'
    if (
      lowerDesc.includes('копирайт') ||
      lowerDesc.includes('текст') ||
      lowerDesc.includes('контент')
    )
      return 'копирайтинг'
    return 'дизайн/разработка'
  }

  async getStats() {
    const contactStats = await this.contactDeduper.getContactStats(),
      rateStats = this.rateLimiter.getStats()

    return {
      isRunning: this.isRunning,
      contactStats,
      rateLimit: rateStats,
      workWindow: {
        isInWindow: isInWorkWindow(this.config.sender.window, this.config.sender.timezone),
        window: this.config.sender.window
      }
    }
  }
}

export function createOutreachSender(
  senderClient,
  reportClient,
  rateLimiter,
  contactDeduper,
  messageComposer,
  config,
  openaiConfig,
  rootLogger
) {
  return new OutreachSender(
    senderClient,
    reportClient,
    rateLimiter,
    contactDeduper,
    messageComposer,
    config,
    openaiConfig,
    rootLogger
  )
}
