import { readFileSync, writeFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { logInfo, logError } from './logger.js'

const HASH_ALGO = 'sha256'

export class JsonMessagesDB {
  constructor(filePath = 'messages_for_sender.json', logger) {
    this.filePath = filePath
    this.logger = logger
    this.messages = []
    this.forwardedIndex = new Map()
    this.contentHashIndex = new Set()
    this.loadMessages()
  }

  loadMessages() {
    try {
      if (existsSync(this.filePath)) {
        const data = readFileSync(this.filePath, 'utf8'),
          parsed = JSON.parse(data)
        this.messages = parsed.messages || []
        this.rebuildIndexes()

        logInfo(this.logger, 'БД сообщений загружена', {
          filePath: this.filePath,
          messagesCount: this.messages.length
        })
      } else {
        this.messages = []
        this.saveMessages()

        logInfo(this.logger, 'БД сообщений создана', { filePath: this.filePath })
      }
    } catch (error) {
      logError(this.logger, 'Ошибка загрузки БД сообщений', error, { filePath: this.filePath })
      this.messages = []
    }
  }

  rebuildIndexes() {
    this.forwardedIndex.clear()
    this.contentHashIndex.clear()

    this.messages.forEach((msg) => {
      const key = `${msg.sourcePeerId}_${msg.sourceMessageId}`
      this.forwardedIndex.set(key, true)
      if (msg.contentHash) this.contentHashIndex.add(msg.contentHash)
    })
  }

  isMessageForwarded(peerId, messageId) {
    return this.forwardedIndex.has(`${peerId}_${messageId}`)
  }

  isContentForwarded(contentHash) {
    if (!contentHash) return false
    return this.contentHashIndex.has(contentHash)
  }

  generateContentHash(text) {
    if (!text) return null
    return createHash(HASH_ALGO).update(text).digest('hex')
  }

  saveMessages() {
    try {
      const data = {
        lastUpdated: new Date().toISOString(),
        totalMessages: this.messages.length,
        messages: this.messages
      }

      writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8')
      logInfo(this.logger, 'БД сообщений сохранена', {
        filePath: this.filePath,
        messagesCount: this.messages.length
      })
    } catch (error) {
      logError(this.logger, 'Ошибка сохранения БД сообщений', error, { filePath: this.filePath })
    }
  }

  addMessage(messageData) {
    try {
      const contentHash =
          messageData.contentHash || this.generateContentHash(messageData.originalMessage),
        message = {
          id: Date.now() + Math.random() * 1000,
          timestamp: new Date().toISOString(),
          sourceMessageId: messageData.sourceMessageId,
          sourcePeerId: messageData.sourcePeerId,
          sourcePeerName: messageData.sourcePeerName,
          targetMessageId: messageData.targetMessageId,
          fullContent: messageData.fullContent,
          originalMessage: messageData.originalMessage,
          contentHash,
          decision: messageData.decision,
          confidence: messageData.confidence,
          category: messageData.category,
          contentLength: messageData.contentLength,
          wasTruncated: messageData.wasTruncated || false,
          sentAt: messageData.sentAt || new Date().toISOString(),
          authorUsername: messageData.authorUsername,
          authorDisplayName: messageData.authorDisplayName,
          authorSource: messageData.authorSource
        },
        key = `${message.sourcePeerId}_${message.sourceMessageId}`

      this.forwardedIndex.set(key, true)
      if (contentHash) this.contentHashIndex.add(contentHash)

      this.messages.push(message)
      this.saveMessages()

      logInfo(this.logger, 'Сообщение добавлено в БД', {
        messageId: message.id,
        sourceMessageId: message.sourceMessageId,
        sourcePeerName: message.sourcePeerName,
        contentLength: message.contentLength
      })

      return message.id
    } catch (error) {
      logError(this.logger, 'Ошибка добавления сообщения в БД', error, { messageData })
      return null
    }
  }

  getAllMessages() {
    return this.messages
  }

  getMessagesAfter(lastId = 0) {
    return this.messages.filter((msg) => msg.id > lastId)
  }

  getStats() {
    return {
      totalMessages: this.messages.length,
      filePath: this.filePath,
      indexedMessages: this.forwardedIndex.size,
      indexedHashes: this.contentHashIndex.size,
      lastUpdated:
        this.messages.length > 0
          ? Math.max(...this.messages.map((m) => new Date(m.timestamp).getTime()))
          : null
    }
  }

  async close() {
    this.saveMessages()
  }
}
