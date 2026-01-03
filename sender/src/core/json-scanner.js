import { readFileSync, existsSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { logInfo, logWarning, logError } from './sender-logger.js'
import { parseLeadLink } from '../inbox/parseLeadLink.js'
import { fetchOriginalMessage } from '../telegram/fetchOriginal.js'
import { extractAuthorUsernameFromMessage } from '../inbox/extractAuthor.js'
import { resolveSenderLink } from '../telegram/resolveSenderLink.js'

const __filename = fileURLToPath(import.meta.url),
  __dirname = dirname(__filename),
  SENDER_ROOT = join(__dirname, '..', '..')

const scannerConfig = {
  jsonFilePath: join(SENDER_ROOT, '..', 'messages_for_sender.json'),
  progressFilePath: join(SENDER_ROOT, 'json_scanner_progress.json'),
  databasePath: join(SENDER_ROOT, 'database.json'),
  sentContactsPath: join(SENDER_ROOT, 'sent_contacts.json'),
  scanIntervalMs: 30000,
  targetPeerId: -1003011880842
}

const DENY_SOURCES = new Set([
  'frilans_chatik',
  '@frilans_chatik',
  'freelance_chatik0',
  '@freelance_chatik0'
])

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
  'seo_jobs'
]

export class JsonScanner {
  constructor(config, logger) {
    this.config = config
    this.logger = logger
    this.jsonFilePath = scannerConfig.jsonFilePath
    this.progressFilePath = scannerConfig.progressFilePath
    this.databasePath = scannerConfig.databasePath
    this.sentContactsPath = scannerConfig.sentContactsPath
    this.lastProcessedId = 0
    this.isRunning = false
    this.onContactFound = null
    this.parserClient = null
    this.denySources = DENY_SOURCES
    this.sourceStats = {}

    this.loadLastProcessedId()
    logInfo(this.logger, 'JSON сканер создан', {
      jsonFilePath: this.jsonFilePath,
      databasePath: this.databasePath,
      sentContactsPath: this.sentContactsPath,
      lastProcessedId: this.lastProcessedId
    })
  }

  setContactFoundHandler(handler) {
    this.onContactFound = handler
  }

  setParserClient(parserClient) {
    this.parserClient = parserClient
  }

  async start(contactFoundCallback) {
    if (this.isRunning) {
      logWarning(this.logger, 'JSON сканер уже запущен')
      return
    }

    if (contactFoundCallback) this.onContactFound = contactFoundCallback
    this.isRunning = true
    logInfo(this.logger, 'Начинаю сканирование JSON файла парсера')

    await this.performScan()
    this.scanInterval = setInterval(async () => {
      if (this.isRunning) await this.performScan()
    }, scannerConfig.scanIntervalMs)

    logInfo(this.logger, 'JSON сканер успешно запущен')
  }

  async stop() {
    this.isRunning = false
    if (this.scanInterval) {
      clearInterval(this.scanInterval)
      this.scanInterval = null
    }
    logInfo(this.logger, 'JSON сканер остановлен')
  }

  async performScan() {
    try {
      logInfo(this.logger, 'Ищу новые сообщения', { lastProcessedId: this.lastProcessedId })

      if (!existsSync(this.jsonFilePath)) {
        logInfo(this.logger, 'JSON файл не найден', { filePath: this.jsonFilePath })
        return
      }

      const data = JSON.parse(readFileSync(this.jsonFilePath, 'utf8')),
        messages = data.messages || [],
        newMessages = messages.filter((msg) => msg.id > this.lastProcessedId)

      if (newMessages.length === 0) {
        logInfo(this.logger, 'Новых сообщений не найдено')
        return
      }

      logInfo(this.logger, `Обнаружено ${newMessages.length} новых сообщений`)
      let contactsFound = 0

      for (const message of newMessages) {
        const src = (message.sourcePeerName || 'Unknown').toLowerCase()
        if (!this.sourceStats[src])
          this.sourceStats[src] = {
            total: 0,
            contacts_added: 0,
            duplicates: 0,
            skips: { deny_source: 0, no_username: 0, no_contact_found: 0 }
          }
        this.sourceStats[src].total += 1

        const srcName = (message.sourcePeerName || '').toLowerCase(),
          hasDeniedSource = Array.from(this.denySources).some((s) => srcName.includes(s)),
          textHasDeniedLink =
            typeof message.fullContent === 'string' &&
            /(?:https?:\/\/)?t\.me\/(?:c\/)?(?:frilans_chatik|freelance_chatik0)\b/i.test(
              message.fullContent
            )

        if (hasDeniedSource || textHasDeniedLink) {
          logInfo(this.logger, 'Источник в deny-листе', { messageId: message.id })
          this.lastProcessedId = message.id
          this.sourceStats[src].skips.deny_source += 1
          continue
        }

        const textContacts = this.extractContactsFromText(message.fullContent)
        let authorContact = this.extractAuthorFromMessageData(message)
        if (!authorContact) authorContact = this.extractAuthorContact(message)

        let allContacts = [...textContacts, ...(authorContact ? [authorContact] : [])]

        if (allContacts.length === 0) allContacts = await this.extractFromLink(message, src)

        if (allContacts.length > 0) {
          for (const contact of allContacts) {
            if (this.onContactFound) {
              const isDuplicate = await this.checkIfContactExists(contact.contact_key)
              if (isDuplicate) {
                logInfo(this.logger, `Дубликат ${contact.contact_key}`)
                this.sourceStats[src].duplicates += 1
                continue
              }

              await this.onContactFound({
                ...contact,
                source_message_id: message.sourceMessageId.toString(),
                lead_description: message.fullContent,
                json_message_id: message.id,
                source_peer_name: message.sourcePeerName,
                category: message.category,
                confidence: message.confidence
              })
              contactsFound++
              this.sourceStats[src].contacts_added += 1
            }
          }
        }

        this.lastProcessedId = message.id
      }

      this.saveLastProcessedId()
      logInfo(this.logger, 'Сканирование завершено', {
        messagesProcessed: newMessages.length,
        contactsFound
      })
    } catch (error) {
      logError(this.logger, 'Ошибка при сканировании', { error: error.message })
    }
  }

  async extractFromLink(message, src) {
    const linkParsed = parseLeadLink(message.fullContent)
    if (!linkParsed || !this.parserClient) return []

    try {
      const fetched = await fetchOriginalMessage(this.parserClient, linkParsed)
      if (!fetched?.message) return []

      const senderLink = await resolveSenderLink(this.parserClient, fetched.message),
        denyList = Array.isArray(this.config?.denyUsernames) ? this.config.denyUsernames : [],
        result = await extractAuthorUsernameFromMessage(
          this.parserClient,
          fetched.message,
          denyList
        )

      if (result?.username) {
        const isDuplicate = await this.checkIfContactExists(result.username)
        if (!isDuplicate)
          return [
            {
              id: Date.now() + Math.random() * 1000,
              contact_key: result.username,
              contact_type: 'username',
              tg_user_id: null,
              source_peer_id: scannerConfig.targetPeerId,
              sent_text: '',
              sent_at: null,
              status: 'pending',
              reason: null,
              source: 'link_author',
              confidence: 0.9,
              sender_link: senderLink?.link || null
            }
          ]
      }

      const originalText = (fetched.message.message || fetched.message.text || '').toString(),
        inlineContacts = this.extractContactsFromText(originalText)
      if (inlineContacts.length > 0) {
        const picked = inlineContacts[0],
          isDuplicateInline = await this.checkIfContactExists(picked.contact_key)
        if (!isDuplicateInline)
          return [
            {
              ...picked,
              source_peer_id: fetched.peerId,
              source: 'link_inline_username',
              confidence: 0.85,
              sender_link: senderLink?.link || null
            }
          ]
      }
    } catch (e) {
      logError(this.logger, 'Ошибка получения автора по ссылке', {
        messageId: message.id,
        error: e.message
      })
    }

    return []
  }

  extractAuthorFromMessageData(message) {
    try {
      if (!message.authorUsername || message.authorUsername === 'null') return null
      if (
        message.authorUsername.startsWith('user_') &&
        /^\d+$/.test(message.authorUsername.replace('user_', ''))
      )
        return null
      if (message.authorUsername.length < 5 || message.authorUsername.length > 32) return null

      return {
        id: Date.now() + Math.random() * 1000,
        contact_key: message.authorUsername,
        contact_type: 'username',
        tg_user_id: null,
        source_peer_id: scannerConfig.targetPeerId,
        sent_text: '',
        sent_at: null,
        status: 'pending',
        reason: null,
        source: message.authorSource || 'message_data',
        confidence: 0.9
      }
    } catch {
      return null
    }
  }

  extractAuthorContact(message) {
    try {
      if (message.sourcePeerName && message.sourcePeerName !== 'Unknown') {
        const username = this.extractUsernameFromPeerName(message.sourcePeerName)
        if (username)
          return {
            id: Date.now() + Math.random() * 1000,
            contact_key: username,
            contact_type: 'username',
            tg_user_id: null,
            source_peer_id: scannerConfig.targetPeerId,
            sent_text: '',
            sent_at: null,
            status: 'pending',
            reason: null,
            source: 'message_author',
            confidence: 0.9
          }
      }

      const authorPatterns = [
        /(?:автор|от|отправитель|заказчик)\s*[:\-]?\s*@?([a-zA-Z0-9_]{4,32})/gi,
        /(?:пишите|напишите|свяжитесь)\s*[:\-]?\s*@?([a-zA-Z0-9_]{4,32})/gi,
        /(?:контакт|телеграм|тг|tg)\s*[:\-]?\s*@?([a-zA-Z0-9_]{4,32})/gi
      ]

      for (const pattern of authorPatterns) {
        const match = pattern.exec(message.fullContent)
        if (match) {
          const username = match[1].toLowerCase()
          if (!EXCLUDED_CHANNELS.includes(username) && username.length >= 5)
            return {
              id: Date.now() + Math.random() * 1000,
              contact_key: username,
              contact_type: 'username',
              tg_user_id: null,
              source_peer_id: scannerConfig.targetPeerId,
              sent_text: '',
              sent_at: null,
              status: 'pending',
              reason: null,
              source: 'text_author',
              confidence: 0.8
            }
        }
      }

      return null
    } catch {
      return null
    }
  }

  extractUsernameFromPeerName(peerName) {
    if (!peerName || peerName === 'Unknown') return null
    const cleanName = peerName.replace(/[^\w@]/g, '').toLowerCase()
    if (cleanName.length >= 5 && cleanName.length <= 32 && /^[a-zA-Z0-9_]+$/.test(cleanName))
      return cleanName
    return null
  }

  extractContactsFromText(text) {
    const contacts = []
    if (!text || typeof text !== 'string') return contacts

    const patterns = [
      /@([a-zA-Z0-9_]{4,32})/g,
      /(?:^|[^\/])t\.me\/([a-zA-Z0-9_]{4,32})(?![\/\d])/g,
      /(?:^|[^\/])telegram\.me\/([a-zA-Z0-9_]{4,32})(?![\/\d])/g
    ]

    patterns.forEach((pattern) => {
      let match
      while ((match = pattern.exec(text)) !== null) {
        const username = match[1].toLowerCase()
        if (
          !EXCLUDED_CHANNELS.includes(username) &&
          !contacts.find((c) => c.contact_key === username)
        ) {
          contacts.push({
            id: Date.now() + Math.random() * 1000,
            contact_key: username,
            contact_type: 'username',
            tg_user_id: null,
            source_peer_id: scannerConfig.targetPeerId,
            sent_text: '',
            sent_at: null,
            status: 'pending',
            reason: null
          })
        }
      }
    })

    return contacts
  }

  loadLastProcessedId() {
    try {
      if (existsSync(this.progressFilePath)) {
        const data = JSON.parse(readFileSync(this.progressFilePath, 'utf8'))
        this.lastProcessedId = data.lastProcessedId || 0
      } else {
        this.lastProcessedId = 0
        this.saveLastProcessedId()
      }
    } catch {
      this.lastProcessedId = 0
    }
  }

  saveLastProcessedId() {
    try {
      writeFileSync(
        this.progressFilePath,
        JSON.stringify(
          { lastProcessedId: this.lastProcessedId, lastUpdated: new Date().toISOString() },
          null,
          2
        )
      )
    } catch (error) {
      logError(this.logger, 'Не удалось сохранить прогресс', { error: error.message })
    }
  }

  async checkIfContactExists(contactKey) {
    try {
      const normalizedKey = contactKey.toLowerCase().replace(/^@/, '')

      if (existsSync(scannerConfig.databasePath)) {
        const data = JSON.parse(readFileSync(scannerConfig.databasePath, 'utf8'))
        if (
          data.contacts?.some((c) => {
            const key = (c.contact_key || '').toLowerCase().replace(/^@/, '')
            return key === normalizedKey
          })
        ) {
          logInfo(this.logger, 'Контакт найден в database.json', { contactKey: normalizedKey })
          return true
        }
      }

      if (existsSync(scannerConfig.sentContactsPath)) {
        const sentData = JSON.parse(readFileSync(scannerConfig.sentContactsPath, 'utf8'))
        if (sentData.sent_contacts?.[normalizedKey]) {
          logInfo(this.logger, 'Контакт найден в sent_contacts.json', { contactKey: normalizedKey })
          return true
        }
      }

      return false
    } catch (error) {
      logWarning(this.logger, 'Ошибка проверки дубликата', { contactKey, error: error.message })
      return false
    }
  }

  getStats() {
    return {
      isRunning: this.isRunning,
      lastProcessedId: this.lastProcessedId,
      jsonFilePath: this.jsonFilePath,
      progressFilePath: this.progressFilePath
    }
  }
}

export function createJsonScanner(config, logger) {
  return new JsonScanner(config, logger)
}
