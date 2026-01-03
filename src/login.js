#!/usr/bin/env node

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url),
  __dirname = dirname(__filename)

dotenv.config({ path: join(__dirname, '../.env') })

const loginConfig = {
  apiHashDisplayLength: 8,
  envFilePath: join(__dirname, '../.env'),
  senderEnvFilePath: join(__dirname, '../sender/.env'),
  connectionRetries: 5
}

class TelegramLogin {
  constructor() {
    this.apiId = parseInt(process.env.TG_API_ID, 10)
    this.apiHash = process.env.TG_API_HASH
    this.client = null
  }

  async initialize() {
    console.log('=== Telegram Login ===')
    console.log('API ID:', this.apiId)
    console.log('API Hash:', this.apiHash?.substring(0, loginConfig.apiHashDisplayLength) + '...')
    console.log('')

    if (!this.apiId || !this.apiHash) {
      console.error('TG_API_ID и TG_API_HASH должны быть указаны в .env файле')
      process.exit(1)
    }
  }

  async login() {
    try {
      const session = new StringSession('')

      this.client = new TelegramClient(session, this.apiId, this.apiHash, {
        connectionRetries: loginConfig.connectionRetries
      })

      await this.client.start({
        phoneNumber: async () => await this.askInput('Введите номер телефона: '),
        password: async () => await this.askInput('Введите пароль 2FA: '),
        phoneCode: async () => await this.askInput('Введите код из Telegram: '),
        onError: (err) => console.log(err)
      })

      console.log('Вы успешно подключены.')
      const sessionString = this.client.session.save()
      console.log('Session string:', sessionString)

      await this.saveSession(sessionString)
    } catch (error) {
      console.error('Ошибка входа:\n', error.message)
      throw error
    }
  }

  updateEnvFile(filePath, envKey, sessionString) {
    try {
      let envContent = ''
      if (existsSync(filePath)) envContent = readFileSync(filePath, 'utf8')

      const lines = envContent.split('\n')
      let found = false
      const updatedLines = lines.map((line) => {
        if (line.startsWith(`${envKey}=`)) {
          found = true
          return `${envKey}=${sessionString}`
        }
        return line
      })

      if (!found) updatedLines.push(`${envKey}=${sessionString}`)

      writeFileSync(filePath, updatedLines.join('\n'))
      return true
    } catch {
      return false
    }
  }

  async saveSession(sessionString) {
    try {
      this.updateEnvFile(loginConfig.envFilePath, 'TG_SESSION', sessionString)
      this.updateEnvFile(loginConfig.envFilePath, 'TG_PARSER_SESSION', sessionString)
      this.updateEnvFile(loginConfig.senderEnvFilePath, 'TG_PARSER_SESSION', sessionString)

      console.log('')
      console.log('Сессия сохранена в корневой .env и sender/.env')
      console.log('Теперь можете запустить: npm start')
    } catch (error) {
      console.error('Не удалось сохранить сессию:\n', error.message)
      console.log('')
      console.log('Требуется ручное сохранение. Добавьте это в .env файлы:')
      console.log(`TG_SESSION=${sessionString}`)
      console.log(`TG_PARSER_SESSION=${sessionString}`)
      throw error
    }
  }

  async askInput(question) {
    return new Promise(async (resolve) => {
      const readline = await import('readline'),
        rl = readline.createInterface({ input: process.stdin, output: process.stdout })

      rl.question(question, (answer) => {
        rl.close()
        resolve(answer.trim())
      })
    })
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect()
      console.log('Отключено от Telegram')
    }
  }
}

const login = new TelegramLogin()

try {
  await login.initialize()
  await login.login()
  await login.disconnect()
} catch (error) {
  console.error('Ошибка входа:\n', error.message)
  process.exit(1)
}
