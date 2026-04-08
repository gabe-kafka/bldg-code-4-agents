/**
 * Building Code PDF -> Structured Page JSON (Vision Pipeline)
 * ============================================================
 *
 * This is the entry point for extracting building code pages into
 * structured, per-page JSON using Claude Vision. Hand this file
 * to a teammate and they can start extracting any code.
 *
 * PREREQUISITES
 * -------------
 * 1. Page PNGs rendered from the source PDF at ~200 dpi.
 *    The V1 pipeline (bldg-code-2-json) does this:
 *      python cli.py render --pdf input/my-code.pdf --standard "IBC-2021" --chapter 16
 *    Or use any PDF renderer — one PNG per page, named page-001.png, page-002.png, etc.
 *
 * 2. An Anthropic API key in your environment:
 *      export ANTHROPIC_API_KEY=sk-...
 *
 * 3. Page PNGs placed at:
 *      {V1_ROOT}/output/pages/{slug}-ch{chapter}/page-001.png
 *    Where slug = standard name lowercased with no spaces (e.g. "asce7-22", "ibc-2021").
 *
 * QUICK START (single page)
 * -------------------------
 *   npx tsx harness/scrape.ts --standard "ASCE 7-22" --chapter 26 --page 261
 *
 * QUICK START (all pages in a chapter)
 * ------------------------------------
 *   npx tsx harness/scrape.ts --standard "ASCE 7-22" --chapter 26
 *
 * FOR A NEW CODE
 * --------------
 *   1. Render your PDF pages to PNGs (see prerequisites)
 *   2. Add your chapter offset to harness/config.ts chapterOffsets
 *      (offset = the ASCE/IBC absolute page number of the page BEFORE page-001.png)
 *   3. Run:
 *      npx tsx harness/scrape.ts --standard "IBC-2021" --chapter 16 --page 400
 *   4. Check the output: public/data/ch16/page-400.json
 *   5. Start the dev server (npm run dev) and view the digital twin
 *
 * WHAT THE PIPELINE DOES (per page)
 * ----------------------------------
 *   1. Read page PNG from disk
 *   2. Send to Claude Vision — extract left column, right column in parallel
 *   3. Merge columns, deduplicate full-width elements
 *   4. Post-process: fix bold markers, merge "where" blocks into formulas
 *   5. Crop and analyze figures (separate vision calls)
 *   6. Complete truncated elements using V1 text hints or vision fallback
 *   7. Audit: vision-compare extraction against the original page image
 *   8. Save page JSON to public/data/ch{N}/page-{N}.json
 *
 * WHAT MIGHT NEED TUNING FOR OTHER CODES
 * ----------------------------------------
 *   - chapterOffsets in config.ts: maps chapter number to page offset.
 *     Each code will have its own page numbering.
 *
 *   - The vision prompt in clone-page.ts references element type conventions
 *     (ALL-CAPS definitions, "shall" provisions, etc.) that are standard
 *     across most US building codes. Non-US codes may need prompt adjustments.
 *
 *   - normalizeLatex() in clone-page.ts: ASCE-specific variable patterns
 *     (Kz, Kzt, GCpi). Other codes will have different variable naming.
 *     The function only applies these when no LaTeX is present, so it's
 *     mostly harmless — but you may want to add your code's patterns.
 *
 *   - V1 text hints (optional): if you have V1 extracted text from
 *     bldg-code-2-json, set HARNESS_V1_ROOT to point at it. The hints
 *     improve character accuracy but are not required.
 *
 * ENVIRONMENT VARIABLES
 * ---------------------
 *   ANTHROPIC_API_KEY          Required. Your Anthropic API key.
 *   HARNESS_V1_ROOT            Path to bldg-code-2-json repo (for text hints).
 *                              Default: ../bldg-code-2-json
 *   HARNESS_STANDARD           Default standard name. Default: "ASCE 7-22"
 *   HARNESS_MODEL_ENRICHMENT   Model for extraction. Default: claude-sonnet-4-20250514
 *   HARNESS_MODEL_COMPARISON   Model for QC audit. Default: claude-sonnet-4-20250514
 *   HARNESS_CONCURRENCY        Parallel page limit for batch. Default: 10
 */

import { existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { paths, chapterOffsets, pathSlug } from './config.ts'
import { clonePageFull, getV1TextHints } from './enrich/clone-page.ts'
import type { Page } from '../src/types.ts'

interface ScrapeOptions {
  /** Standard name, e.g. "ASCE 7-22", "IBC-2021" */
  standard: string
  /** Chapter number */
  chapter: number
  /** Specific page number to extract. If omitted, extracts all pages. */
  page?: number
}

interface ScrapeResult {
  pages: Page[]
  outputDir: string
  stats: { total: number; byType: Record<string, number> }
}

/**
 * Extract structured page JSON from building code page PNGs.
 *
 * Each page PNG is sent to Claude Vision, which returns elements
 * (provisions, definitions, formulas, tables, figures) with bounding
 * boxes, column placement, and cross-references.
 */
export async function scrape(opts: ScrapeOptions): Promise<ScrapeResult> {
  const { standard, chapter, page: singlePage } = opts
  const slug = pathSlug(standard)
  const offset = chapterOffsets[chapter]

  if (offset === undefined) {
    throw new Error(
      `No chapter offset for chapter ${chapter}. ` +
      `Add it to harness/config.ts chapterOffsets.\n` +
      `The offset is the absolute page number of the page BEFORE page-001.png.`
    )
  }

  // Find page PNGs
  const pngDir = resolve(paths.v1Root, 'output', 'pages', `${slug}-ch${chapter}`)
  if (!existsSync(pngDir)) {
    throw new Error(
      `Page PNGs not found at ${pngDir}\n` +
      `Render your PDF pages first:\n` +
      `  python cli.py render --pdf input/your-code.pdf --standard "${standard}" --chapter ${chapter}`
    )
  }

  const pngCount = readdirSync(pngDir).filter(f => f.endsWith('.png')).length
  if (pngCount === 0) {
    throw new Error(`No PNG files found in ${pngDir}`)
  }

  const firstPage = offset + 1
  const lastPage = offset + pngCount

  // Determine which pages to extract
  const pagesToExtract: number[] = []
  if (singlePage !== undefined) {
    if (singlePage < firstPage || singlePage > lastPage) {
      throw new Error(`Page ${singlePage} is out of range ${firstPage}-${lastPage}`)
    }
    pagesToExtract.push(singlePage)
  } else {
    for (let p = firstPage; p <= lastPage; p++) pagesToExtract.push(p)
  }

  console.log(`\nScraping ${standard} Chapter ${chapter}`)
  console.log(`  ${pagesToExtract.length} page(s): ${pagesToExtract[0]}–${pagesToExtract[pagesToExtract.length - 1]}`)
  console.log(`  PNGs: ${pngDir}\n`)

  const pages: Page[] = []
  const byType: Record<string, number> = {}

  for (const pageNum of pagesToExtract) {
    const hints = getV1TextHints(chapter, pageNum)
    const page = await clonePageFull(chapter, pageNum, hints, undefined, standard)

    for (const el of page.elements) {
      byType[el.type] = (byType[el.type] ?? 0) + 1
    }

    pages.push(page)
    console.log(`  page ${pageNum}: ${page.elements.length} elements`)
  }

  const outputDir = resolve(paths.root, 'public', 'data', `ch${chapter}`)
  const total = pages.reduce((sum, p) => sum + p.elements.length, 0)

  console.log(`\nDone: ${pages.length} pages, ${total} elements`)
  console.log(`Output: ${outputDir}/`)
  console.log(`Types: ${Object.entries(byType).map(([t, n]) => `${t}:${n}`).join('  ')}`)

  return { pages, outputDir, stats: { total, byType } }
}

// --- CLI ---
if (process.argv[1]?.endsWith('scrape.ts')) {
  const args = process.argv.slice(2)
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag)
    return idx >= 0 ? args[idx + 1] : undefined
  }

  const standard = getArg('--standard') ?? process.env.HARNESS_STANDARD ?? 'ASCE 7-22'
  const chapter = parseInt(getArg('--chapter') ?? '26', 10)
  const page = getArg('--page') ? parseInt(getArg('--page')!, 10) : undefined

  scrape({ standard, chapter, page }).catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
