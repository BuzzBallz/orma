// Property tests without a dependency: a seeded generator, a runner that prints its seed once and shrinks
// the first counter-example it finds. Not a check (no check- prefix, npm test does not run it):
// check-ticket and src/desk/audit.mjs --self-test import it.
//   --seed <n>       replay a draw
//   --seed random    a fresh draw (Date.now() >>> 0), printed for its replay
//   no --seed        the fixed seed 0xA4B, so npm test always replays the same draw

/** The fixed seed of every run without --seed. */
export const DEFAULT_SEED = 0xa4b

/**
 * mulberry32: a 32-bit seeded generator, uniform in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The seed of this process, from its arguments.
 * @param {string[]} [argv]
 * @returns {number}
 */
export function seedFrom(argv = process.argv) {
  const i = argv.indexOf('--seed')
  if (i < 0) return DEFAULT_SEED
  const v = argv[i + 1]
  if (v === 'random') return Date.now() >>> 0
  if (v === undefined || !/^(0x[0-9a-f]+|[0-9]+)$/i.test(v)) throw new RangeError(`--seed takes a number or random, got ${JSON.stringify(v)}`)
  return Number(v) >>> 0
}

let announced = false

/**
 * Draw `cases` cases and check the property on each. On the first failure, shrink the case (each
 * candidate of `shrink` is tried while the failure persists, at most 500 tries), print the seed, the
 * property, the reason and the smallest case, and return false.
 * @template C
 * @param {{ name: string, seed: number, cases?: number, gen: (rand: () => number) => C, prop: (c: C) => true | string, shrink?: (c: C) => C[] }} o
 * @returns {boolean}
 */
export function forAll({ name, seed, cases = 2000, gen, prop, shrink = shrinkNumbers }) {
  if (!announced) {
    console.log(`  property seed: ${seed} (replay: --seed ${seed})`)
    announced = true
  }
  const rand = mulberry32(seed)
  const verdict = (c) => {
    try {
      return prop(c)
    } catch (e) {
      return `threw ${String(e?.message ?? e).slice(0, 160)}`
    }
  }
  for (let i = 0; i < cases; i++) {
    const c = gen(rand)
    const first = verdict(c)
    if (first === true) continue
    let smallest = c
    let reason = first
    let tries = 0
    for (let progress = true; progress && tries < 500;) {
      progress = false
      for (const candidate of shrink(smallest)) {
        if (++tries > 500) break
        const r = verdict(candidate)
        if (r !== true) {
          smallest = candidate
          reason = r
          progress = true
          break
        }
      }
    }
    console.log(`  FAIL property ${name}, case ${i + 1} of ${cases}, seed ${seed} (replay: --seed ${seed})\n       ${reason}\n       smallest case ${JSON.stringify(smallest)}`)
    return false
  }
  console.log(`  ok   property ${name}: ${cases} cases`)
  return true
}

/**
 * The default shrink: each decimal string halved, then decremented; each array less one element; the
 * same, recursively, inside objects.
 * @param {unknown} c
 * @returns {unknown[]}
 */
export function shrinkNumbers(c) {
  const out = []
  if (typeof c === 'string' && /^[0-9]+$/.test(c)) {
    const n = BigInt(c)
    if (n > 0n) {
      out.push((n / 2n).toString())
      out.push((n - 1n).toString())
    }
  } else if (Array.isArray(c)) {
    for (let i = 0; i < c.length; i++) out.push([...c.slice(0, i), ...c.slice(i + 1)])
    c.forEach((x, i) => { for (const s of shrinkNumbers(x)) out.push(Object.assign([...c], { [i]: s })) })
  } else if (c && typeof c === 'object') {
    for (const [k, v] of Object.entries(c)) for (const s of shrinkNumbers(v)) out.push({ ...c, [k]: s })
  }
  return out
}
