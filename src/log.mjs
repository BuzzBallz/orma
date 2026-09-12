/**
 * Structured, levelled logging with no dependency.
 *
 * JSON lines to stderr in production, human-readable with LOG_PRETTY=1.
 * stderr deliberately, so stdout stays clean for the operator during the demo:
 * on stage you want one line per action and nothing else.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? LEVELS.info
const pretty = process.env.LOG_PRETTY === '1'

const COLOUR = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }
const RESET = '\x1b[0m'

function emit(level, module, msg, fields) {
  if (LEVELS[level] < threshold) return
  const ts = new Date().toISOString()
  if (pretty) {
    const extra = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : ''
    process.stderr.write(
      `${COLOUR[level]}[${ts.slice(11, 19)}] ${level.toUpperCase().padEnd(5)}${RESET} [${module}] ${msg}${extra}\n`,
    )
  } else {
    process.stderr.write(JSON.stringify({ ts, level, module, msg, ...fields }) + '\n')
  }
}

/**
 * @param {string} module e.g. "poll:vault"
 */
export function logger(module) {
  return {
    debug: (msg, fields) => emit('debug', module, msg, fields),
    info: (msg, fields) => emit('info', module, msg, fields),
    warn: (msg, fields) => emit('warn', module, msg, fields),
    error: (msg, fields) => emit('error', module, msg, fields),
  }
}
