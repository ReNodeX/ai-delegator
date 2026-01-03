import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const dbConfig = {
  preferredPath: join(process.cwd(), 'sender', 'database.json'),
  fallbackPath: join(process.cwd(), 'database.json')
}

const PERMANENT_FAILURE_PATTERNS = [
  'Cannot find any entity corresponding to',
  'USER_DEACTIVATED',
  'INPUT_USER_DEACTIVATED',
  'CHAT_WRITE_FORBIDDEN',
  '403'
]

export class JsonDatabase {
  constructor(config, rootLogger) {
    this.config = config
    this.rootLogger = rootLogger
    this.dbPath = existsSync(dbConfig.preferredPath)
      ? dbConfig.preferredPath
      : existsSync(dbConfig.fallbackPath)
        ? dbConfig.fallbackPath
        : dbConfig.preferredPath
    this.data = this.loadData()
    this.dbLogger = this.rootLogger.child({ category: 'json-db' })
    this.dbLogger.info('JSON база данных инициализирована', { dbPath: this.dbPath })
  }

  loadData() {
    try {
      const content = readFileSync(this.dbPath, 'utf-8'),
        data = JSON.parse(content)

      if (data.progress) {
        Object.values(data.progress).forEach((progress) => {
          if (progress.last_processed_msg_id && typeof progress.last_processed_msg_id === 'string')
            progress.last_processed_msg_id = BigInt(progress.last_processed_msg_id)
        })
      }

      if (data.contacts) {
        data.contacts.forEach((contact) => {
          if (contact.source_message_id && typeof contact.source_message_id === 'string')
            contact.source_message_id = BigInt(contact.source_message_id)
          if (contact.source_peer_id && typeof contact.source_peer_id === 'string')
            contact.source_peer_id = BigInt(contact.source_peer_id)
        })
      }

      return data
    } catch {
      return { contacts: [], progress: {}, stats: { total: 0, sent: 0, skipped: 0, failed: 0 } }
    }
  }

  saveData() {
    try {
      const serializedData = JSON.stringify(
        this.data,
        (key, value) => {
          if (typeof value === 'bigint') return value.toString()
          return value
        },
        2
      )

      writeFileSync(this.dbPath, serializedData, 'utf-8')
      this.dbLogger.debug('Данные сохранены в JSON файл')
    } catch (error) {
      this.dbLogger.error('Не удалось сохранить данные', { error: error.message })
      throw error
    }
  }

  async migrate() {
    this.dbLogger.info('Миграция JSON базы данных завершена (no-op)')
  }

  async findContactByKey(contactKey) {
    return this.data.contacts.find((contact) => contact.contact_key === contactKey) || null
  }

  async saveContact(contact) {
    const newContact = {
      id: Date.now(),
      contact_key: contact.contact_key,
      contact_type: contact.contact_type,
      tg_user_id: contact.tg_user_id || null,
      source_peer_id: contact.source_peer_id,
      source_message_id: contact.source_message_id,
      sent_text: contact.sent_text,
      sent_at: contact.sent_at || new Date().toISOString(),
      status: contact.status,
      reason: contact.reason || null,
      lead_description: contact.lead_description || null
    }

    this.data.contacts.push(newContact)
    this.data.stats.total++
    this.saveData()

    this.dbLogger.debug('Контакт сохранен', {
      contactKey: contact.contact_key,
      status: contact.status
    })
    return newContact
  }

  async updateContactStatus(contactKey, status, reason) {
    const contact = this.data.contacts.find((c) => c.contact_key === contactKey)
    if (!contact) return null

    contact.status = status
    contact.reason = reason || null
    if (status === 'sent') contact.sent_at = new Date().toISOString()

    if (status === 'sent') this.data.stats.sent++
    else if (status === 'skipped') this.data.stats.skipped++
    else if (status === 'failed') this.data.stats.failed++

    this.saveData()
    this.dbLogger.debug('Статус контакта обновлен', { contactKey, status, reason })
    return contact
  }

  async getProgress(peerId) {
    return this.data.progress[peerId] || null
  }

  async saveProgress(progress) {
    this.data.progress[progress.peer_id] = {
      peer_id: progress.peer_id,
      last_processed_msg_id: progress.last_processed_msg_id,
      updated_at: new Date().toISOString()
    }

    this.saveData()
    this.dbLogger.debug('Прогресс сохранен', { peerId: progress.peer_id })
    return this.data.progress[progress.peer_id]
  }

  async getContactStats() {
    return { ...this.data.stats }
  }

  async getContactsForSending(limit = 100, offset = 0) {
    return this.data.contacts
      .filter((contact) => contact.status === 'pending')
      .sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at))
      .slice(offset, offset + limit)
  }

  async requeueFailed(limit = 10) {
    let updated = 0,
      removed = 0

    for (const contact of this.data.contacts) {
      if (updated >= limit) break
      if (contact.status === 'failed') {
        const isPermanentFailure =
          contact.reason && PERMANENT_FAILURE_PATTERNS.some((p) => contact.reason.includes(p))

        if (isPermanentFailure) {
          const index = this.data.contacts.indexOf(contact)
          if (index > -1) {
            this.data.contacts.splice(index, 1)
            removed++
            this.dbLogger.info('Удален несуществующий контакт', {
              contactKey: contact.contact_key,
              reason: contact.reason
            })
          }
        } else {
          contact.status = 'pending'
          contact.reason = null
          updated++
        }
      }
    }

    if (updated > 0 || removed > 0) {
      this.saveData()
      this.dbLogger.info('Неудачные контакты переставлены в очередь', { count: updated, removed })
    }
    return updated
  }

  addContact(contact) {
    try {
      const contactId = `contact_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        newContact = {
          id: contactId,
          contact_key: contact.contact_key,
          contact_type: contact.contact_type || 'username',
          tg_user_id: contact.tg_user_id || null,
          source_peer_id: contact.source_peer_id || -1003011880842,
          source_message_id: contact.source_message_id || '0',
          sent_text: contact.sent_text || '',
          sent_at: contact.sent_at || null,
          status: contact.status || 'pending',
          reason: contact.reason || null,
          lead_description: contact.lead_description || '',
          json_message_id: contact.json_message_id || null,
          source_peer_name: contact.source_peer_name || '',
          category: contact.category || '',
          confidence: contact.confidence || 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }

      this.data.contacts.push(newContact)
      this.data.stats.total = this.data.contacts.length
      this.data.stats.pending = this.data.contacts.filter((c) => c.status === 'pending').length
      this.saveData()

      this.dbLogger.info('Контакт добавлен успешно', { contactId, contactKey: contact.contact_key })
      return contactId
    } catch (error) {
      this.dbLogger.error('Не удалось добавить контакт', {
        error: error.message,
        contact: contact.contact_key
      })
      throw error
    }
  }

  async close() {
    this.dbLogger.info('Соединение с JSON базой данных закрыто')
  }

  async healthCheck() {
    try {
      this.loadData()
      return true
    } catch (error) {
      this.dbLogger.error('Проверка состояния не пройдена', { error: error.message })
      return false
    }
  }
}

export function createDatabase(config, rootLogger) {
  return new JsonDatabase(config, rootLogger)
}
