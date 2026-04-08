/**
 * Step-by-step page cloner. One page at a time.
 *
 * Usage:
 *   npx tsx harness/step.ts 261          # clone page 261 (ch26)
 *   npx tsx harness/step.ts 27:311       # clone ch27, page 311
 *   npx tsx harness/step.ts 27:next      # next uncloned page in ch27
 *   npx tsx harness/step.ts 27:status    # ch27 progress
 *   npx tsx harness/step.ts 26:audit     # audit all ch26 pages (no re-cloning)
 *   npx tsx harness/step.ts 26:batch     # clone all pages <95% with concurrency
 *   npx tsx harness/step.ts 26:refine    # loop clone→audit→fix until all pages ≥95%
 *   npx tsx harness/step.ts 26:reclone   # re-clone pages <95% into ch26-reclone/
 *   npx tsx harness/step.ts 26:promote   # swap in reclone pages that improved
 *   npx tsx harness/step.ts next         # next uncloned page in ch26 (default)
 *   npx tsx harness/step.ts status       # ch26 progress (default)
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, renameSync } from 'fs'
import { resolve } from 'path'
import pLimit from 'p-limit'
import { paths, chapterOffsets, thresholds, stdSlug, pathSlug } from './config.ts'
import { clonePageFull, getV1TextHints } from './enrich/clone-page.ts'
import { sendMessage } from './lib/api.ts'
import { models } from './config.ts'
import type { Page } from '../src/types.ts'

// Parse chapter from arg: "27:311" → chapter=27, rest="311"; "261" → chapter=26, rest="261"
function parseChapterArg(raw: string): { chapter: number; rest: string } {
  const colonIdx = raw.indexOf(':')
  if (colonIdx > 0) {
    return { chapter: parseInt(raw.slice(0, colonIdx), 10), rest: raw.slice(colonIdx + 1) }
  }
  return { chapter: 26, rest: raw }
}

const { chapter: CHAPTER, rest: ARG } = parseChapterArg(process.argv[2] ?? '')
const STANDARD = process.env.HARNESS_STANDARD ?? 'ASCE 7-22'
const OFFSET = chapterOffsets[CHAPTER] ?? 260
const PNG_DIR = resolve(paths.v1Root, 'output', 'pages', `${pathSlug(STANDARD)}-ch${CHAPTER}`)
const DATA_DIR = resolve(paths.root, 'public', 'data', `ch${CHAPTER}`)
const PROGRESS_FILE = resolve(paths.artifacts, `ch${CHAPTER}`, 'step-progress.json')

interface Progress {
  completed: Record<number, { score: number; elements: number; iterations: number }>
  lastPage: number
}

function loadProgress(): Progress {
  if (existsSync(PROGRESS_FILE)) return JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8'))
  return { completed: {}, lastPage: OFFSET }
}

function saveProgress(p: Progress): void {
  mkdirSync(resolve(PROGRESS_FILE, '..'), { recursive: true })
  writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2))
}

function getPageRange(): [number, number] {
  const pngs = readdirSync(PNG_DIR).filter(f => f.endsWith('.png')).length
  return [OFFSET + 1, OFFSET + pngs]
}

// --- Audit a page against its PDF ---
async function audit(pngPath: string, page: Page): Promise<{ score: number; issues: string[] }> {
  const imageData = readFileSync(pngPath).toString('base64')

  const summary = page.elements.map(e => {
    const h = e.heading ? '[H] ' : ''
    const b = e.text.includes('**') ? '[B] ' : ''
    let detail = `${h}${b}${e.type} [${e.column}] §${e.section}: "${e.text.slice(0, 80)}"`
    if (e.type === 'table' && e.columns) detail += ` | ${e.columns.length} cols, ${e.rows?.length ?? 0} rows`
    if (e.type === 'figure') detail += ` | ${e.image_url ? 'HAS IMG' : 'NO IMG'}`
    return detail
  }).join('\n')

  const text = await sendMessage({
    model: models.comparison,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
        { type: 'text', text: `Audit this extraction of ${STANDARD} page ${page.page}.

EXTRACTED (${page.elements.length} elements):
${summary}

CHECK:
1. Is all body text present and COMPLETE (not truncated)?
2. Are bold terms wrapped in **markers**?
3. Are section headings marked [H]?
4. Are figures atomic (one element, not duplicated as body text)?
5. Are tables complete with all rows?
6. Correct columns (left/right/full)?
7. Correct types (body vs definition vs formula vs table)?

DO NOT flag: text inside figures as missing, page headers/footers, minor formatting.

Return JSON: { "score": 0.XX, "issues": ["issue 1", "issue 2"] }
If perfect: { "score": 1.0, "issues": [] }` },
      ],
    }],
  })

  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return { score: 0.5, issues: ['Could not parse audit'] }
  try {
    return JSON.parse(match[0])
  } catch {
    return { score: 0.5, issues: ['Audit JSON parse error'] }
  }
}

// --- Print page summary ---
function printSummary(page: Page): void {
  const types: Record<string, number> = {}
  let boldCount = 0
  let headingCount = 0
  for (const e of page.elements) {
    types[e.type] = (types[e.type] ?? 0) + 1
    if (e.text.includes('**')) boldCount++
    if (e.heading) headingCount++
  }

  console.log(`\n  ${page.elements.length} elements  |  ${boldCount} bold  |  ${headingCount} headings`)
  console.log(`  Types: ${Object.entries(types).map(([t, n]) => `${t}:${n}`).join('  ')}`)
  console.log(`  Sections: ${page.section_range.join(' – ')}`)
  console.log(`  Columns: ${page.elements.filter(e => e.column === 'left').length}L  ${page.elements.filter(e => e.column === 'right').length}R  ${page.elements.filter(e => e.column === 'full').length}F`)

  const figs = page.elements.filter(e => e.type === 'figure')
  if (figs.length > 0) {
    console.log(`  Figures: ${figs.map(f => f.caption?.slice(0, 40) ?? 'untitled').join(', ')}`)
  }
}

// --- Main ---
async function main() {
  const arg = ARG
  const [firstPage, lastPage] = getPageRange()
  const progress = loadProgress()

  // Status command
  if (arg === 'status') {
    console.log(`\nChapter ${CHAPTER}: pages ${firstPage}–${lastPage}\n`)
    for (let p = firstPage; p <= lastPage; p++) {
      const done = progress.completed[p]
      if (done) {
        const icon = done.score >= 0.95 ? 'OK' : done.score >= 0.8 ? '..' : '!!'
        console.log(`  p.${p}  ${icon}  ${(done.score * 100).toFixed(0)}%  ${done.elements} el  ${done.iterations} iter`)
      } else {
        console.log(`  p.${p}  --  not yet cloned`)
      }
    }
    const doneCount = Object.keys(progress.completed).length
    console.log(`\n  ${doneCount}/${lastPage - firstPage + 1} pages done`)
    return
  }

  // Audit-only command: score all existing pages without re-cloning
  if (arg === 'audit') {
    console.log(`\nAuditing Chapter ${CHAPTER}: pages ${firstPage}–${lastPage}\n`)

    const jsonFiles = readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).sort()
    const results: { page: number; score: number; elements: number; issues: string[] }[] = []

    for (const file of jsonFiles) {
      const pageNum = parseInt(file.replace('page-', '').replace('.json', ''), 10)
      const pngIndex = pageNum - OFFSET
      const pngPath = resolve(PNG_DIR, `page-${String(pngIndex).padStart(3, '0')}.png`)

      if (!existsSync(pngPath)) {
        console.log(`  p.${pageNum}  SKIP  no PNG`)
        continue
      }

      const pageData: Page = JSON.parse(readFileSync(resolve(DATA_DIR, file), 'utf-8'))
      console.log(`  p.${pageNum}  auditing (${pageData.elements.length} elements)...`)

      const auditResult = await audit(pngPath, pageData)
      results.push({ page: pageNum, score: auditResult.score, elements: pageData.elements.length, issues: auditResult.issues })

      // Update progress
      progress.completed[pageNum] = {
        score: auditResult.score,
        elements: pageData.elements.length,
        iterations: progress.completed[pageNum]?.iterations ?? 0,
      }

      const icon = auditResult.score >= 0.95 ? 'OK' : auditResult.score >= 0.8 ? '..' : '!!'
      console.log(`  p.${pageNum}  ${icon}  ${(auditResult.score * 100).toFixed(0)}%  ${auditResult.issues.length > 0 ? auditResult.issues[0] : ''}`)
    }

    saveProgress(progress)

    // Summary
    const pass = results.filter(r => r.score >= 0.95).length
    const mid = results.filter(r => r.score >= 0.8 && r.score < 0.95).length
    const fail = results.filter(r => r.score < 0.8).length
    const avg = results.reduce((s, r) => s + r.score, 0) / results.length

    console.log(`\n${'='.repeat(50)}`)
    console.log(`  Chapter ${CHAPTER} Audit Summary`)
    console.log('='.repeat(50))
    console.log(`  ${results.length} pages audited`)
    console.log(`  ${pass} pass (>=95%)  |  ${mid} close (80-94%)  |  ${fail} need work (<80%)`)
    console.log(`  Average score: ${(avg * 100).toFixed(0)}%`)

    if (fail > 0) {
      console.log(`\n  Pages needing work:`)
      for (const r of results.filter(r => r.score < 0.8)) {
        console.log(`    p.${r.page}  ${(r.score * 100).toFixed(0)}%  ${r.elements} el  ${r.issues.slice(0, 2).join('; ')}`)
      }
    }
    return
  }

  // Reclone command: re-extract pages <95% into a separate directory
  if (arg === 'reclone') {
    const RECLONE_DATA = resolve(paths.root, 'public', 'data', `ch${CHAPTER}-reclone`)
    const RECLONE_FIGS = resolve(paths.root, 'public', 'figures', `ch${CHAPTER}-reclone`)
    const RECLONE_PROGRESS = resolve(paths.artifacts, `ch${CHAPTER}`, 'reclone-progress.json')
    const LIVE_FIGS = resolve(paths.root, 'public', 'figures', `ch${CHAPTER}`)
    mkdirSync(RECLONE_DATA, { recursive: true })
    mkdirSync(RECLONE_FIGS, { recursive: true })

    // Load reclone progress (resume support)
    let recloneProgress: Record<number, { score: number; elements: number }> = {}
    if (existsSync(RECLONE_PROGRESS)) {
      recloneProgress = JSON.parse(readFileSync(RECLONE_PROGRESS, 'utf-8'))
    }

    // Find pages that need recloning
    const pagesToReclone: number[] = []
    for (let p = firstPage; p <= lastPage; p++) {
      if (recloneProgress[p]) { console.log(`  p.${p}  SKIP  already recloned`); continue }
      const old = progress.completed[p]
      if (old && old.score >= 0.95) { console.log(`  p.${p}  SKIP  already ${(old.score * 100).toFixed(0)}%`); continue }
      pagesToReclone.push(p)
    }

    console.log(`\nRecloning Chapter ${CHAPTER}: ${pagesToReclone.length} pages\n`)

    for (const pageNum of pagesToReclone) {
      const pngIndex = pageNum - OFFSET
      const pngPath = resolve(PNG_DIR, `page-${String(pngIndex).padStart(3, '0')}.png`)
      if (!existsSync(pngPath)) { console.log(`  p.${pageNum}  SKIP  no PNG`); continue }

      const oldScore = progress.completed[pageNum]?.score ?? 0
      console.log(`\n  p.${pageNum}  (old: ${(oldScore * 100).toFixed(0)}%)`)

      // Back up live file before clonePageFull overwrites it
      const liveJson = resolve(DATA_DIR, `page-${pageNum}.json`)
      const backupJson = resolve(DATA_DIR, `page-${pageNum}.json.bak`)
      if (existsSync(liveJson)) copyFileSync(liveJson, backupJson)

      try {
        // Clone (writes to live dir — we'll move it)
        const hints = getV1TextHints(CHAPTER, pageNum)
        const page = await clonePageFull(CHAPTER, pageNum, hints, undefined, STANDARD)

        // Move new file to reclone dir
        const newJson = resolve(DATA_DIR, `page-${pageNum}.json`)
        copyFileSync(newJson, resolve(RECLONE_DATA, `page-${pageNum}.json`))

        // Move new figures to reclone dir
        const figPattern = `page-${pageNum}-fig-`
        if (existsSync(LIVE_FIGS)) {
          for (const f of readdirSync(LIVE_FIGS).filter(f => f.startsWith(figPattern))) {
            copyFileSync(resolve(LIVE_FIGS, f), resolve(RECLONE_FIGS, f))
          }
        }

        // Restore backup to live dir
        if (existsSync(backupJson)) {
          renameSync(backupJson, liveJson)
        }

        // Audit the reclone
        const auditResult = await audit(pngPath, page)
        const icon = auditResult.score >= 0.95 ? '✓' : auditResult.score >= oldScore ? '~' : '✗'
        console.log(`  p.${pageNum}  OLD ${(oldScore * 100).toFixed(0)}% → NEW ${(auditResult.score * 100).toFixed(0)}%  ${icon}  ${auditResult.issues[0] ?? ''}`)

        recloneProgress[pageNum] = { score: auditResult.score, elements: page.elements.length }
        writeFileSync(RECLONE_PROGRESS, JSON.stringify(recloneProgress, null, 2))
      } catch (err) {
        console.error(`  p.${pageNum}  ERROR: ${err}`)
        // Restore backup on error
        if (existsSync(backupJson)) renameSync(backupJson, liveJson)
      }
    }

    // Summary
    const scores = Object.entries(recloneProgress).map(([p, v]) => ({ page: +p, ...v }))
    const improved = scores.filter(s => s.score > (progress.completed[s.page]?.score ?? 0)).length
    const same = scores.filter(s => s.score === (progress.completed[s.page]?.score ?? 0)).length
    const worse = scores.filter(s => s.score < (progress.completed[s.page]?.score ?? 0)).length
    console.log(`\n${'='.repeat(50)}`)
    console.log(`  Reclone Summary: ${scores.length} pages`)
    console.log(`  ${improved} improved  |  ${same} same  |  ${worse} worse`)
    console.log(`\n  Run: npx tsx harness/step.ts ${CHAPTER}:promote`)
    return
  }

  // Promote command: swap in reclone pages that improved
  if (arg === 'promote') {
    const RECLONE_DATA = resolve(paths.root, 'public', 'data', `ch${CHAPTER}-reclone`)
    const RECLONE_FIGS = resolve(paths.root, 'public', 'figures', `ch${CHAPTER}-reclone`)
    const RECLONE_PROGRESS = resolve(paths.artifacts, `ch${CHAPTER}`, 'reclone-progress.json')
    const LIVE_FIGS = resolve(paths.root, 'public', 'figures', `ch${CHAPTER}`)

    if (!existsSync(RECLONE_PROGRESS)) {
      console.log('No reclone progress found. Run reclone first.')
      return
    }

    const recloneProgress: Record<number, { score: number; elements: number }> =
      JSON.parse(readFileSync(RECLONE_PROGRESS, 'utf-8'))

    let promoted = 0, kept = 0
    console.log(`\nPromoting Chapter ${CHAPTER} reclones:\n`)

    for (const [pageStr, reclone] of Object.entries(recloneProgress)) {
      const pageNum = parseInt(pageStr, 10)
      const oldScore = progress.completed[pageNum]?.score ?? 0

      if (reclone.score >= oldScore) {
        // Promote: copy reclone → live
        const recloneJson = resolve(RECLONE_DATA, `page-${pageNum}.json`)
        const liveJson = resolve(DATA_DIR, `page-${pageNum}.json`)
        if (existsSync(recloneJson)) {
          copyFileSync(recloneJson, liveJson)
        }

        // Copy figures
        const figPattern = `page-${pageNum}-fig-`
        if (existsSync(RECLONE_FIGS)) {
          mkdirSync(LIVE_FIGS, { recursive: true })
          for (const f of readdirSync(RECLONE_FIGS).filter(f => f.startsWith(figPattern))) {
            copyFileSync(resolve(RECLONE_FIGS, f), resolve(LIVE_FIGS, f))
          }
        }

        // Update progress
        progress.completed[pageNum] = {
          score: reclone.score,
          elements: reclone.elements,
          iterations: (progress.completed[pageNum]?.iterations ?? 0) + 1,
        }

        console.log(`  p.${pageNum}  ${(oldScore * 100).toFixed(0)}% → ${(reclone.score * 100).toFixed(0)}%  PROMOTED`)
        promoted++
      } else {
        console.log(`  p.${pageNum}  ${(oldScore * 100).toFixed(0)}% → ${(reclone.score * 100).toFixed(0)}%  KEPT OLD`)
        kept++
      }
    }

    saveProgress(progress)

    // Count final state
    const allScores = Object.values(progress.completed).map(c => c.score)
    const pass = allScores.filter(s => s >= 0.95).length
    const mid = allScores.filter(s => s >= 0.8 && s < 0.95).length
    const fail = allScores.filter(s => s < 0.8).length
    const avg = allScores.reduce((s, v) => s + v, 0) / allScores.length

    console.log(`\n${'='.repeat(50)}`)
    console.log(`  ${promoted} promoted  |  ${kept} kept old`)
    console.log(`  Final: ${pass} pass (>=95%)  |  ${mid} close (80-94%)  |  ${fail} need work (<80%)`)
    console.log(`  Average: ${(avg * 100).toFixed(0)}%`)
    return
  }

  // Batch command: clone all uncloned pages with concurrency
  if (arg === 'batch') {
    const concurrency = parseInt(process.env.HARNESS_CONCURRENCY ?? '', 10) || thresholds.concurrency
    const limit = pLimit(concurrency)

    // Find pages that need cloning (no JSON or score < 95%)
    const pagesToClone: number[] = []
    for (let p = firstPage; p <= lastPage; p++) {
      const jsonPath = resolve(DATA_DIR, `page-${p}.json`)
      const old = progress.completed[p]
      if (old && old.score >= 0.95) continue
      const pngIndex = p - OFFSET
      const pngPath = resolve(PNG_DIR, `page-${String(pngIndex).padStart(3, '0')}.png`)
      if (!existsSync(pngPath)) continue
      pagesToClone.push(p)
    }

    console.log(`\nBatch cloning Chapter ${CHAPTER}: ${pagesToClone.length} pages (concurrency: ${concurrency})\n`)

    let done = 0
    const results: { page: number; score: number; elements: number }[] = []

    const tasks = pagesToClone.map(pageNum => limit(async () => {
      const pngIndex = pageNum - OFFSET
      const pngPath = resolve(PNG_DIR, `page-${String(pngIndex).padStart(3, '0')}.png`)
      const hints = getV1TextHints(CHAPTER, pageNum)

      try {
        const page = await clonePageFull(CHAPTER, pageNum, hints, undefined, STANDARD)
        const auditResult = await audit(pngPath, page)

        progress.completed[pageNum] = {
          score: auditResult.score,
          elements: page.elements.length,
          iterations: 1,
        }
        saveProgress(progress)

        done++
        const icon = auditResult.score >= 0.95 ? 'OK' : auditResult.score >= 0.8 ? '..' : '!!'
        console.log(`  [${done}/${pagesToClone.length}] p.${pageNum}  ${icon}  ${(auditResult.score * 100).toFixed(0)}%  ${page.elements.length} el`)
        results.push({ page: pageNum, score: auditResult.score, elements: page.elements.length })
      } catch (err) {
        done++
        console.error(`  [${done}/${pagesToClone.length}] p.${pageNum}  ERROR: ${err}`)
      }
    }))

    await Promise.all(tasks)

    // Summary
    const pass = results.filter(r => r.score >= 0.95).length
    const mid = results.filter(r => r.score >= 0.8 && r.score < 0.95).length
    const fail = results.filter(r => r.score < 0.8).length
    const avg = results.length > 0 ? results.reduce((s, r) => s + r.score, 0) / results.length : 0

    console.log(`\n${'='.repeat(50)}`)
    console.log(`  Batch Summary: ${results.length} pages`)
    console.log(`  ${pass} pass (>=95%)  |  ${mid} close (80-94%)  |  ${fail} need work (<80%)`)
    console.log(`  Average: ${(avg * 100).toFixed(0)}%`)
    return
  }

  // Refine command: loop clone → audit → feed issues back → reclone until 95%+
  if (arg === 'refine') {
    const MAX_ITERATIONS = 10
    const TARGET_SCORE = 0.95

    // Find pages that need refining
    const pagesToRefine: number[] = []
    for (let p = firstPage; p <= lastPage; p++) {
      const jsonPath = resolve(DATA_DIR, `page-${p}.json`)
      if (!existsSync(jsonPath)) continue
      const old = progress.completed[p]
      if (old && old.score >= TARGET_SCORE) continue
      pagesToRefine.push(p)
    }

    console.log(`\nRefining Chapter ${CHAPTER}: ${pagesToRefine.length} pages until ${(TARGET_SCORE * 100).toFixed(0)}%+\n`)

    let totalPassed = 0
    let totalFailed = 0

    for (const pageNum of pagesToRefine) {
      const pngIndex = pageNum - OFFSET
      const pngPath = resolve(PNG_DIR, `page-${String(pngIndex).padStart(3, '0')}.png`)
      if (!existsSync(pngPath)) { console.log(`  p.${pageNum}  SKIP  no PNG`); continue }

      const startScore = progress.completed[pageNum]?.score ?? 0
      console.log(`\n${'─'.repeat(50)}`)
      console.log(`  PAGE ${pageNum}  (current: ${(startScore * 100).toFixed(0)}%)`)
      console.log('─'.repeat(50))

      const hints = getV1TextHints(CHAPTER, pageNum)
      let corrections: string[] = []
      let bestScore = startScore
      let bestPage: Page | null = null
      let bestPageJson: string | null = null

      for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
        console.log(`\n  [iter ${iter}/${MAX_ITERATIONS}]${corrections.length > 0 ? ` (${corrections.length} corrections)` : ''}`)

        // Clone with corrections from previous audit
        const page = await clonePageFull(CHAPTER, pageNum, hints, corrections.length > 0 ? corrections : undefined, STANDARD)
        printSummary(page)

        // Audit
        const auditResult = await audit(pngPath, page)
        const icon = auditResult.score >= TARGET_SCORE ? '✓' : auditResult.score > bestScore ? '↑' : '→'
        console.log(`  Score: ${(auditResult.score * 100).toFixed(0)}%  ${icon}  ${auditResult.issues[0] ?? 'clean'}`)

        // Track best
        if (auditResult.score > bestScore) {
          bestScore = auditResult.score
          bestPage = page
          bestPageJson = JSON.stringify(page, null, 2)
          console.log(`  New best: ${(bestScore * 100).toFixed(0)}%`)
        }

        // Pass if we hit target
        if (auditResult.score >= TARGET_SCORE) {
          console.log(`  ✓ PASSED at ${(auditResult.score * 100).toFixed(0)}% (iter ${iter})`)
          break
        }

        // Feed issues into next iteration
        corrections = auditResult.issues
        if (auditResult.issues.length > 0) {
          for (const issue of auditResult.issues.slice(0, 3)) {
            console.log(`    fix: ${issue}`)
          }
        }

        if (iter === MAX_ITERATIONS) {
          console.log(`  ✗ MAX ITERATIONS — best was ${(bestScore * 100).toFixed(0)}%`)
        }
      }

      // Save best result (if it improved)
      if (bestPage && bestScore > startScore && bestPageJson) {
        const outPath = resolve(DATA_DIR, `page-${pageNum}.json`)
        writeFileSync(outPath, bestPageJson)
        progress.completed[pageNum] = {
          score: bestScore,
          elements: bestPage.elements.length,
          iterations: (progress.completed[pageNum]?.iterations ?? 0) + 1,
        }
        saveProgress(progress)
        console.log(`  Saved: ${(startScore * 100).toFixed(0)}% → ${(bestScore * 100).toFixed(0)}%`)
      } else if (bestScore <= startScore) {
        console.log(`  No improvement — keeping original ${(startScore * 100).toFixed(0)}%`)
      }

      if (bestScore >= TARGET_SCORE) totalPassed++
      else totalFailed++
    }

    // Summary
    const allScores = Object.values(progress.completed).map(c => c.score)
    const pass = allScores.filter(s => s >= TARGET_SCORE).length
    const total = allScores.length
    const avg = allScores.reduce((s, v) => s + v, 0) / allScores.length

    console.log(`\n${'='.repeat(50)}`)
    console.log(`  Refine Summary`)
    console.log('='.repeat(50))
    console.log(`  This run: ${totalPassed} passed  |  ${totalFailed} stuck`)
    console.log(`  Overall: ${pass}/${total} pages at ${(TARGET_SCORE * 100).toFixed(0)}%+`)
    console.log(`  Average: ${(avg * 100).toFixed(0)}%`)
    if (totalFailed > 0) {
      console.log(`\n  Pages still below ${(TARGET_SCORE * 100).toFixed(0)}%:`)
      for (const [p, c] of Object.entries(progress.completed)) {
        if (c.score < TARGET_SCORE) {
          console.log(`    p.${p}  ${(c.score * 100).toFixed(0)}%`)
        }
      }
    }
    return
  }

  // Determine which page to clone
  let pageNum: number
  if (arg === 'next') {
    pageNum = progress.lastPage + 1
    if (pageNum > lastPage) {
      console.log('All pages done!')
      return
    }
  } else {
    pageNum = parseInt(arg, 10)
    if (isNaN(pageNum)) {
      console.log('Usage: npx tsx harness/step.ts [chapter:]<page_number|next|status|audit|reclone|promote>')
      return
    }
  }

  const pngIndex = pageNum - OFFSET
  const pngPath = resolve(PNG_DIR, `page-${String(pngIndex).padStart(3, '0')}.png`)
  if (!existsSync(pngPath)) {
    console.error(`No PNG for page ${pageNum} (expected ${pngPath})`)
    return
  }

  console.log(`\n${'='.repeat(50)}`)
  console.log(`  PAGE ${pageNum}  (${pngIndex} of ${lastPage - firstPage + 1})`)
  console.log('='.repeat(50))

  // Step 1: Clone
  console.log('\n[1] Cloning (left + right columns)...')
  const hints = getV1TextHints(CHAPTER, pageNum)
  if (hints.length > 0) console.log(`  ${hints.length} V1 text hints loaded`)
  let page = await clonePageFull(CHAPTER, pageNum, hints, undefined, STANDARD)
  printSummary(page)

  // Step 2: Audit
  console.log('\n[2] Auditing against PDF...')
  let auditResult = await audit(pngPath, page)
  console.log(`  Score: ${(auditResult.score * 100).toFixed(0)}%`)
  if (auditResult.issues.length > 0) {
    for (const issue of auditResult.issues) {
      console.log(`  - ${issue}`)
    }
  }

  // Step 3: Re-clone if needed (max 2 retries)
  let iterations = 1
  for (let retry = 0; retry < 2 && auditResult.score < 0.95 && auditResult.issues.length > 0; retry++) {
    console.log(`\n[${3 + retry}] Re-cloning with ${auditResult.issues.length} fixes...`)
    page = await clonePageFull(CHAPTER, pageNum, hints, auditResult.issues, STANDARD)
    printSummary(page)

    console.log('  Re-auditing...')
    auditResult = await audit(pngPath, page)
    console.log(`  Score: ${(auditResult.score * 100).toFixed(0)}%`)
    if (auditResult.issues.length > 0) {
      for (const issue of auditResult.issues) {
        console.log(`  - ${issue}`)
      }
    }
    iterations++
  }

  // Step 4: Save
  console.log(`\n[DONE] Page ${pageNum}: ${(auditResult.score * 100).toFixed(0)}%  (${iterations} iteration${iterations > 1 ? 's' : ''})`)
  console.log(`  Saved to public/data/ch${CHAPTER}/page-${pageNum}.json`)
  console.log(`  Check: http://localhost:5176/#p${pageNum}`)

  // Update progress
  progress.completed[pageNum] = {
    score: auditResult.score,
    elements: page.elements.length,
    iterations,
  }
  progress.lastPage = Math.max(progress.lastPage, pageNum)
  saveProgress(progress)

  // Suggest next
  const nextUndone = Array.from({ length: lastPage - firstPage + 1 }, (_, i) => firstPage + i)
    .find(p => !progress.completed[p])
  if (nextUndone) {
    console.log(`\n  Next: npx tsx harness/step.ts ${nextUndone}`)
  } else {
    console.log('\n  All pages done!')
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
