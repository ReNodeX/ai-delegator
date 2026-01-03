import { isInWorkWindow } from '../core/sender-time.js'
import { createOutreachLogger, logDebug, logInfo, logWarning } from '../core/sender-logger.js'

const queueConfig = {
  defaultIntervalMs: 5000,
  defaultPriority: 1,
  maxAttempts: 3,
  cleanupThresholdMs: 24 * 60 * 60 * 1000,
  retryMultiplierMs: 5000,
  defaultTaskLimit: 50
}

export class OutreachQueue {
  constructor(sender, config, rootLogger) {
    this.sender = sender
    this.config = config
    this.rootLogger = rootLogger

    this.outreachLogger = createOutreachLogger(this.rootLogger, 'queue')
    this.tasks = new Map()
    this.isProcessing = false
    this.shouldStop = false
    this.processingInterval = null

    logInfo(this.outreachLogger, 'Очередь outreach инициализирована')
  }

  async startProcessing(intervalMs = queueConfig.defaultIntervalMs) {
    if (this.isProcessing) throw new Error('Очередь уже обрабатывается')

    this.isProcessing = true
    this.shouldStop = false

    logInfo(this.outreachLogger, 'Запуск обработки очереди', { intervalMs })

    this.processingInterval = setInterval(async () => {
      try {
        await this.processQueue()
      } catch (error) {
        logWarning(this.outreachLogger, 'Ошибка обработки очереди', { error: error.message })
      }
    }, intervalMs)

    this.processQueue()
  }

  stopProcessing() {
    logInfo(this.outreachLogger, 'Остановка обработки очереди')
    this.shouldStop = true

    if (this.processingInterval) {
      clearInterval(this.processingInterval)
      this.processingInterval = undefined
    }

    this.isProcessing = false
  }

  isProcessingQueue() {
    return this.isProcessing
  }

  addTask(contact, message, priority = queueConfig.defaultPriority) {
    const taskId = `${contact.contactKey}:${message.id}:${Date.now()}`,
      task = {
        id: taskId,
        contactKey: contact.contactKey,
        contactType: contact.contactType,
        sourcePeerId: message.peerId,
        sourceMessageId: message.id,
        priority,
        createdAt: new Date(),
        status: 'pending',
        attempts: 0,
        maxAttempts: queueConfig.maxAttempts
      }

    this.tasks.set(taskId, task)

    logInfo(this.outreachLogger, 'Задача добавлена в очередь', {
      taskId,
      contactKey: contact.contactKey,
      priority,
      queueDepth: this.tasks.size
    })

    return taskId
  }

  async addToSender(contact, message) {
    try {
      await this.sender.addSendTask(
        contact.contactKey,
        contact.contactType,
        message.peerId,
        message.id,
        message.description || message.text
      )

      logDebug(this.outreachLogger, 'Задача добавлена в sender', {
        contactKey: contact.contactKey,
        sourceMessageId: message.id,
        descriptionLength: (message.description || message.text)?.length || 0
      })
    } catch (error) {
      logWarning(this.outreachLogger, 'Не удалось добавить задачу в sender', {
        contactKey: contact.contactKey,
        sourceMessageId: message.id,
        error: error.message
      })
    }
  }

  async processQueue() {
    const result = {
      tasksAdded: 0,
      tasksProcessed: 0,
      tasksFailed: 0,
      tasksSkipped: 0,
      queueDepth: this.tasks.size
    }

    if (!isInWorkWindow(this.config.sender.window, this.config.sender.timezone)) {
      logDebug(this.outreachLogger, 'Вне рабочего окна, пропускаем обработку очереди')
      return result
    }

    const pendingTasks = Array.from(this.tasks.values())
      .filter((task) => task.status === 'pending')
      .sort((a, b) => b.priority - a.priority)

    for (const task of pendingTasks) {
      if (this.shouldStop) break

      try {
        task.status = 'processing'
        task.attempts++

        logDebug(this.outreachLogger, 'Обработка задачи очереди', {
          taskId: task.id,
          contactKey: task.contactKey,
          attempt: task.attempts
        })

        await this.addToSender(
          {
            contactKey: task.contactKey,
            contactType: task.contactType,
            originalContact: task.contactKey,
            position: 0,
            confidence: 1
          },
          {
            id: task.sourceMessageId,
            peerId: task.sourcePeerId,
            text: '',
            date: task.createdAt,
            contacts: []
          }
        )

        task.status = 'completed'
        this.tasks.delete(task.id)

        result.tasksProcessed++

        logDebug(this.outreachLogger, 'Задача обработана успешно', {
          taskId: task.id,
          contactKey: task.contactKey
        })
      } catch (error) {
        logWarning(this.outreachLogger, 'Обработка задачи не удалась', {
          taskId: task.id,
          contactKey: task.contactKey,
          attempt: task.attempts,
          error: error.message
        })

        if (task.attempts < task.maxAttempts) {
          task.status = 'pending'
          task.nextRetryAt = new Date(Date.now() + task.attempts * queueConfig.retryMultiplierMs)
        } else {
          task.status = 'failed'
          result.tasksFailed++
        }
      }
    }

    this.cleanupFailedTasks()

    return result
  }

  cleanupFailedTasks() {
    const cutoffTime = Date.now() - queueConfig.cleanupThresholdMs

    for (const [taskId, task] of this.tasks.entries()) {
      if (task.status === 'failed' && task.createdAt.getTime() < cutoffTime) {
        this.tasks.delete(taskId)
        logDebug(this.outreachLogger, 'Очищена старая неудачная задача', {
          taskId,
          contactKey: task.contactKey,
          ageHours: (Date.now() - task.createdAt.getTime()) / (60 * 60 * 1000)
        })
      }
    }
  }

  getStats() {
    const tasks = Array.from(this.tasks.values()),
      pendingTasks = tasks.filter((t) => t.status === 'pending'),
      processingTasks = tasks.filter((t) => t.status === 'processing'),
      completedTasks = tasks.filter((t) => t.status === 'completed'),
      failedTasks = tasks.filter((t) => t.status === 'failed'),
      oldestTask =
        pendingTasks.length > 0
          ? pendingTasks.reduce((oldest, task) =>
              task.createdAt < oldest.createdAt ? task : oldest
            ).createdAt
          : undefined,
      newestTask =
        pendingTasks.length > 0
          ? pendingTasks.reduce((newest, task) =>
              task.createdAt > newest.createdAt ? task : newest
            ).createdAt
          : undefined

    return {
      isProcessing: this.isProcessing,
      queueDepth: this.tasks.size,
      pendingTasks: pendingTasks.length,
      processingTasks: processingTasks.length,
      completedTasks: completedTasks.length,
      failedTasks: failedTasks.length,
      oldestTask,
      newestTask
    }
  }

  getTasks(limit = queueConfig.defaultTaskLimit) {
    return Array.from(this.tasks.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
  }
}

export function createOutreachQueue(sender, config, rootLogger) {
  return new OutreachQueue(sender, config, rootLogger)
}
