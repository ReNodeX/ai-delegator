import { normalizeContact } from '../core/util.js'
import { createOutreachLogger, logDebug, logInfo, logWarning } from '../core/sender-logger.js'

export class ContactDeduper {
  constructor(db, dedupeConfig, rootLogger) {
    this.db = db
    this.dedupeConfig = dedupeConfig
    this.rootLogger = rootLogger

    this.outreachLogger = createOutreachLogger(this.rootLogger, 'dedupe')
    logInfo(this.outreachLogger, 'Дедупликатор контактов инициализирован', {
      normalizeUsernames: dedupeConfig.normalizeUsernames,
      stripAt: dedupeConfig.stripAt,
      lowercase: dedupeConfig.lowercase
    })
  }

  async checkDuplicate(contactKey) {
    try {
      const normalized = normalizeContact(contactKey, this.dedupeConfig),
        normalizedKey = normalized.contactKey

      logDebug(this.outreachLogger, 'Проверка на дубликат', {
        originalKey: contactKey,
        normalizedKey
      })

      const existingContact = await this.db.findContactByKey(normalizedKey)

      if (existingContact) {
        logInfo(this.outreachLogger, 'Дубликат контакта найден', {
          contactKey: normalizedKey,
          existingStatus: existingContact.status,
          existingId: existingContact.id
        })
        return {
          isDuplicate: true,
          existingContact,
          reason: `Контакт уже существует со статусом: ${existingContact.status}`
        }
      }

      logDebug(this.outreachLogger, 'Дубликат не найден', { contactKey: normalizedKey })

      return { isDuplicate: false }
    } catch (error) {
      logWarning(this.outreachLogger, 'Ошибка проверки дубликата', {
        contactKey,
        error: error.message
      })
      return { isDuplicate: false, reason: 'Ошибка проверки статуса дубликата' }
    }
  }

  async registerContact(
    contactKey,
    contactType,
    sourcePeerId,
    sourceMessageId,
    sentText,
    tgUserId,
    leadDescription
  ) {
    const normalized = normalizeContact(contactKey, this.dedupeConfig)

    try {
      const existingContact = await this.db.findContactByKey(normalized.contactKey)

      if (existingContact) {
        logDebug(this.outreachLogger, 'Контакт уже зарегистрирован', {
          contactKey: normalized.contactKey,
          existingId: existingContact.id
        })
        return existingContact
      }

      const newContact = {
          contact_key: normalized.contactKey,
          contact_type: normalized.contactType,
          tg_user_id: tgUserId,
          source_peer_id: sourcePeerId,
          source_message_id: sourceMessageId,
          sent_text: sentText,
          status: 'sent',
          lead_description: leadDescription
        },
        savedContact = await this.db.saveContact(newContact)

      logInfo(this.outreachLogger, 'Новый контакт зарегистрирован', {
        contactKey: normalized.contactKey,
        contactType: normalized.contactType,
        sourceMessageId
      })

      return savedContact
    } catch (error) {
      logWarning(this.outreachLogger, 'Ошибка регистрации контакта', {
        contactKey: normalized.contactKey,
        error: error.message
      })
      throw error
    }
  }

  async updateContactStatus(contactKey, status, reason) {
    const normalized = normalizeContact(contactKey, this.dedupeConfig)

    try {
      await this.db.updateContactStatus(normalized.contactKey, status, reason)
      logDebug(this.outreachLogger, 'Статус контакта обновлен', {
        contactKey: normalized.contactKey,
        newStatus: status,
        reason
      })
    } catch (error) {
      logWarning(this.outreachLogger, 'Ошибка обновления статуса контакта', {
        contactKey: normalized.contactKey,
        status,
        error: error.message
      })
      throw error
    }
  }

  async getContactsForSending(limit = 100) {
    try {
      return await this.db.getContactsForSending(limit)
    } catch (error) {
      logWarning(this.outreachLogger, 'Ошибка получения контактов для отправки', {
        limit,
        error: error.message
      })
      return []
    }
  }

  async getContactStats() {
    try {
      return await this.db.getContactStats()
    } catch (error) {
      logWarning(this.outreachLogger, 'Ошибка получения статистики контактов', {
        error: error.message
      })
      return { total: 0, sent: 0, skipped: 0, failed: 0 }
    }
  }

  normalizeForCheck(contact) {
    const normalized = normalizeContact(contact, this.dedupeConfig)
    return normalized.contactKey
  }
}

export function createContactDeduper(db, dedupeConfig, rootLogger) {
  return new ContactDeduper(db, dedupeConfig, rootLogger)
}
