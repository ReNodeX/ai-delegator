import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { createTelegramLogger, logError, logInfo, logDebug } from '../core/sender-logger.js'
import { retryWithBackoff } from '../core/util.js'

const reportConfig = {
  connectionRetries: 3,
  retryDelayMs: 1000,
  useWss: true,
  timeoutMs: 30000,
  backoffBaseMs: 1000,
  backoffMaxMs: 5000,
  backoffMaxAttempts: 3
}

export class ReportResult {
  constructor(success, messageId, error) {
    this.success = success
    this.messageId = messageId
    this.error = error
  }
}

export class ReportClient {
  constructor(config, reportCfg, rootLogger) {
    this.config = config
    this.reportCfg = reportCfg
    this.rootLogger = rootLogger
    this.connected = false

    this.reportLogger = createTelegramLogger(rootLogger, 'parser', reportCfg.peerId)

    const session = new StringSession(config.session)
    this.client = new TelegramClient(session, config.apiId, config.apiHash, {
      connectionRetries: reportConfig.connectionRetries,
      retryDelay: reportConfig.retryDelayMs,
      useWSS: reportConfig.useWss,
      timeout: reportConfig.timeoutMs
    })
  }

  async connect() {
    try {
      logInfo(this.reportLogger, 'Подключение к Telegram для отчетов', { apiId: this.config.apiId })

      await retryWithBackoff(
        () => this.client.connect(),
        reportConfig.backoffMaxAttempts,
        reportConfig.backoffBaseMs,
        reportConfig.backoffMaxMs
      )

      this.connected = true
      logInfo(this.reportLogger, 'Подключено к Telegram для отчетов')
    } catch (error) {
      logError(this.reportLogger, error, { operation: 'connect' })
      throw error
    }
  }

  async disconnect() {
    try {
      logInfo(this.reportLogger, 'Отключение клиента отчетов')

      if (this.connected) {
        await this.client.disconnect()
        this.connected = false
      }

      logInfo(this.reportLogger, 'Клиент отчетов отключен')
    } catch (error) {
      logError(this.reportLogger, error, { operation: 'disconnect' })
      throw error
    }
  }

  async sendReport(htmlContent, options = {}) {
    if (!this.connected) return new ReportResult(false, null, 'Клиент отчетов не подключен')

    try {
      logDebug(this.reportLogger, 'Отправка отчета', {
        contentLength: htmlContent.length,
        parseMode: options.parseMode || 'html'
      })

      const result = await this.client.sendMessage(this.reportCfg.peerId, {
        message: htmlContent,
        parseMode: options.parseMode || 'html',
        disableWebPagePreview: options.disableWebPagePreview ?? true,
        replyTo: this.reportCfg.topicTopMsgId || undefined
      })

      logInfo(this.reportLogger, 'Отчет отправлен успешно', {
        messageId: result.id,
        topicId: this.reportCfg.topicTopMsgId
      })

      return new ReportResult(true, result.id)
    } catch (error) {
      const errorMessage = error.message || 'Неизвестная ошибка'

      logError(this.reportLogger, error, {
        operation: 'send_report',
        contentLength: htmlContent.length,
        error: errorMessage
      })

      return new ReportResult(false, null, errorMessage)
    }
  }

  async isConnected() {
    try {
      return this.connected && (await this.client.connected)
    } catch {
      return false
    }
  }

  async getReportThreadInfo() {
    if (!this.connected) throw new Error('Клиент отчетов не подключен')

    try {
      logDebug(this.reportLogger, 'Получение информации о треде отчетов', {
        peerId: this.reportCfg.peerId,
        topicId: this.reportCfg.topicTopMsgId
      })

      const entity = await this.client.getEntity(this.reportCfg.peerId)

      return { id: entity.id, title: entity.title, participantsCount: entity.participantsCount }
    } catch (error) {
      logError(this.reportLogger, error, {
        operation: 'get_report_thread_info',
        peerId: this.reportCfg.peerId
      })
      return null
    }
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
      logError(this.reportLogger, error, { operation: 'health_check' })
      return false
    }
  }

  getStats() {
    return {
      connected: this.connected,
      peerId: this.reportCfg.peerId,
      topicId: this.reportCfg.topicTopMsgId,
      sessionExists: !!this.config.session
    }
  }
}

export function createReportClient(config, reportCfg, rootLogger) {
  return new ReportClient(config, reportCfg, rootLogger)
}
