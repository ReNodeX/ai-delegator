import { Api, TelegramClient } from 'telegram'
import { computeCheck as computePasswordCheck } from 'telegram/Password.js'
import { StringSession } from 'telegram/sessions/index.js'
import readline from 'readline'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url),
  __dirname = dirname(__filename)

dotenv.config({ path: join(__dirname, '../.env') })

const clientConfig = {
  connectionRetries: 5,
  validationRetries: 3,
  useWss: true,
  envFilePath: join(__dirname, '../.env'),
  rootEnvFilePath: join(__dirname, '../../.env')
}

function createReadlineInterface() {
  return readline.createInterface({ input: process.stdin, output: process.stdout })
}

function askQuestion(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())))
}

function getEnvConfig() {
  return {
    parser: {
      apiId: parseInt(process.env.TG_PARSER_API_ID, 10),
      apiHash: process.env.TG_PARSER_API_HASH,
      session: process.env.TG_PARSER_SESSION
    },
    sender: {
      apiId: parseInt(process.env.TG_SENDER_API_ID, 10),
      apiHash: process.env.TG_SENDER_API_HASH,
      session: process.env.TG_SENDER_SESSION
    }
  }
}

function updateEnvFile(filePath, envKey, sessionString) {
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
  } catch (error) {
    console.error(`Не удалось обновить ${filePath}:\n`, error.message)
    return false
  }
}

function updateEnvSession(envKey, sessionString) {
  const senderResult = updateEnvFile(clientConfig.envFilePath, envKey, sessionString),
    rootResult = updateEnvFile(clientConfig.rootEnvFilePath, envKey, sessionString)
  return senderResult && rootResult
}

async function performSenderLogin() {
  const rl = createReadlineInterface()

  try {
    console.log('Вход в аккаунт Telegram Sender')
    console.log('==============================\n')

    const config = getEnvConfig(),
      senderConfig = config.sender

    if (!senderConfig.apiId || !senderConfig.apiHash) {
      console.error('TG_SENDER_API_ID и TG_SENDER_API_HASH должны быть указаны в .env файле')
      return
    }

    console.log('Настройки аккаунта Sender:')
    console.log(`   API ID: ${senderConfig.apiId}`)
    console.log(`   API Hash: ${senderConfig.apiHash.substring(0, 10)}...`)
    console.log('')

    const session = new StringSession(''),
      client = new TelegramClient(session, senderConfig.apiId, senderConfig.apiHash, {
        connectionRetries: clientConfig.connectionRetries,
        useWSS: clientConfig.useWss
      })

    console.log('Подключение к Telegram...')
    await client.connect()
    console.log('Подключено! Введите код верификации.')
    console.log('')

    const phoneNumber = await askQuestion(rl, 'Введите номер телефона (с кодом страны): ')

    if (!phoneNumber) throw new Error('Номер телефона обязателен')

    console.log(`Отправка кода на ${phoneNumber}...`)

    const { phoneCodeHash } = await client.sendCode(
      { apiId: senderConfig.apiId, apiHash: senderConfig.apiHash },
      phoneNumber
    )

    console.log('Код отправлен! Проверьте Telegram.')

    const verificationCode = await askQuestion(rl, 'Введите код верификации: ')

    if (!verificationCode) throw new Error('Код верификации обязателен')

    console.log('Авторизация...')

    try {
      await client.invoke(
        new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode: verificationCode })
      )
    } catch (err) {
      if (err?.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        const twoFactor = await askQuestion(rl, 'Введите пароль 2FA: '),
          pwdInfo = await client.invoke(new Api.account.GetPassword()),
          passwordSrp = await computePasswordCheck(pwdInfo, twoFactor)
        await client.invoke(new Api.auth.CheckPassword({ password: passwordSrp }))
      } else {
        throw err
      }
    }

    const me = await client.getMe()

    console.log('Авторизация успешна!')
    console.log(`Добро пожаловать, ${me.firstName}!`)

    const sessionString = client.session.save()

    if (updateEnvSession('TG_SENDER_SESSION', sessionString))
      console.log('\nСессия сохранена в sender/.env и корневой .env')
    else {
      console.log('\nТребуется ручное сохранение. Добавьте в .env файлы:')
      console.log(`TG_SENDER_SESSION=${sessionString}`)
    }

    await client.disconnect()
    console.log('\nВход завершен.')
  } catch (error) {
    console.error('Ошибка входа:\n', error.message)
  } finally {
    rl.close()
  }
}

async function validateSenderSession() {
  const rl = createReadlineInterface()

  try {
    console.log('Проверка сессии Sender')
    console.log('=========================\n')

    const config = getEnvConfig(),
      senderConfig = config.sender

    if (!senderConfig.session) {
      console.log('Сессия не найдена в .env')
      console.log('Сначала выполните вход: npm run login:sender')
      return
    }

    console.log('Подключение с существующей сессией...')

    const session = new StringSession(senderConfig.session),
      client = new TelegramClient(session, senderConfig.apiId, senderConfig.apiHash, {
        connectionRetries: clientConfig.validationRetries,
        useWSS: clientConfig.useWss
      })

    await client.connect()

    const me = await client.getMe()

    console.log('Сессия валидна!')
    console.log(`Пользователь: ${me.firstName} ${me.lastName || ''}`.trim())
    console.log(`Username: @${me.username || 'не установлен'}`)
    console.log(`User ID: ${me.id}`)

    await client.disconnect()
    console.log('\nПроверка завершена.')
  } catch (error) {
    console.error('Ошибка проверки сессии:\n', error.message)
    console.log('\nСессия недействительна. Выполните вход заново:')
    console.log('   npm run login:sender')
  } finally {
    rl.close()
  }
}

function showHelp() {
  console.log('Инструмент входа Telegram Sender')
  console.log('==========================\n')
  console.log('Использование:')
  console.log('  npm run login:sender           - Интерактивный вход')
  console.log('  npm run login:sender validate  - Проверка существующей сессии\n')
  console.log('Команды:')
  console.log('  login     - Интерактивный вход для получения строки сессии')
  console.log('  validate  - Проверка существующей строки сессии\n')
  console.log('Требования:')
  console.log('  - TG_SENDER_API_ID и TG_SENDER_API_HASH в .env')
  console.log('  - Номер телефона аккаунта Telegram')
  console.log('  - Доступ к коду верификации из Telegram')
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0) await performSenderLogin()
  else if (args[0] === 'validate') await validateSenderSession()
  else if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') showHelp()
  else {
    console.log(`Неизвестная команда: ${args[0]}`)
    console.log('Используйте: npm run login:sender help')
    process.exit(1)
  }
}

const isMain = (() => {
  try {
    const thisFile = fileURLToPath(import.meta.url)
    return process.argv[1] && thisFile === process.argv[1]
  } catch {
    return false
  }
})()

if (isMain) {
  main().catch((error) => {
    console.error('Ошибка:\n', error)
    process.exit(1)
  })
}
