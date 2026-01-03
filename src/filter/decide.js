import { createHash } from 'crypto'
import { logFilterDecide, logAIVerdict, logPostProcessing } from '../core/logger.js'

const deciderConfig = {
  hashAlgo: 'sha256',
  hashDisplayLen: 8,
  maxTextSampleLen: 100,
  defaultConfidence: 0.0,
  highConfidence: 1.0,
  possibleLeadThreshold: 0.5,
  targetGroupIds: [-1003011880842, 3011880842]
}

function extractPeerId(peerId) {
  if (!peerId) return 'unknown'
  if (typeof peerId === 'string' || typeof peerId === 'number') return String(peerId)
  if (peerId.channelId) return String(peerId.channelId)
  if (peerId.chatId) return String(peerId.chatId)
  if (peerId.userId) return String(peerId.userId)
  if (peerId.id) return String(peerId.id)
  return 'unknown'
}

const HARD_DENY_KEYWORDS = [
  '#помогу',
  '#разработка',
  '#дизайн',
  '#таргет',
  '#реклама',
  '#продвижение',
  'помогу',
  'предлагаю',
  'делаю',
  'создаю',
  'настраиваю',
  'занимаюсь',
  'если хотите обсудить детали',
  'жду вас в ЛС',
  'свяжитесь со мной',
  'мой опыт',
  'мои услуги',
  'мои работы',
  'портфолио',
  'freelance',
  'available for hire',
  'hire me',
  'contact me',
  'my rates'
]

export class MessageDecider {
  constructor(filterRules, aiClassifier, config) {
    if (!filterRules) throw new Error('Экземпляр filterRules обязателен')
    if (!aiClassifier) throw new Error('Экземпляр aiClassifier обязателен')
    if (!config) throw new Error('Конфигурация обязательна')

    this.filterRules = filterRules
    this.aiClassifier = aiClassifier
    this.config = config

    this.stats = {
      totalProcessed: 0,
      preFilterDenied: 0,
      aiProcessed: 0,
      aiApproved: 0,
      aiDenied: 0,
      aiPossibleLeads: 0,
      errors: 0,
      startTime: Date.now()
    }

    logFilterDecide.info(
      {
        hasFilterRules: Boolean(this.filterRules),
        hasAIClassifier: Boolean(this.aiClassifier),
        minConfidence: this.aiClassifier.minConfidence
      },
      'message decider инициализирован'
    )
  }

  async processMessage(text, message = {}) {
    const startTime = performance.now()
    this.stats.totalProcessed++

    if (message.peer_id && deciderConfig.targetGroupIds.includes(message.peer_id.id)) {
      this.stats.preFilterDenied++
      logFilterDecide.debug(
        {
          reason: 'target_group_excluded',
          peerId: message.peer_id.id,
          textLength: text?.length || 0
        },
        'сообщение из целевой группы исключено'
      )
      return this.createDecisionResult(
        'denied',
        'pre_filter',
        'Целевая группа исключена',
        deciderConfig.defaultConfidence,
        'other',
        startTime
      )
    }

    const textLower = text.toLowerCase()
    for (const keyword of HARD_DENY_KEYWORDS) {
      if (textLower.includes(keyword.toLowerCase())) {
        this.stats.preFilterDenied++
        logFilterDecide.debug(
          {
            reason: 'hard_deny_keyword',
            keyword,
            textLength: text?.length || 0,
            textSample: text?.substring(0, 100) + '...'
          },
          'сообщение отклонено жестким фильтром'
        )
        return this.createDecisionResult(
          'denied',
          'pre_filter',
          `Жесткое ключевое слово: ${keyword}`,
          deciderConfig.defaultConfidence,
          'other',
          startTime
        )
      }
    }

    if (!text || typeof text !== 'string') {
      logFilterDecide.warn(
        { text, messageId: message?.id, reason: 'неверный текст' },
        'обработка пропущена'
      )
      return this.createErrorResult('Неверный текст')
    }

    const textLength = text.length,
      textSample = text.substring(0, deciderConfig.maxTextSampleLen)

    logFilterDecide.debug(
      { textLength, textSample, messageId: message?.id, peerId: extractPeerId(message?.peerId) },
      'обработка через классификатор'
    )

    try {
      const preFilterResult = this.filterRules.checkMessage(text)
      if (preFilterResult.denied) {
        this.stats.preFilterDenied++
        const durationMs = Math.round(performance.now() - startTime)
        logFilterDecide.info(
          {
            reason: preFilterResult.reason,
            messageId: message?.id,
            peerId: extractPeerId(message?.peerId),
            textSample,
            stage: 'pre_filter',
            durationMs
          },
          'сообщение отклонено pre-filter'
        )

        return {
          decision: 'denied',
          reason: preFilterResult.reason,
          stage: 'pre_filter',
          confidence: deciderConfig.highConfidence,
          category: 'denied',
          textLength
        }
      }

      this.stats.aiProcessed++
      const aiResult = await this.aiClassifier.classify(text),
        aiContext = {
          messageId: message?.id,
          peerId: extractPeerId(message?.peerId),
          peerName: message?.peer?.title || message?.peer?.username || 'Unknown',
          textLength
        }

      logAIVerdict(
        logFilterDecide,
        { ...aiResult, processingTimeMs: Math.round(performance.now() - startTime) },
        aiContext
      )

      if (!aiResult.valid) {
        this.stats.errors++
        const durationMs = Math.round(performance.now() - startTime)
        logFilterDecide.warn(
          {
            reason: aiResult.reason,
            messageId: message?.id,
            peerId: extractPeerId(message?.peerId),
            textSample,
            stage: 'ai_error',
            durationMs
          },
          'AI классификация не удалась'
        )

        return {
          decision: 'denied',
          reason: aiResult.reason,
          stage: 'ai_error',
          confidence: deciderConfig.defaultConfidence,
          category: 'error',
          textLength
        }
      }

      const durationMs = Math.round(performance.now() - startTime)

      if (this.aiClassifier.meetsThreshold(aiResult)) {
        this.stats.aiApproved++

        const approvedResult = {
            decision: 'approved',
            reason: aiResult.reason,
            stage: 'ai_approved',
            confidence: aiResult.confidence,
            category: aiResult.category,
            isLead: true,
            textLength
          },
          postData = {
            messageId: message?.id,
            peerId: extractPeerId(message?.peerId),
            peerName: message?.peer?.title || message?.peer?.username || 'Unknown',
            textLength,
            textSample,
            processingTimeMs: durationMs,
            source: 'live'
          }

        logPostProcessing(logFilterDecide, postData, approvedResult)
        return approvedResult
      }

      const isPossibleLead =
          aiResult.confidence > deciderConfig.possibleLeadThreshold && aiResult.isLead,
        decision = isPossibleLead ? 'possible_lead' : 'denied',
        stage = isPossibleLead ? 'ai_possible_lead' : 'ai_denied'

      isPossibleLead ? this.stats.aiPossibleLeads++ : this.stats.aiDenied++

      const deniedResult = {
          decision,
          reason: isPossibleLead
            ? `Возможный лид с уверенностью ${aiResult.confidence}`
            : `Низкая уверенность: ${aiResult.confidence} < ${this.aiClassifier.minConfidence}`,
          stage,
          confidence: aiResult.confidence,
          category: aiResult.category,
          isLead: isPossibleLead,
          textLength
        },
        postData = {
          messageId: message?.id,
          peerId: extractPeerId(message?.peerId),
          peerName: message?.peer?.title || message?.peer?.username || 'Unknown',
          textLength,
          textSample,
          processingTimeMs: durationMs,
          source: 'live'
        }

      logPostProcessing(logFilterDecide, postData, deniedResult)

      if (
        isPossibleLead &&
        aiResult.confidence > deciderConfig.possibleLeadThreshold &&
        textLength > 50
      ) {
        logFilterDecide.warn(
          {
            messageId: message?.id,
            peerId: extractPeerId(message?.peerId),
            textSample: text?.substring(0, 200) + '...',
            confidence: aiResult.confidence,
            category: aiResult.category,
            reason: aiResult.reason,
            processingTimeMs: durationMs
          },
          'Обнаружен потенциальный лид - рекомендуется ручная проверка'
        )
      }

      return deniedResult
    } catch (error) {
      this.stats.errors++
      const durationMs = Math.round(performance.now() - startTime)

      logFilterDecide.error(
        {
          err: error,
          errorMessage: error.message,
          errorCode: error.code,
          messageId: message?.id,
          peerId: extractPeerId(message?.peerId),
          textLength: text?.length || 0,
          textSample: text?.substring(0, deciderConfig.maxTextSampleLen),
          durationMs
        },
        'ошибка обработки сообщения'
      )

      return this.createErrorResult(`Ошибка обработки: ${error.message}`)
    }
  }

  createErrorResult(reason) {
    return {
      decision: 'denied',
      reason,
      stage: 'error',
      confidence: deciderConfig.defaultConfidence,
      category: 'error',
      isLead: false,
      textLength: 0
    }
  }

  createDecisionResult(decision, stage, reason, confidence, category) {
    return {
      decision,
      reason,
      stage,
      confidence: typeof confidence === 'number' ? confidence : deciderConfig.defaultConfidence,
      category: category || 'other',
      isLead: decision === 'approved',
      textLength: 0
    }
  }

  generateContentHash(text) {
    return createHash(deciderConfig.hashAlgo)
      .update(text || '')
      .digest('hex')
  }

  async shouldProcessMessage(peerId, messageId, contentHash, database) {
    try {
      const isForwarded = await database.isMessageForwarded(peerId, messageId)
      if (isForwarded) {
        logFilterDecide.debug(
          { peerId, messageId, checkType: 'message_id' },
          'сообщение уже переслано (по ID)'
        )
        return false
      }

      const isContentForwarded = await database.isContentForwarded(contentHash)
      if (isContentForwarded) {
        logFilterDecide.debug(
          {
            peerId,
            messageId,
            contentHash: contentHash.substring(0, deciderConfig.hashDisplayLen) + '...',
            checkType: 'content_hash'
          },
          'сообщение уже переслано (по контенту)'
        )
        return false
      }

      return true
    } catch (error) {
      logFilterDecide.error({ err: error, peerId, messageId }, 'ошибка проверки дубликатов')
      return true
    }
  }

  getStats() {
    const { totalProcessed, preFilterDenied, aiProcessed, aiApproved, aiPossibleLeads, errors } =
      this.stats

    return {
      ...this.stats,
      preFilterRate: totalProcessed > 0 ? (preFilterDenied / totalProcessed) * 100 : 0,
      aiProcessRate: totalProcessed > 0 ? (aiProcessed / totalProcessed) * 100 : 0,
      approvalRate: aiProcessed > 0 ? (aiApproved / aiProcessed) * 100 : 0,
      possibleLeadRate: aiProcessed > 0 ? (aiPossibleLeads / aiProcessed) * 100 : 0,
      errorRate: totalProcessed > 0 ? (errors / totalProcessed) * 100 : 0,
      queue: this.aiClassifier.getQueueStats()
    }
  }

  resetStats() {
    this.stats = {
      totalProcessed: 0,
      preFilterDenied: 0,
      aiProcessed: 0,
      aiApproved: 0,
      aiDenied: 0,
      aiPossibleLeads: 0,
      errors: 0,
      startTime: Date.now()
    }
  }

  async testClassification(text) {
    logFilterDecide.info(
      { textSample: text.substring(0, deciderConfig.maxTextSampleLen) + '...' },
      'тестирование классификации'
    )
    const result = await this.processMessage(text)
    logFilterDecide.info({ result }, 'тест классификации завершен')
    return result
  }
}

export function createMessageDecider(filterRules, aiClassifier, config) {
  return new MessageDecider(filterRules, aiClassifier, config)
}
