import * as fc from 'fast-check'
import { afterEach, expect, it } from 'vitest'
import { describeSchedule, nextAt, parseSchedule } from '../extensions/automations/schedule.ts'

// Contract/search cards and counterfeit replay evidence: E1.2, conversation #61687.
// Override SCHEDULE_SEED/PATH only with a single selected test (-t); stats are opt-in.
const minute = 60000
const day = 86400000
const counts = new Map<string, number>()
function count(category: string) {
  counts.set(category, (counts.get(category) ?? 0) + 1)
}
afterEach(() => {
  if (process.env.SCHEDULE_STATS) console.log('schedule categories', Object.fromEntries(counts))
  counts.clear()
})
function search(seed: number, numRuns = 150) {
  return {
    seed: Number(process.env.SCHEDULE_SEED ?? seed),
    numRuns,
    ...(process.env.SCHEDULE_PATH ? { path: process.env.SCHEDULE_PATH } : {}),
  }
}
const timestamp = fc
  .tuple(
    fc.oneof(
      fc.constantFrom(
        Date.UTC(2024, 1, 29),
        Date.UTC(2025, 11, 31),
        Date.UTC(2026, 0, 1),
        Date.UTC(2026, 3, 30),
      ),
      fc.integer({ min: 0, max: 4382 }).map((n) => Date.UTC(2024, 0, 1) + n * day),
    ),
    fc.integer({ min: 0, max: day - 1 }),
  )
  .map(([date, time]) => date + time)
const offset = fc.integer({ min: -12, max: 14 })
function zone(hours: number) {
  // IANA Etc/GMT signs are opposite ISO offset signs.
  return hours === 0 ? 'UTC' : `Etc/GMT${hours < 0 ? '+' : '-'}${Math.abs(hours)}`
}
function recordCalendar(time: number, hours: number) {
  count(`offset:${Math.sign(hours)}`)
  const date = new Date(time)
  if (date.getUTCDate() === 1) count('calendar:month-start')
  if (new Date(time + day).getUTCMonth() !== date.getUTCMonth()) count('calendar:month-end')
  if (date.getUTCMonth() === 1 && date.getUTCDate() === 29) count('calendar:leap-day')
}

it('normalizes generated durations and advances intervals from now, not a missed fire', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 2, max: 4000 }),
      fc.constantFrom('s', 'm', 'h', 'd'),
      timestamp,
      fc.integer({ min: 0, max: 1000 }),
      (halves, unit, now, missed) => {
        const ms = (halves / 2) * { s: 1000, m: minute, h: 60 * minute, d: day }[unit]
        const interval = parseSchedule(`every ${halves / 2}${unit}`)
        expect(interval).toEqual({ kind: 'every', ms })
        expect(parseSchedule(interval)).toEqual(interval)
        expect(parseSchedule(interval)).not.toBe(interval)
        const wake = now + missed * ms
        expect(nextAt(interval, wake, now)).toBe(wake + ms)
        const once = parseSchedule(`in ${halves / 2}${unit}`, now)
        expect(once).toEqual({ kind: 'at', time: new Date(now + ms).toISOString() })
        expect(nextAt(once, wake, now)).toBe(now + ms)
        count(`duration:${unit}`)
        count(`duration:${halves % 2 ? 'half' : 'whole'}`)
        count(`missed:${missed === 0 ? 'none' : 'positive'}`)
      },
    ),
    search(1201),
  )
})

it('normalizes explicit ISO offsets while one-shot fires and descriptions stay absolute', () => {
  fc.assert(
    fc.property(timestamp, offset, (local, hours) => {
      const suffix = `${hours < 0 ? '-' : '+'}${String(Math.abs(hours)).padStart(2, '0')}:00`
      const input = `${new Date(local).toISOString().slice(0, -1)}${suffix}`
      const expected = local - hours * 60 * minute
      const canonical = { kind: 'at', time: new Date(expected).toISOString() }
      const schedule = parseSchedule(`at ${input}`)
      expect(schedule).toEqual(canonical)
      expect(parseSchedule(input)).toEqual(canonical)
      expect(parseSchedule(schedule)).toEqual(canonical)
      expect(describeSchedule(schedule)).toBe(`Once at ${canonical.time}`)
      for (const after of [expected - 1, expected, expected + day]) {
        expect(nextAt(schedule, after, after - day)).toBe(expected)
      }
      recordCalendar(local, hours)
    }),
    search(1202),
  )
})

it('describes canonical elapsed units and daily clocks without treating prose as syntax', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2000 }),
      fc.constantFrom('day', 'hour', 'minute', 'second'),
      fc.integer({ min: 0, max: 23 }),
      fc.integer({ min: 0, max: 59 }),
      offset,
      (amount, unit, hour, min, hours) => {
        // Construct a canonical unit rather than copying describeSchedule's unit-selection loop.
        const n = unit === 'day' ? amount : amount % (unit === 'hour' ? 24 : 60) || 1
        const ms = n * { day, hour: 60 * minute, minute, second: 1000 }[unit]
        const schedule = parseSchedule({ kind: 'every', ms })
        expect(parseSchedule(schedule)).toEqual({ kind: 'every', ms })
        expect(describeSchedule(schedule)).toBe(`Every ${n} ${unit}${n === 1 ? '' : 's'}`)
        const tz = zone(hours)
        const cron = parseSchedule(`cron "${min} ${hour} * * *" ${tz}`)
        expect(describeSchedule(cron)).toBe(
          `At ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')} (${tz})`,
        )
        count(`description:${unit}:${n === 1 ? 'singular' : 'plural'}`)
        count(`clock:${hour < 10 || min < 10 ? 'padded' : 'unpadded'}`)
      },
    ),
    search(1203),
  )
})

const limits = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const
it('accepts each cron field boundary and rejects out-of-domain or malformed fields', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 20 }), fc.nat({ max: 10000 }), (overflow, choice) => {
      for (const [index, [min, max]] of limits.entries()) {
        const value = min + (choice % (max - min + 1))
        const parse = (field: string) => {
          const parts = ['*', '*', '*', '*', '*']
          parts[index] = field
          return parseSchedule(`cron "${parts.join(' ')}" UTC`)
        }
        for (const field of [
          `${min}`,
          `${max}`,
          `${value}`,
          `${min},${max}`,
          `${min}-${max}`,
          `*/${overflow}`,
          `${value}/${overflow}`,
          `${min}-${max}/${overflow}`,
        ]) {
          expect(parse(field).kind).toBe('cron')
          count(`field:${index}:valid`)
        }
        for (const [category, field] of Object.entries({
          below: `${min - overflow}`,
          above: `${max + overflow}`,
          reversed: `${max}-${min}`,
          zeroStep: `${value}/0`,
          emptyItem: `${value},`,
          nonnumeric: `${value}x`,
        })) {
          expect(() => parse(field)).toThrow(/Invalid cron field/)
          count(`field:${index}:${category}`)
        }
      }
    }),
    search(1204, 100),
  )
})

type Field = { text: string; values: number[]; wildcard: boolean; syntax: string }
function cronField(
  min: number,
  max: number,
  dateField = false,
  valueMax = max,
): fc.Arbitrary<Field> {
  const domain = Array.from({ length: max - min + 1 }, (_, i) => min + i)
  const value = fc.integer({ min, max: valueMax })
  return fc
    .tuple(
      fc.constantFrom(
        'wildcard',
        'singleton',
        'list',
        'range',
        'start-step',
        'range-step',
        ...(dateField ? [] : ['star-step']),
      ),
      value,
      value,
      fc.integer({ min: 1, max: max - min + 1 }),
    )
    .map(([syntax, a, b, step]) => {
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      const text =
        syntax === 'wildcard'
          ? '*'
          : syntax === 'singleton'
            ? `${a}`
            : syntax === 'list'
              ? `${lo},${hi}`
              : syntax === 'range'
                ? `${lo}-${hi}`
                : syntax === 'star-step'
                  ? `*/${step}`
                  : syntax === 'start-step'
                    ? `${a}/${step}`
                    : `${lo}-${hi}/${step}`
      // Semantic values are carried into the oracle, never recovered by parsing cron text.
      const values = domain.filter((n) => {
        if (syntax === 'wildcard') return true
        if (syntax === 'singleton') return n === a
        if (syntax === 'list') return n === lo || n === hi
        if (syntax === 'range') return n >= lo && n <= hi
        if (syntax === 'star-step') return (n - min) % step === 0
        if (syntax === 'start-step') return n >= a && (n - a) % step === 0
        return n >= lo && n <= hi && (n - lo) % step === 0
      })
      return { text, values, wildcard: syntax === 'wildcard', syntax }
    })
}
const cronCase = fc.record({
  minute: cronField(0, 59),
  hour: cronField(0, 23),
  // Restrict explicit dates to <=28 so all generated calendars have a fire.
  // Start/step syntax still extends through the true field maximum (31).
  date: cronField(1, 31, true, 28),
  month: cronField(1, 12),
  weekday: cronField(0, 7, true),
  offset,
  after: timestamp,
})
type CronCase = typeof cronCase extends fc.Arbitrary<infer T> ? T : never
function scheduleFor(c: CronCase) {
  const expr = [c.minute, c.hour, c.date, c.month, c.weekday].map((f) => f.text).join(' ')
  const schedule = parseSchedule(`cron "${expr}" ${zone(c.offset)}`)
  expect(parseSchedule(schedule)).toEqual(schedule)
  return schedule
}
function calendarNext(c: CronCase, after: number) {
  // Enumerate local calendar dates and their allowed clocks, not production's Intl minute jumps.
  const shift = c.offset * 60 * minute
  const midnight = Math.floor((after + shift) / day) * day
  for (let d = 0; d <= 8 * 366; d++) {
    const localDay = midnight + d * day
    const date = new Date(localDay)
    const dom = c.date.wildcard || c.date.values.includes(date.getUTCDate())
    const dow = c.weekday.values.some((n) => n % 7 === date.getUTCDay())
    const matches = c.date.wildcard || c.weekday.wildcard ? dom && dow : dom || dow
    if (!c.month.values.includes(date.getUTCMonth() + 1) || !matches) continue
    for (const h of c.hour.values)
      for (const m of c.minute.values) {
        const candidate = localDay + (h * 60 + m) * minute - shift
        if (candidate > after) return candidate
      }
  }
  throw new Error('Generated calendar unexpectedly lacks a candidate within eight years')
}
function recordCron(c: CronCase) {
  for (const key of ['minute', 'hour', 'date', 'month', 'weekday'] as const)
    count(`${key}:${c[key].syntax}`)
  count(`day-rule:${c.date.wildcard}:${c.weekday.wildcard}`)
  if (c.weekday.values.includes(7)) count('weekday:sunday7')
  recordCalendar(c.after, c.offset)
}

it('finds the first strict calendar tick and monotonic recurrence across fixed-offset cron fields', () => {
  fc.assert(
    fc.property(cronCase, (c) => {
      const schedule = scheduleFor(c)
      let after = c.after
      for (let tick = 0; tick < 3; tick++) {
        const expected = calendarNext(c, after)
        const actual = nextAt(schedule, after)
        expect(actual).toBe(expected)
        expect(actual).toBeGreaterThan(after)
        after = actual
      }
      recordCron(c)
    }),
    search(1205),
  )
})

it('skips missed cron ticks on late wake and chooses the first future calendar match', () => {
  fc.assert(
    fc.property(cronCase, fc.integer({ min: 0, max: 400 }), (c, daysLate) => {
      const schedule = scheduleFor(c)
      const wake = c.after + daysLate * day
      const first = calendarNext(c, c.after)
      const previous = first <= wake ? first : c.after
      expect(nextAt(schedule, wake, previous)).toBe(calendarNext(c, wake))
      count(`cron-missed:${daysLate === 0 ? 'none' : 'positive'}`)
      recordCron(c)
    }),
    search(1206),
  )
})
