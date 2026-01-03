import fs from 'fs'
import path from 'path'
import { logInfo, logError } from './sender-logger.js'

const checkpointConfig = {
  defaultPath: 'sender_checkpoint.json',
  version: '1.0',
  saveInterval: 5
}

export class CheckpointManager {
  constructor(logger, checkpointPath = checkpointConfig.defaultPath) {
    this.logger = logger
    this.checkpointPath = path.resolve(checkpointPath)
    this.checkpoint = this.loadCheckpoint()
  }

  loadCheckpoint() {
    try {
      if (fs.existsSync(this.checkpointPath)) {
        const data = fs.readFileSync(this.checkpointPath, 'utf8'),
          checkpoint = JSON.parse(data)

        logInfo(this.logger, 'Checkpoint загружен успешно', {
          checkpointPath: this.checkpointPath,
          lastProcessedContact: checkpoint.last_processed_contact,
          processedCount: checkpoint.processed_count,
          lastUpdated: checkpoint.last_updated
        })

        return checkpoint
      }
    } catch (error) {
      logError(this.logger, 'Не удалось загрузить checkpoint', {
        error: error.message,
        checkpointPath: this.checkpointPath
      })
    }

    const newCheckpoint = {
      last_processed_contact: null,
      processed_count: 0,
      session_start: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      version: checkpointConfig.version
    }

    this.saveCheckpoint(newCheckpoint)
    return newCheckpoint
  }

  saveCheckpoint(checkpoint = null) {
    try {
      const dataToSave = checkpoint || this.checkpoint
      dataToSave.last_updated = new Date().toISOString()

      fs.writeFileSync(this.checkpointPath, JSON.stringify(dataToSave, null, 2))

      logInfo(this.logger, 'Checkpoint сохранен успешно', {
        processedCount: dataToSave.processed_count,
        lastProcessedContact: dataToSave.last_processed_contact
      })
    } catch (error) {
      logError(this.logger, 'Не удалось сохранить checkpoint', {
        error: error.message,
        checkpointPath: this.checkpointPath
      })
    }
  }

  updateProgress(contactKey, success = true) {
    this.checkpoint.last_processed_contact = contactKey
    this.checkpoint.processed_count += 1
    this.checkpoint.last_success = success
    this.checkpoint.last_updated = new Date().toISOString()

    if (this.checkpoint.processed_count % checkpointConfig.saveInterval === 0) this.saveCheckpoint()
  }

  markSessionComplete() {
    this.checkpoint.session_end = new Date().toISOString()
    this.checkpoint.completed = true
    this.saveCheckpoint()

    logInfo(this.logger, 'Сессия отмечена как завершенная', {
      processedCount: this.checkpoint.processed_count,
      sessionDuration: new Date() - new Date(this.checkpoint.session_start)
    })
  }

  shouldSkipContact(contactKey) {
    if (!this.checkpoint.last_processed_contact) return false
    return false
  }

  getStats() {
    return {
      processedCount: this.checkpoint.processed_count,
      lastProcessedContact: this.checkpoint.last_processed_contact,
      sessionStart: this.checkpoint.session_start,
      sessionEnd: this.checkpoint.session_end,
      completed: this.checkpoint.completed || false,
      lastUpdated: this.checkpoint.last_updated
    }
  }

  resetForNewSession() {
    this.checkpoint = {
      last_processed_contact: null,
      processed_count: 0,
      session_start: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      version: checkpointConfig.version
    }

    this.saveCheckpoint()

    logInfo(this.logger, 'Checkpoint сброшен для новой сессии')
  }
}

export function createCheckpointManager(logger) {
  return new CheckpointManager(logger)
}
