import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { clonePageFull, getV1TextHints, fixBoldMarkers } from '../enrich/clone-page.ts'
import { sendMessage } from '../lib/api.ts'
import { models, paths, chapterOffsets, thresholds } from '../config.ts'
import type { Page } from '../../src/types.ts'

const client = new Anthropic()


interface CloneAudit {
  score: number
  mismatches: string[]
  suggestions: string[]
}

/**
 * Visually audit a cloned page by comparing the page PNG (source)
 * against our extracted JSON (rendered as a text summary).
 *
 * This doesn't require Puppeteer/screenshots — it sends the PDF page image
 * alongside a structured summary of our extracted data and asks:
 * "what did we get wrong?"
 */
async function auditClone(pagePngPath: string, page: Page): Promise<CloneAudit> {
  const imageData = readFileSync(pagePngPath).toString('base64')

  const summary = page.elements.map((e) => {
    const h = e.heading ? '[BOLD] ' : ''
    const col = `[${e.column}]`
    let detail = `${h}${e.type} ${col} §${e.section}: "${e.text.slice(0, 100)}"`
    if (e.type === 'table' && e.columns) {
      detail += ` | COLS: [${e.columns.join(', ')}] | ${e.rows?.length ?? 0} rows`
    }
    if (e.type === 'figure') {
      detail += ` | caption: "${e.caption?.slice(0, 60)}"`
      detail += e.image_url ? ' | HAS IMAGE' : ' | NO IMAGE'
    }
    return detail
  }).join('\n')

  const responseText = await sendMessage({
    model: models.comparison,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: imageData },
          },
          {
            type: 'text',
            text: `You are auditing a digital twin extraction of ASCE 7-22 page ${page.page}. Compare the PDF page image above against the extracted data below. Be THOROUGH — catch every discrepancy.

EXTRACTED DATA (${page.elements.length} elements):
${summary}

CHECK EACH OF THESE:
1. Is every piece of body text, provision, and definition accounted for? (missing = high severity)
2. Are tables complete with ALL rows and columns? (missing rows = high severity)
3. Are figures present as single atomic elements with captions? (missing figure = high severity)
4. Are all bold section headings marked with [BOLD]? (missing bold = medium severity)
5. Is every element in the correct column (left/right/full)? (wrong column = medium severity)
6. Are element types correct? (provision vs body vs definition = medium severity)
7. Are definition terms wrapped in **bold markers**? (missing bold = medium severity)
8. Is text complete and untruncated? (truncated text = high severity)

IMPORTANT RULES FOR SCORING:
- Text INSIDE a figure/diagram (flowchart nodes, map labels) should NOT be separate elements. It belongs in the figure's description. Do NOT flag this as missing.
- Page headers/footers (page numbers, "STANDARD ASCE/SEI 7-22") are optional — do NOT count them as missing.
- Focus on BODY TEXT outside of figures — provisions, definitions, formulas, tables.

Score the extraction 0.0–1.0 (1.0 = perfect, every element present and correct).

Return ONLY valid JSON:
{
  "score": 0.XX,
  "mismatches": [
    "Missing: table with wind speeds for territories below the map (has 5 rows, 3 columns)",
    "Wrong type: element 5 is a provision (contains 'shall') but classified as body",
    "Missing bold: '26.5.2 Special Wind Regions' should be marked as heading"
  ],
  "suggestions": [
    "Add the territories wind speed table with columns: Location, V (mi/h), V (m/s)",
    "Reclassify element 5 from body to provision",
    "Set heading: true on the 26.5.2 element"
  ]
}

If the extraction is perfect, return: { "score": 1.0, "mismatches": [], "suggestions": [] }`,
          },
        ],
      },
    ],
  })

  const jsonMatch = responseText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    console.error('    Failed to parse audit response')
    return { score: 0, mismatches: ['Failed to parse audit'], suggestions: [] }
  }

  return JSON.parse(jsonMatch[0]) as CloneAudit
}

/**
 * Re-clone a page with audit feedback. The previous mismatches and suggestions
 * are injected into the prompt so the model corrects its extraction.
 */
async function recloneWithFeedback(
  pagePngPath: string,
  pageNum: number,
  chapter: number,
  standard: string,
  previousPage: Page,
  audit: CloneAudit,
  v1TextHints: string[]
): Promise<Page> {
  const imageData = readFileSync(pagePngPath).toString('base64')

  const prevSummary = previousPage.elements.map((e) => {
    const h = e.heading ? '[BOLD] ' : ''
    return `${h}${e.type} [${e.column}] §${e.section}: "${e.text.slice(0, 80)}"`
  }).join('\n')

  const hintsBlock = v1TextHints.length > 0
    ? `\nV1 TEXT HINTS (exact characters from PDF):\n${v1TextHints.map((t, i) => `[${i}] ${t}`).join('\n')}`
    : ''

  const responseText = await sendMessage({
    model: models.enrichment,
    max_tokens: 32768,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: imageData },
          },
          {
            type: 'text',
            text: `You previously extracted this ASCE 7-22 page ${pageNum} but the audit found problems. Fix ALL of them.

PREVIOUS EXTRACTION (${previousPage.elements.length} elements):
${prevSummary}

AUDIT SCORE: ${(audit.score * 100).toFixed(0)}%

PROBLEMS FOUND:
${audit.mismatches.map((m) => `- ${m}`).join('\n')}

FIXES REQUIRED:
${audit.suggestions.map((s) => `- ${s}`).join('\n')}

Re-extract the ENTIRE page, correcting all problems above. CRITICAL RULES:
- Every element needs: id, type, section, text, cross_references, bbox (0-1), column, and heading (true for bold headings)
- Tables need: columns (string[]) and rows (string[][]) with ALL data
- Figures are ATOMIC — one element with caption + figure_description. NEVER extract text inside a diagram as separate elements.
- Formulas need: expression, parameters
- heading: true for ALL bold section headings at every depth
- BOLD INLINE TEXT: Wrap ALL bold text that is NOT a heading in **double asterisks**.
- DO NOT TRUNCATE TEXT. Every element must contain its COMPLETE text. Truncation is the #1 failure mode.
${hintsBlock}

Return the COMPLETE corrected page as valid JSON:
{
  "standard": "${standard}",
  "chapter": ${chapter},
  "page": ${pageNum},
  "section_range": ["first_section", "last_section"],
  "elements": [ ... ]
}`,
          },
        ],
      },
    ],
  })

  const jsonMatch = responseText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error(`Failed to parse reclone response for page ${pageNum}`)
  }

  const raw = JSON.parse(jsonMatch[0])
  // Use the same clone function with the raw response — but we need to normalize.
  // Simplest: call clonePage again which handles normalization, but pass the feedback as hints.
  // Actually, let's just normalize here.
  return normalizeRaw(raw, pageNum, chapter, standard)
}

/**
 * Minimal normalization of raw vision response.
 */
function normalizeRaw(
  raw: Record<string, unknown>,
  pageNum: number,
  chapter: number,
  standard: string
): Page {
  const rawElements = (raw.elements ?? []) as Array<Record<string, unknown>>
  const elements = rawElements.map((re, i) => {
    const type = String(re.type ?? 'body') as import('../../src/types.ts').ElementType
    const validTypes = new Set(['provision', 'definition', 'formula', 'table', 'figure', 'exception', 'user_note', 'body'])
    const bbox = re.bbox as Record<string, number> | undefined

    const el: import('../../src/types.ts').PageElement = {
      id: String(re.id ?? `ASCE7-22-${chapter}-RECLONE-${pageNum}-${i}`),
      type: validTypes.has(type) ? type : 'body',
      section: String(re.section ?? ''),
      text: String(re.text ?? ''),
      cross_references: Array.isArray(re.cross_references) ? re.cross_references.map(String) : [],
      bbox: {
        x_start: Math.max(0, Math.min(1, bbox?.x_start ?? 0)),
        x_end: Math.max(0, Math.min(1, bbox?.x_end ?? 1)),
        y_start: Math.max(0, Math.min(1, bbox?.y_start ?? 0)),
        y_end: Math.max(0, Math.min(1, bbox?.y_end ?? 1)),
      },
      column: (['left', 'right', 'full'].includes(String(re.column)) ? String(re.column) : 'left') as 'left' | 'right' | 'full',
    }

    if (re.heading === true) el.heading = true
    if (re.columns && Array.isArray(re.columns)) el.columns = re.columns.map(String)
    if (re.rows && Array.isArray(re.rows)) el.rows = (re.rows as unknown[][]).map(r => Array.isArray(r) ? r.map(String) : [])
    if (re.expression) el.expression = String(re.expression)
    if (re.parameters && Array.isArray(re.parameters)) el.parameters = re.parameters.map(String)
    if (re.caption) el.caption = String(re.caption)
    if (re.figure_description || re.figure_content) {
      const desc = re.figure_description ?? ''
      const content = re.figure_content
      el.text = `${el.caption ?? el.text}\n\n${desc}${content ? `\n\n[Structured content: ${JSON.stringify(content)}]` : ''}`
    }
    el.metadata = { extracted_by: 'vision-clone', qc_status: 'pending' }
    fixBoldMarkers(el)

    return el
  })

  const sections = [...new Set(elements.map(e => e.section))].filter(Boolean).sort()

  return {
    standard,
    chapter,
    page: pageNum,
    section_range: [sections[0] ?? '', sections[sections.length - 1] ?? ''],
    elements,
  }
}

/**
 * Full recursive clone loop for a single page:
 * 1. Clone page from PDF via vision
 * 2. Audit the clone against the PDF image
 * 3. If score < threshold and issues are fixable, re-clone with feedback
 * 4. Repeat until converged or max iterations
 */
export async function clonePageRecursive(
  chapter: number,
  pageNum: number,
  maxIterations: number = thresholds.maxIterations
): Promise<{ page: Page; score: number; iterations: number }> {
  const offset = chapterOffsets[chapter] ?? 260
  const pngIndex = pageNum - offset
  const pngDir = resolve(paths.v1Root, 'output', 'pages', `asce722-ch${chapter}`)
  const pngPath = resolve(pngDir, `page-${String(pngIndex).padStart(3, '0')}.png`)

  if (!existsSync(pngPath)) {
    throw new Error(`Page PNG not found: ${pngPath}`)
  }

  const v1Hints = getV1TextHints(chapter, pageNum)
  const standard = 'ASCE 7-22'

  // Iteration 0: initial clone
  console.log(`  [iter 0] Cloning page ${pageNum}...`)
  let page = await clonePageFull(chapter, pageNum, v1Hints)

  // Track best result — reclones can regress due to truncation
  let bestPage = page
  let bestScore = 0

  console.log(`  Starting audit loop (max ${maxIterations} iterations, ${page.elements.length} elements)...`)

  for (let iter = 0; iter < maxIterations; iter++) {
    // Audit
    console.log(`  [iter ${iter}] Auditing...`)
    let audit: CloneAudit
    try {
      audit = await auditClone(pngPath, page)
    } catch (err) {
      console.error(`  [iter ${iter}] Audit failed: ${String(err)}`)
      return { page: bestPage, score: bestScore, iterations: iter + 1 }
    }
    console.log(`  [iter ${iter}] Score: ${(audit.score * 100).toFixed(0)}%  Issues: ${audit.mismatches.length}`)

    // Track best version
    if (audit.score > bestScore) {
      bestScore = audit.score
      bestPage = page
      console.log(`  [iter ${iter}] New best: ${(bestScore * 100).toFixed(0)}%`)
    } else if (audit.score < bestScore) {
      console.log(`  [iter ${iter}] Regression (${(audit.score * 100).toFixed(0)}% < best ${(bestScore * 100).toFixed(0)}%) — reverting to best`)
      page = bestPage
    }

    if (audit.mismatches.length > 0) {
      for (const m of audit.mismatches) {
        console.log(`    - ${m}`)
      }
    }

    // Check convergence
    if (audit.score >= thresholds.pageApproved) {
      console.log(`  [iter ${iter}] APPROVED`)
      return { page: bestPage, score: bestScore, iterations: iter + 1 }
    }

    if (audit.mismatches.length === 0) {
      console.log(`  [iter ${iter}] No mismatches reported — accepting best`)
      return { page: bestPage, score: bestScore, iterations: iter + 1 }
    }

    if (iter >= maxIterations - 1) {
      console.log(`  [iter ${iter}] Max iterations reached — using best (${(bestScore * 100).toFixed(0)}%)`)
      return { page, score: audit.score, iterations: iter + 1 }
    }

    // Re-clone with feedback
    console.log(`  [iter ${iter + 1}] Re-cloning with ${audit.mismatches.length} fixes...`)
    page = await recloneWithFeedback(pngPath, pageNum, chapter, standard, page, audit, v1Hints)

    // Re-crop figures
    const { mkdirSync } = await import('fs')
    const figuresDir = resolve(paths.root, 'public', 'figures', `ch${chapter}`)
    mkdirSync(figuresDir, { recursive: true })

    const figures = page.elements.filter((e) => e.type === 'figure')
    for (let fi = 0; fi < figures.length; fi++) {
      const fig = figures[fi]
      const outPath = resolve(figuresDir, `page-${pageNum}-fig-${fi}.png`)
      try {
        const { execSync } = await import('child_process')
        const script = `
from PIL import Image
img = Image.open("${pngPath}")
w, h = img.size
box = (int(${fig.bbox.x_start}*w), int(${fig.bbox.y_start}*h), int(${fig.bbox.x_end}*w), int(${fig.bbox.y_end}*h))
cropped = img.crop(box)
cropped.save("${outPath}")
`
        execSync(`python3 -c '${script}'`)
        fig.image_url = `/figures/ch${chapter}/page-${pageNum}-fig-${fi}.png`
      } catch { /* skip */ }
    }

    // Save intermediate
    const { writeFileSync } = await import('fs')
    const outDir = resolve(paths.root, 'public', 'data', `ch${chapter}`)
    writeFileSync(resolve(outDir, `page-${pageNum}.json`), JSON.stringify(page, null, 2))
  }

  // Save best version as final
  const { writeFileSync: ws } = await import('fs')
  const outDir = resolve(paths.root, 'public', 'data', `ch${chapter}`)
  ws(resolve(outDir, `page-${pageNum}.json`), JSON.stringify(bestPage, null, 2))

  return { page: bestPage, score: bestScore, iterations: maxIterations }
}
