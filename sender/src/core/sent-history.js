import fs from 'fs'
import path from 'path'
import { logInfo, logWarning, logError } from './sender-logger.js'

const historyConfig = {
  defaultDbPath: 'sent_contacts.json'
}

export class SentHistory {
  constructor(logger, dbPath = historyConfig.defaultDbPath) {
    this.logger = logger
    this.dbPath = path.resolve(dbPath)
    this.sentContacts = {}

    this.loadHistory()

    logInfo(this.logger, 'Менеджер истории отправленных инициализирован', {
      dbPath: this.dbPath,
      loadedContacts: Object.keys(this.sentContacts).length
    })
  }

  loadHistory() {
    try {
      if (fs.existsSync(this.dbPath)) {
        const data = fs.readFileSync(this.dbPath, 'utf8'),
          parsed = JSON.parse(data)
        this.sentContacts = parsed.sent_contacts || {}

        logInfo(this.logger, 'История отправленных загружена успешно', {
          contactsCount: Object.keys(this.sentContacts).length
        })
      } else {
        this.sentContacts = {}
        this.saveHistory()

        logInfo(this.logger, 'Создан новый файл истории отправленных', { dbPath: this.dbPath })
      }
    } catch (error) {
      logError(this.logger, 'Не удалось загрузить историю отправленных', {
        error: error.message,
        dbPath: this.dbPath
      })
      this.sentContacts = {}
    }
  }

  saveHistory() {
    try {
      const data = {
          sent_contacts: this.sentContacts,
          last_updated: new Date().toISOString(),
          total_contacts: Object.keys(this.sentContacts).length
        },
        jsonString = JSON.stringify(
          data,
          (key, value) => {
            if (typeof value === 'bigint') return value.toString()
            return value
          },
          2
        )

      fs.writeFileSync(this.dbPath, jsonString, 'utf8')

      logInfo(this.logger, 'История отправленных сохранена успешно', {
        contactsCount: Object.keys(this.sentContacts).length
      })
    } catch (error) {
      logError(this.logger, 'Не удалось сохранить историю отправленных', {
        error: error.message,
        dbPath: this.dbPath
      })
    }
  }

  isAlreadySent(contactKey) {
    const normalizedKey = this.normalizeContactKey(contactKey),
      contact = this.sentContacts[normalizedKey]

    return !!(contact && (contact.count > 0 || contact.marked_as_processed))
  }

  getSentInfo(contactKey) {
    const normalizedKey = this.normalizeContactKey(contactKey)
    return this.sentContacts[normalizedKey] || null
  }

  recordSent(contactKey, sourceMessageId) {
    const normalizedKey = this.normalizeContactKey(contactKey),
      now = new Date().toISOString()

    if (this.sentContacts[normalizedKey]) {
      this.sentContacts[normalizedKey].last_sent = now
      this.sentContacts[normalizedKey].count += 1
      this.sentContacts[normalizedKey].source_message_ids.push(sourceMessageId)
    } else {
      this.sentContacts[normalizedKey] = {
        first_sent: now,
        last_sent: now,
        count: 1,
        source_message_ids: [sourceMessageId]
      }
    }

    this.saveHistory()

    logInfo(this.logger, 'Записана отправка сообщения контакту', {
      contactKey: normalizedKey,
      sourceMessageId,
      totalSentToContact: this.sentContacts[normalizedKey].count
    })
  }

  normalizeContactKey(contactKey) {
    if (!contactKey) return ''

    let normalized = contactKey.toString().toLowerCase().trim()
    if (normalized.startsWith('@')) normalized = normalized.substring(1)

    return normalized
  }

  getStats() {
    const contacts = Object.values(this.sentContacts),
      totalSent = contacts.reduce((sum, contact) => sum + contact.count, 0)

    return {
      uniqueContacts: Object.keys(this.sentContacts).length,
      totalMessages: totalSent,
      oldestSent:
        contacts.length > 0
          ? Math.min(...contacts.map((c) => new Date(c.first_sent).getTime()))
          : null,
      newestSent:
        contacts.length > 0
          ? Math.max(...contacts.map((c) => new Date(c.last_sent).getTime()))
          : null
    }
  }

  clearHistory() {
    this.sentContacts = {}
    this.saveHistory()

    logWarning(this.logger, 'История отправленных очищена', { dbPath: this.dbPath })
  }
}

export function createSentHistory(logger, dbPath) {
  return new SentHistory(logger, dbPath)
}
