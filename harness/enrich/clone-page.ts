import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { models, paths, chapterOffsets } from '../config.ts'
import { sendMessage } from '../lib/api.ts'
import type { Page, PageElement, BBox, ColumnPlacement, ElementType } from '../../src/types.ts'

/**
 * Clone a single PDF page into a fully structured V2 Page JSON.
 * One vision call that produces everything: elements, figures described per protocol,
 * tables with full data, correct columns and bboxes.
 *
 * V1 text is passed as a hint for exact character fidelity — vision provides structure.
 */
export async function clonePage(
  pagePngPath: string,
  pageNum: number,
  chapter: number,
  standard: string,
  v1TextHints?: string[]
): Promise<Page> {
  const imageData = readFileSync(pagePngPath).toString('base64')

  const hintsBlock = v1TextHints && v1TextHints.length > 0
    ? `\n\nV1 TEXT HINTS (use these for exact character accuracy — the text is 100% faithful to the PDF, but the structure/types may be wrong):\n${v1TextHints.map((t, i) => `[${i}] ${t}`).join('\n')}`
    : ''

  const text = await sendMessage({
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
            text: `You are cloning this ASCE 7-22 page into a structured digital twin. Extract EVERY piece of content on this page into a precise JSON structure. The goal: if we render this JSON in a two-column layout, it should look identical to the PDF.

PAGE: ${pageNum}  CHAPTER: ${chapter}  STANDARD: ${standard}

RULES:
- Extract every element in DOCUMENT ORDER (top-to-bottom, left column then right column)
- For each element, determine its EXACT column: "left", "right", or "full"
- Provide PRECISE bounding boxes as normalized 0–1 coordinates (x_start, x_end, y_start, y_end)
- Use EXACT text from the PDF — every character matters. If V1 text hints are provided, prefer those for character accuracy.
- Numbers are sacred. Extract them exactly as printed.

ELEMENT TYPES:
- "provision": Mandatory requirements containing "shall"
- "definition": Terms in ALL-CAPS followed by definition text
- "formula": Equations with expression and parameter definitions
- "table": Structured data with columns and rows — extract ALL rows and columns completely
- "figure": Diagrams, flowcharts, maps, charts — describe per protocol below
- "exception": Provisions starting with "Exception:" or "EXCEPTION:"
- "user_note": Text starting with "User Note:"
- "body": All other text (headings, commentary, general text)

FIGURE / DIAGRAM PROTOCOL:
Figures are ATOMIC. A figure is ONE element — the image, the caption, and a structured description. NEVER extract text that is INSIDE a diagram as separate body/provision/definition elements. If text is visually part of a figure (inside a box, inside a flowchart node, on a map, in a chart), it belongs in the figure's description, NOT as a standalone element.

How to identify figure boundaries: A figure includes everything from the top of the diagram to the caption line below it (e.g., "Figure 26.1-1. Outline of process..."). Any "Note:" line directly below the caption is a separate user_note element, not part of the figure.

For each figure, provide:
- caption: The exact caption line as printed (e.g., "Figure 26.1-1. Outline of process for determining wind loads.")
- figure_type: "flowchart" | "contour_map" | "geometry_diagram" | "data_chart" | "lookup_table_image" | "schematic"
- figure_description: A rich description for agents who cannot see the image. This is where ALL the figure's internal text goes:
  - For flowcharts: describe every node, every connection, every bullet list inside nodes
  - For contour maps: geography, parameter, risk category, value range, units, special regions
  - For geometry diagrams: all labeled dimensions, forces, variables
  - For data charts: axes, series, key values
- cross_references: All section/table/figure references visible within the figure
- bbox: Tightly enclose ONLY the figure + caption. Content area starts ~x=0.06, ends ~x=0.94.

DO NOT create separate body elements for text inside figures. The figure element's description contains that information.

TABLE EXTRACTION:
- Extract the COMPLETE table: every column header, every row, every cell value
- Right-align numeric columns
- Include table title/caption
- Include footnotes as part of the element text

BOLD TEXT AND HEADINGS:
- Any text that appears BOLD in the PDF must be marked. This is critical for visual fidelity.
- Section headings (e.g., "26.5.1 Basic Wind Speed") should have "heading": true
- Chapter titles (e.g., "CHAPTER 26 WIND LOADS: GENERAL REQUIREMENTS") should have "heading": true
- Subsection headings at ANY depth (26.1, 26.1.1, 26.1.2.1, etc.) should have "heading": true
- For NON-HEADING bold text (defined terms, inline labels, bold phrases within body text), wrap them in **double asterisks** within the text field. Examples:
  - "**BUILDING, LOW-RISE:** An enclosed or partially enclosed building..."
  - "**APPROVED:** Acceptable to the Authority Having Jurisdiction."
  - "**BASIC WIND SPEED, V:** Three-second gust speed at 33 ft (10 m)..."
  - "**Exception:** The wind tunnel procedure specified in Chapter 31..."
  - "**User Note:** A building or other structure designed for wind loads..."
- EVERY bold word or phrase in the PDF that is not a section heading must be wrapped in ** markers. This includes defined terms, "Exception:", "User Note:", bold labels in provisions, and any other bold text.

TABLE EXTRACTION:
- Extract the COMPLETE table: every column header, every row, every cell value
- Right-align numeric columns
- Include table title/caption
- Include footnotes as part of the element text

Return ONLY valid JSON with this structure:
{
  "standard": "${standard}",
  "chapter": ${chapter},
  "page": ${pageNum},
  "section_range": ["first_section", "last_section"],
  "elements": [
    {
      "id": "ASCE7-22-SECTION-TYPE_PREFIX-N",
      "type": "provision|definition|formula|table|figure|exception|user_note|body",
      "section": "26.X.Y",
      "text": "Full text content...",
      "cross_references": ["ASCE7-22-27", ...],
      "bbox": { "x_start": 0.0, "x_end": 0.48, "y_start": 0.05, "y_end": 0.15 },
      "column": "left|right|full",
      "heading": true,  // SET THIS TO TRUE for bold section headings/titles, omit or false for body text

      // For tables only:
      "columns": ["Col1", "Col2"],
      "rows": [["val1", "val2"]],

      // For figures only:
      "caption": "Figure 26.X-Y. Caption text.",
      "figure_type": "flowchart|contour_map|...",
      "figure_description": "Rich description of what the figure shows...",
      "figure_content": { /* structured content per figure type */ },

      // For formulas only:
      "expression": "qz = 0.00256 * Kz * Kzt * Kd * Ke * V^2",
      "parameters": ["qz = velocity pressure (psf)", "Kz = ..."]
    }
  ]
}

ID FORMAT: ASCE7-22-{section}-{type_prefix}{N}
Type prefixes: P=provision, D=definition, E=equation, T=table, F=figure, X=exception, N=user_note, TB=body, H=heading
${hintsBlock}`,
          },
        ],
      },
    ],
  })

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error(`Failed to parse clone response for page ${pageNum}: ${text.slice(0, 200)}`)
  }

  const raw = JSON.parse(jsonMatch[0])

  // Normalize the response into proper V2 Page format
  return normalizePage(raw, pageNum, chapter, standard)
}

/**
 * Normalize vision response into strict V2 types.
 */
function normalizePage(
  raw: Record<string, unknown>,
  pageNum: number,
  chapter: number,
  standard: string
): Page {
  const rawElements = (raw.elements ?? []) as Array<Record<string, unknown>>
  const elements: PageElement[] = []

  for (const re of rawElements) {
    const type = normalizeType(String(re.type ?? 'body'))
    const bbox = normalizeBBox(re.bbox as Record<string, number> | undefined)
    const column = normalizeColumn(String(re.column ?? 'left'))

    const el: PageElement = {
      id: String(re.id ?? `ASCE7-22-${chapter}-CLONE-${pageNum}-${elements.length}`),
      type,
      section: String(re.section ?? ''),
      text: String(re.text ?? ''),
      cross_references: Array.isArray(re.cross_references)
        ? re.cross_references.map(String)
        : [],
      bbox,
      column,
    }

    // Heading flag
    if (re.heading === true) {
      el.heading = true
    }

    // Table fields
    if (type === 'table') {
      if (Array.isArray(re.columns)) el.columns = re.columns.map(String)
      if (Array.isArray(re.rows)) {
        el.rows = (re.rows as unknown[][]).map((row) =>
          Array.isArray(row) ? row.map(String) : []
        )
      }
    }

    // Figure fields
    if (type === 'figure') {
      el.caption = String(re.caption ?? re.text ?? '')
      // Store rich description in text field so it's searchable
      const desc = re.figure_description ?? re.description
      if (desc) {
        el.text = `${el.caption}\n\n${desc}`
      }
      // figure_content is stored but not in the PageElement type yet —
      // we serialize it into the text for now so agents can access it
      const content = re.figure_content
      if (content && typeof content === 'object') {
        el.text += `\n\n[Structured content: ${JSON.stringify(content)}]`
      }
    }

    // Formula fields
    if (type === 'formula') {
      if (re.expression) el.expression = String(re.expression)
      if (Array.isArray(re.parameters)) el.parameters = re.parameters.map(String)
    }

    el.metadata = { extracted_by: 'vision-clone', qc_status: 'pending' }
    fixBoldMarkers(el)
    elements.push(el)
  }

  fixFormulas(elements)

  const sections = [...new Set(elements.map((e) => e.section))].filter(Boolean).sort()

  return {
    standard,
    chapter,
    page: pageNum,
    section_range: [sections[0] ?? '', sections[sections.length - 1] ?? ''],
    elements,
  }
}

/**
 * Fix bold marker abuse: if ** wraps more than ~80 chars or the entire element,
 * the model bolded too much. Split into heading + body, or strip the markers.
 *
 * Common patterns:
 * - "**26.12.3.2 Title** Body text..." → heading:true, text: "26.12.3.2 Title\nBody text..."
 * - "**Entire paragraph is bold for no reason**" → strip markers
 * - "**TERM:** definition text" → correct, leave alone
 */
/**
 * Post-process: merge "where" blocks into preceding formula parameters.
 * Also split combined formulas (multiple equation numbers in one element).
 */
export function fixFormulas(elements: PageElement[]): void {
  // Merge "where" blocks into preceding formula
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]
    if (el.type !== 'body' && el.type !== 'provision') continue
    const text = el.text.toLowerCase().trim()
    if (!text.startsWith('where ') && !text.startsWith('where:')) continue

    // Find the nearest preceding formula in the same column
    let formulaIdx = -1
    for (let j = i - 1; j >= 0; j--) {
      if (elements[j].type === 'formula' && elements[j].column === el.column) {
        formulaIdx = j
        break
      }
    }

    if (formulaIdx >= 0) {
      const formula = elements[formulaIdx]
      // Parse "where" block into parameter definitions
      const whereText = el.text.replace(/^where:?\s*/i, '')
      const paramDefs = whereText
        .split(/[;,]\s*(?=[A-Za-zα-ωᾱ])/g)
        .map(s => s.trim())
        .filter(s => s.length > 3)

      if (paramDefs.length > 0) {
        formula.parameters = [...(formula.parameters ?? []), ...paramDefs]
        // Remove the "where" element
        elements.splice(i, 1)
      }
    }
  }
}

export function fixBoldMarkers(el: PageElement): void {
  if (!el.text.includes('**')) return

  // Find all bold spans
  const boldSpans = [...el.text.matchAll(/\*\*([^*]+)\*\*/g)]
  if (boldSpans.length === 0) return

  // Check if there's a single bold span that covers most of the text
  const totalBoldLen = boldSpans.reduce((sum, m) => sum + m[1].length, 0)
  const textLen = el.text.replace(/\*\*/g, '').length

  // If bold covers >60% of text and text is long (>80 chars), it's a bug
  if (totalBoldLen > textLen * 0.6 && textLen > 80) {
    // Check if it starts with a section number — that's a heading merged with body
    const match = el.text.match(/^\*\*(\d+\.\d+[\d.]*\s+[^*]{5,60})\*\*\s*(.+)/s)
    if (match) {
      // Split: heading portion becomes the element, rest is body
      // Set heading flag and clean the text
      el.heading = true
      el.text = match[1] + '\n' + match[2]
      return
    }

    // Check if it starts with a bold term (definition pattern) — leave short terms alone
    const termMatch = el.text.match(/^\*\*([A-Z][A-Z\s,]+:?)\*\*/)
    if (termMatch && termMatch[1].length < 60) {
      return // This is a legitimate bold term, leave it
    }

    // Otherwise strip all bold markers — the whole thing shouldn't be bold
    el.text = el.text.replace(/\*\*/g, '')
  }
}

function normalizeType(t: string): ElementType {
  const map: Record<string, ElementType> = {
    provision: 'provision',
    definition: 'definition',
    formula: 'formula',
    table: 'table',
    figure: 'figure',
    exception: 'exception',
    user_note: 'user_note',
    body: 'body',
    heading: 'body',
    reference: 'body',
  }
  return map[t.toLowerCase()] ?? 'body'
}

function normalizeBBox(raw: Record<string, number> | undefined): BBox {
  if (!raw) return { x_start: 0, x_end: 1, y_start: 0, y_end: 0 }
  return {
    x_start: clamp(raw.x_start ?? 0),
    x_end: clamp(raw.x_end ?? 1),
    y_start: clamp(raw.y_start ?? 0),
    y_end: clamp(raw.y_end ?? 1),
  }
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function normalizeColumn(c: string): ColumnPlacement {
  if (c === 'right') return 'right'
  if (c === 'full') return 'full'
  return 'left'
}

/**
 * Clone a single COLUMN of a PDF page. Two calls (left + right) avoid
 * truncation on dense pages and eliminate column misassignment.
 */
export async function cloneColumn(
  pagePngPath: string,
  pageNum: number,
  chapter: number,
  standard: string,
  column: 'left' | 'right',
  v1TextHints?: string[]
): Promise<PageElement[]> {
  const imageData = readFileSync(pagePngPath).toString('base64')

  const hintsBlock = v1TextHints && v1TextHints.length > 0
    ? `\n\nV1 TEXT HINTS (exact characters — use for accuracy):\n${v1TextHints.map((t, i) => `[${i}] ${t}`).join('\n')}`
    : ''

  const colDesc = column === 'left'
    ? 'LEFT column only (the left half of the page, approximately x=0.0 to x=0.48)'
    : 'RIGHT column only (the right half of the page, approximately x=0.52 to x=1.0)'

  const text = await sendMessage({
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
            text: `Extract ONLY the ${colDesc} of ASCE 7-22 page ${pageNum}, chapter ${chapter}.

STRICT SPATIAL RULE: This page has two columns of text. You are extracting ONLY the ${column} column.
- The ${column === 'left' ? 'left column occupies the left half of the page (x ≈ 0.06 to 0.48)' : 'right column occupies the right half of the page (x ≈ 0.52 to 0.94)'}.
- If text is physically in the OTHER column, DO NOT extract it even if it's the same section number.
- If a section heading like "26.4 GENERAL" appears in the right column, the left column call must NOT extract it.
- Each column is independent. Do not duplicate content.

RULES:
- Extract every element in TOP-TO-BOTTOM order within this column
- Every element gets column: "${column}"
- Provide PRECISE bounding boxes (0-1 normalized, relative to FULL page)
- DO NOT TRUNCATE TEXT. Every element must contain COMPLETE text — every word, every character. This is the #1 priority.
- Numbers are sacred. Extract exactly as printed.

TYPE CLASSIFICATION — be precise:
- "provision": Text containing "shall", "shall be", "shall be permitted", "must", "is required" — these are MANDATORY requirements
- "definition": ALL-CAPS term followed by colon and definition text (e.g., "BASIC WIND SPEED, V: Three-second...")
- "body": Descriptive text, commentary, lists, notes that are NOT mandatory requirements
- Do NOT classify provisions as body. If it says "shall", it's a provision.

BOLD TEXT:
- Section headings (26.X.Y Title) → set "heading": true
- Bold inline terms (e.g., **BUILDING, LOW-RISE:**) → wrap in **double asterisks**
- EVERY bold word/phrase must be marked with ** or heading:true

ELEMENT TYPES:
- "provision": Requirements containing "shall", "shall be", "shall be permitted", "must", "is required"
- "definition": ALL-CAPS terms followed by definition text
- "formula": Equations with expression and parameters — see FORMULA RULES below
- "table": ANY structured data with columns and rows — see TABLE RULES below
- "figure": Diagrams/charts/maps — see FIGURE RULES below
- "exception": Starting with "Exception:"
- "user_note": Starting with "User Note:"
- "body": Everything else

FORMULA RULES — CRITICAL:
- A formula has: expression (the equation), equation number (e.g., "26.11-13"), and parameters
- Parameters MUST include full definitions, not just variable names. Format: "Rₙ = resonant response factor"
- The "where" block after a formula defines the variables. Merge it INTO the formula's parameters array.
  - BAD:  parameters: ["Rₙ", "N₁"]
  - GOOD: parameters: ["Rₙ = resonant response factor", "N₁ = reduced frequency = n₁Lz̄/Vz̄"]
- If a "where" block follows a formula, do NOT make it a separate body element. Its content goes in the formula's parameters.
- Each equation number (26.11-13, 26.11-14, etc.) should be a separate formula element, not combined.

FULL-WIDTH ELEMENTS: If a table or figure clearly spans both columns, set column: "full" and include it — but only if it's genuinely full-width.

TABLE RULES — CRITICAL:
- ANY data arranged in columns and rows is a table. This includes:
  - Small inline tables (e.g., "Special Wind Region" territory tables with Location/V columns)
  - Coefficient lookup tables (e.g., Table 26.6-1, Table 26.10-1)
  - Tables embedded near or below figures
  - Tables with only 3-5 rows — these are STILL tables, not body text
- Every table MUST have "columns" (string[]) and "rows" (string[][]) with ALL data extracted exactly
- A table is NOT a figure. If it has gridlines or columnar data, it's a table element, not part of a figure.
- If a table appears below a figure on the same page, it is a SEPARATE element from the figure.

FIGURE RULES — CRITICAL:
- Figures are ATOMIC. One element = the image + its caption + a structured description.
- NEVER extract text that is INSIDE a diagram/flowchart/map as separate body elements.
- A figure is a visual diagram, chart, map, or illustration — NOT tabular data.
- Tables near a figure are separate elements. Do not merge a table into a figure.
- caption: exact caption line as printed below the figure
- figure_description: rich text describing everything inside the figure for agents who can't see images
- bbox: tightly enclose only the figure + caption. Content area is x≈0.06 to x≈0.94. Never 0.0 or 1.0.

Return ONLY valid JSON:
{
  "elements": [
    {
      "id": "ASCE7-22-{section}-{prefix}{N}",
      "type": "...",
      "section": "26.X.Y",
      "text": "COMPLETE untruncated text...",
      "heading": true,
      "cross_references": [],
      "bbox": { "x_start": 0.0, "x_end": 0.48, "y_start": 0.05, "y_end": 0.15 },
      "column": "${column}",
      "columns": [],
      "rows": [],
      "expression": "",
      "parameters": [],
      "caption": "",
      "figure_type": "",
      "figure_description": ""
    }
  ]
}
${hintsBlock}`,
          },
        ],
      },
    ],
  })

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error(`Failed to parse ${column} column response for page ${pageNum}`)
  }

  const raw = JSON.parse(jsonMatch[0])
  const rawElements = (raw.elements ?? []) as Array<Record<string, unknown>>

  // Normalize each element, forcing the correct column
  return rawElements.map((re, i) => {
    const type = normalizeType(String(re.type ?? 'body'))
    const bbox = normalizeBBox(re.bbox as Record<string, number> | undefined)
    // Force column unless explicitly full-width
    const elColumn = String(re.column) === 'full' ? 'full' as const : column

    const el: PageElement = {
      id: String(re.id ?? `ASCE7-22-${chapter}-${column.toUpperCase()}-${pageNum}-${i}`),
      type,
      section: String(re.section ?? ''),
      text: String(re.text ?? ''),
      cross_references: Array.isArray(re.cross_references) ? re.cross_references.map(String) : [],
      bbox,
      column: elColumn,
    }

    if (re.heading === true) el.heading = true
    if (type === 'table' && Array.isArray(re.columns)) {
      el.columns = re.columns.map(String)
      if (Array.isArray(re.rows)) el.rows = (re.rows as unknown[][]).map(r => Array.isArray(r) ? r.map(String) : [])
    }
    if (type === 'figure') {
      el.caption = String(re.caption ?? re.text ?? '')
      const desc = re.figure_description ?? ''
      const content = re.figure_content
      if (desc || content) {
        el.text = `${el.caption}\n\n${desc}${content ? `\n\n[Structured content: ${JSON.stringify(content)}]` : ''}`
      }
    }
    if (type === 'formula') {
      if (re.expression) el.expression = String(re.expression)
      if (Array.isArray(re.parameters)) el.parameters = re.parameters.map(String)
    }
    el.metadata = { extracted_by: 'vision-clone', qc_status: 'pending' }
    fixBoldMarkers(el)
    return el
  })
}

// --- Locate figure bbox precisely via a dedicated vision call ---
async function locateFigureBbox(
  pagePngPath: string,
  caption: string
): Promise<BBox> {
  const imageData = readFileSync(pagePngPath).toString('base64')

  const text = await sendMessage({
    model: models.enrichment,
    max_tokens: 256,
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
            text: `I need the EXACT vertical position of this figure: "${caption}"

Tell me TWO y-coordinates (normalized 0-1, where 0=top of page, 1=bottom of page):
1. y_top: where the figure starts (top edge of the diagram or its border)
2. y_bottom: where the figure ENDS — this is the bottom of the caption line or Note line directly below the figure. NOT the start of body text/definitions/paragraphs below.

CRITICAL: y_bottom must be TIGHT. If the caption "Figure 26.1-1..." sits at the 54% mark of the page, y_bottom should be ~0.55, not 0.65 or 0.70. Look for where the next paragraph of body text begins — y_bottom is ABOVE that.

Return ONLY JSON: {"y_top": 0.XX, "y_bottom": 0.XX}`,
          },
        ],
      },
    ],
  })

  const match = text.match(/\{[^}]+\}/)
  if (match) {
    const raw = JSON.parse(match[0])
    return {
      x_start: 0.06,
      x_end: 0.94,
      y_start: clamp(raw.y_top ?? 0.01),
      y_end: clamp(raw.y_bottom ?? 0.55),
    }
  }
  return { x_start: 0.06, x_end: 0.94, y_start: 0.01, y_end: 0.55 }
}

// --- Crop figure from page PNG ---
async function cropFigure(
  pagePngPath: string,
  bbox: BBox,
  outputPath: string
): Promise<void> {
  const { execSync } = await import('child_process')
  const script = `
from PIL import Image
img = Image.open("${pagePngPath}")
w, h = img.size
box = (int(${bbox.x_start}*w), int(${bbox.y_start}*h), int(${bbox.x_end}*w), int(${bbox.y_end}*h))
cropped = img.crop(box)
cropped.save("${outputPath}")
`
  execSync(`python3 -c '${script}'`)
}

/**
 * Clone one page end-to-end using split-column approach:
 * 1. Clone left column via vision
 * 2. Clone right column via vision
 * 3. Merge, deduplicate full-width elements, sort by position
 * 4. Crop figures from page PNG
 * 5. Save page JSON
 */
export async function clonePageFull(
  chapter: number,
  pageNum: number,
  v1TextHints?: string[]
): Promise<Page> {
  const offset = chapterOffsets[chapter] ?? 260
  const pngIndex = pageNum - offset
  const pngDir = resolve(paths.v1Root, 'output', 'pages', `asce722-ch${chapter}`)
  const pngFile = `page-${String(pngIndex).padStart(3, '0')}.png`
  const pngPath = resolve(pngDir, pngFile)

  if (!existsSync(pngPath)) {
    throw new Error(`Page PNG not found: ${pngPath}`)
  }

  console.log(`  Cloning page ${pageNum} from ${pngFile}...`)

  // Clone each column separately
  console.log(`    Left column...`)
  const leftElements = await cloneColumn(pngPath, pageNum, chapter, 'ASCE 7-22', 'left', v1TextHints)
  console.log(`    ${leftElements.length} elements`)

  console.log(`    Right column...`)
  const rightElements = await cloneColumn(pngPath, pageNum, chapter, 'ASCE 7-22', 'right', v1TextHints)
  console.log(`    ${rightElements.length} elements`)

  // Merge columns with aggressive deduplication
  const fullFromLeft = leftElements.filter(e => e.column === 'full')
  const fullFromRight = rightElements.filter(e => e.column === 'full')
  const leftOnly = leftElements.filter(e => e.column === 'left')
  const rightOnly = rightElements.filter(e => e.column === 'right')

  // Global dedup: collect ALL elements, deduplicate by text prefix.
  // When duplicates exist, prefer: full > left/right, and longer text > shorter.
  const allRaw = [
    ...leftElements.map(e => ({ ...e, _source: 'left' as const })),
    ...rightElements.map(e => ({ ...e, _source: 'right' as const })),
  ]

  const seen = new Map<string, { el: PageElement; source: string }>()
  const dedupedAll: PageElement[] = []

  for (const e of allRaw) {
    const key = e.text.slice(0, 40).toLowerCase().trim()
    if (!key) { dedupedAll.push(e); continue }

    const existing = seen.get(key)
    if (existing) {
      // Duplicate found — keep the better one
      const keepNew = e.text.length > existing.el.text.length ||
        (e.column === 'full' && existing.el.column !== 'full')
      if (keepNew) {
        // Replace existing with this one
        const idx = dedupedAll.indexOf(existing.el)
        if (idx >= 0) dedupedAll[idx] = e
        seen.set(key, { el: e, source: e._source })
        console.log(`    Dedup: replaced ${existing.source} with ${e._source} "${key.slice(0, 35)}..."`)
      } else {
        console.log(`    Dedup: skipped ${e._source} duplicate "${key.slice(0, 35)}..."`)
      }
    } else {
      seen.set(key, { el: e, source: e._source })
      dedupedAll.push(e)
    }
  }

  // Remove _source helper field and separate back
  const dedupedLeft = dedupedAll.filter(e => e.column === 'left')
  const dedupedRight = dedupedAll.filter(e => e.column === 'right')
  const dedupedFull = dedupedAll.filter(e => e.column === 'full')

  // Combine all deduped elements and sort by y_start position
  const allElements = [...dedupedLeft, ...dedupedRight, ...dedupedFull]
  allElements.sort((a, b) => a.bbox.y_start - b.bbox.y_start)

  // Merge "where" blocks into preceding formulas
  fixFormulas(allElements)

  const sections = [...new Set(allElements.map(e => e.section))].filter(Boolean).sort()
  const page: Page = {
    standard: 'ASCE 7-22',
    chapter,
    page: pageNum,
    section_range: [sections[0] ?? '', sections[sections.length - 1] ?? ''],
    elements: allElements,
  }

  console.log(`    ${allElements.length} total (${dedupedLeft.length}L + ${dedupedRight.length}R + ${dedupedFull.length} full)`)

  // Locate and crop figures with precise bbox via dedicated vision call
  const figuresDir = resolve(paths.root, 'public', 'figures', `ch${chapter}`)
  mkdirSync(figuresDir, { recursive: true })

  const figures = page.elements.filter((e) => e.type === 'figure')
  for (let i = 0; i < figures.length; i++) {
    const fig = figures[i]
    const outPath = resolve(figuresDir, `page-${pageNum}-fig-${i}.png`)
    try {
      // Get precise bbox from a dedicated vision call
      const caption = fig.caption ?? fig.text.split('\n')[0] ?? ''
      console.log(`    Locating figure ${i}: "${caption.slice(0, 50)}"...`)
      const preciseBbox = await locateFigureBbox(pngPath, caption)
      fig.bbox = preciseBbox
      console.log(`    bbox: y=${preciseBbox.y_start.toFixed(2)}–${preciseBbox.y_end.toFixed(2)}`)

      await cropFigure(pngPath, preciseBbox, outPath)
      fig.image_url = `/figures/ch${chapter}/page-${pageNum}-fig-${i}.png`
      console.log(`    Cropped figure ${i}`)
    } catch (err) {
      console.error(`    Failed to crop figure ${i}: ${err}`)
    }
  }

  // Save
  const outDir = resolve(paths.root, 'public', 'data', `ch${chapter}`)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(resolve(outDir, `page-${pageNum}.json`), JSON.stringify(page, null, 2))
  console.log(`    Saved to public/data/ch${chapter}/page-${pageNum}.json`)

  return page
}

/**
 * Get V1 text hints for a page (exact text from Docling extraction).
 */
export function getV1TextHints(chapter: number, pageNum: number): string[] {
  const offset = chapterOffsets[chapter] ?? 260
  const v1Page = pageNum - offset
  const v1Path = resolve(paths.v1Root, 'output', 'runs', `asce722-ch${chapter}-hybrid.json`)

  if (!existsSync(v1Path)) return []

  const elements = JSON.parse(readFileSync(v1Path, 'utf-8')) as Array<{
    source: { page: number }
    data: Record<string, unknown>
    title: string
  }>

  return elements
    .filter((e) => e.source.page === v1Page)
    .map((e) => {
      const text = String(e.data?.rule ?? e.data?.definition ?? e.data?.term ?? e.title ?? '')
      return text.slice(0, 200)
    })
    .filter((t) => t.length > 10)
}
