import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

/**
 * The absolute origin the social card is served from.
 *
 * og:image has to be absolute — a scraper fetches it without a page to resolve against —
 * and this project has no fixed hostname: every preview deploy gets its own. So the
 * deployment stamps itself at build time instead of us hard-coding a URL that would be
 * correct on exactly one deploy and stale on all the others. VITE_SITE_ORIGIN wins if it
 * is set, Vercel's own hostname is used when it is not, and a local build falls back to
 * the dev server so the tag is never left holding an unreplaced token.
 */
function siteOrigin(): string {
  const explicit = process.env.VITE_SITE_ORIGIN
  if (explicit) return explicit.replace(/\/+$/, '')
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL
  if (host) return `https://${host.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
  return 'http://localhost:5173'
}

const stampOrigin = {
  name: 'orma-stamp-site-origin',
  transformIndexHtml(html: string) {
    return html.replaceAll('__SITE_ORIGIN__', siteOrigin())
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stampOrigin],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
})
