import { createUniqueId, sha256 } from '../core/util.js'
import { createOutreachLogger, logDebug, logInfo } from '../core/sender-logger.js'
import { createOpenAIClient } from '../core/openai.js'

export class MessageComposer {
  constructor(messageConfig, rootLogger) {
    this.messageConfig = messageConfig
    this.rootLogger = rootLogger
    this.outreachLogger = createOutreachLogger(this.rootLogger, 'composer')
    this.messageCache = new Map()

    logInfo(this.outreachLogger, 'Компоновщик сообщений инициализирован', {
      templateId: messageConfig.templateId,
      uniqueVariantSalt: messageConfig.uniqueVariantSalt
    })
  }

  async composeMessage(contactKey, leadContext, openaiConfig, rootLogger) {
    const variantId = this.generateVariantId(contactKey),
      aiResponse = await this.generateWithAI(leadContext, openaiConfig, rootLogger)

    if (!aiResponse.success || !aiResponse.text)
      throw new Error(`AI генерация не удалась: ${aiResponse.error || 'Текст не возвращен'}`)

    logDebug(this.outreachLogger, 'AI сообщение сгенерировано успешно', {
      contactKey,
      variantId,
      textLength: aiResponse.text.length,
      tokens: aiResponse.usage
    })

    return {
      text: aiResponse.text,
      templateId: 'ai_generated',
      variantId,
      variables: {
        description: leadContext.description,
        category: leadContext.category,
        tokens: aiResponse.usage
      }
    }
  }

  getTemplate() {
    throw new Error('Шаблоны отключены - только AI режим')
  }

  generateVariantId(contactKey) {
    const salt = this.messageConfig.uniqueVariantSalt ? sha256(contactKey).substring(0, 8) : ''
    return createUniqueId(`${this.messageConfig.templateId}:${contactKey}`, salt)
  }

  async generateWithAI(leadContext, openaiConfig, rootLogger) {
    try {
      const openaiClient = createOpenAIClient(openaiConfig.apiKey, rootLogger),
        result = await openaiClient.generateOutreachMessage(leadContext, openaiConfig)

      if (!result.success) throw new Error(result.error || 'AI генерация не удалась')

      return { success: true, text: result.text, usage: result.usage }
    } catch (error) {
      return { success: false, error: error.message }
    }
  }

  generateVariant(baseTemplate, contactKey, templateData) {
    let text = baseTemplate

    if (templateData) {
      for (const [key, value] of Object.entries(templateData))
        text = text.replace(new RegExp(`{${key}}`, 'g'), String(value))
    }

    text = this.addRandomVariations(text, contactKey)

    return { id: this.generateVariantId(contactKey), text, variables: templateData }
  }

  addRandomVariations(text) {
    const variations = [
      (t) => {
        const emojis = ['💼', '🚀', '✨', '🔥', '💡', '⚡']
        return t + '\n\n' + emojis[Math.floor(Math.random() * emojis.length)]
      },
      (t) => {
        const greetings = ['Здравствуйте', 'Приветствую', 'Добрый день']
        return t.replace('Здравствуйте', greetings[Math.floor(Math.random() * greetings.length)])
      },
      (t) => {
        const closings = ['С уважением', 'С наилучшими пожеланиями', 'Ждем вашего ответа']
        return t + '\n\n' + closings[Math.floor(Math.random() * closings.length)]
      }
    ]

    const numVariations = Math.floor(Math.random() * 2) + 1
    let modifiedText = text

    for (let i = 0; i < numVariations; i++)
      modifiedText = variations[Math.floor(Math.random() * variations.length)](modifiedText)

    return modifiedText
  }

  getAvailableTemplates() {
    return ['v1', 'v2', 'v3', 'lead_v1', 'lead_v2', 'lead_v3']
  }

  createLeadContext(description, contactKey, sourceMessageId, category) {
    return { description, contactKey, sourceMessageId, category }
  }

  async previewMessage(contactKey, leadContext, aiApiKey, rootLogger) {
    const result = await this.composeMessage(contactKey, leadContext, aiApiKey, rootLogger)
    return result.text
  }

  clearCache() {
    this.messageCache.clear()
    logDebug(this.outreachLogger, 'Кеш сообщений очищен')
  }
}

export function createMessageComposer(messageConfig, rootLogger) {
  return new MessageComposer(messageConfig, rootLogger)
}
