import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import { logTime } from './logger.js'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(customParseFormat)

const timeConfig = {
  defaultTimezone: 'Europe/Berlin',
  timeFormat: 'HH:mm',
  dateFormat: 'DD.MM.YYYY',
  datetimeFormat: 'YYYY-MM-DD HH:mm:ss',
  epochDate: '01.01.1970',
  defaultTime: '00:00'
}

export class TimeManager {
  constructor(tz = timeConfig.defaultTimezone) {
    if (!this.isValidTimezone(tz)) throw new Error(`Неверная временная зона: ${tz}`)
    this.timezone = tz
    logTime.info({ timezone: tz }, 'менеджер времени инициализирован')
  }

  now() {
    return dayjs().tz(this.timezone)
  }

  getCutoffTime(backfillDays) {
    const cutoff = this.now().subtract(backfillDays, 'day')
    logTime.debug(
      {
        backfillDays,
        cutoffTime: cutoff.format(timeConfig.datetimeFormat),
        timezone: this.timezone
      },
      'время отсечения рассчитано'
    )
    return cutoff
  }

  formatTime(time) {
    if (!time) {
      logTime.warn({ time }, 'неверное время для форматирования')
      return timeConfig.defaultTime
    }
    return dayjs(time).tz(this.timezone).format(timeConfig.timeFormat)
  }

  formatDate(date) {
    if (!date) {
      logTime.warn({ date }, 'неверная дата для форматирования')
      return timeConfig.epochDate
    }
    return dayjs(date).tz(this.timezone).format(timeConfig.dateFormat)
  }

  fromTelegramDate(telegramDate) {
    if (typeof telegramDate !== 'number' || telegramDate <= 0) {
      logTime.warn({ telegramDate }, 'неверная дата Telegram')
      return dayjs().tz(this.timezone)
    }
    return dayjs.unix(telegramDate).tz(this.timezone)
  }

  isAfterCutoff(messageDate, cutoff) {
    if (!cutoff || !dayjs.isDayjs(cutoff)) {
      logTime.warn({ cutoff }, 'неверное время отсечения')
      return false
    }
    const messageTime = this.fromTelegramDate(messageDate),
      isAfter = messageTime.isAfter(cutoff)
    logTime.debug(
      {
        messageDate,
        messageTime: messageTime.format(timeConfig.datetimeFormat),
        cutoffTime: cutoff.format(timeConfig.datetimeFormat),
        isAfter
      },
      'проверка времени отсечения выполнена'
    )
    return isAfter
  }

  getTimezone() {
    return this.timezone
  }

  isValidTimezone(tz) {
    if (!tz || typeof tz !== 'string') return false
    try {
      dayjs().tz(tz)
      return true
    } catch {
      return false
    }
  }
}

export const timeManager = new TimeManager(process.env.TIMEZONE || timeConfig.defaultTimezone)
