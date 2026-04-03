import { el } from '../lib/dom.ts'
import { highlightEl, setOverlay, setPage, resolveElementPage } from '../state.ts'
import type { PageElement } from '../types.ts'
import katex from 'katex'
import 'katex/dist/katex.min.css'

export function createElement(data: PageElement): HTMLElement {
  // Headings get rendered as bold section-heading style, not as regular elements
  if (data.heading) {
    return el('div', {
      className: 'section-heading',
      'data-id': data.id,
    }, [data.text])
  }

  const wrapper = el('div', {
    className: `element ${data.type}`,
    'data-id': data.id,
  })

  // Tag
  const tag = el('span', { className: `tag tag-${data.type}` }, [data.type.replace('_', ' ')])
  wrapper.append(tag)

  // Content — switch on type
  switch (data.type) {
    case 'formula':
      renderFormula(wrapper, data)
      break
    case 'table':
      renderTable(wrapper, data)
      break
    case 'figure':
      renderFigure(wrapper, data)
      break
    default:
      renderText(wrapper, data)
  }

  // Cross-references
  if (data.cross_references.length > 0) {
    const refs = el('div', { className: 'xref-list' })
    for (const ref of data.cross_references) {
      const targetPage = resolveElementPage(ref)
      const isResolved = targetPage !== null

      const link = el('span', {
        className: `xref${!isResolved ? ' xref-broken' : ''}`,
      }, [
        `\u2192 ${ref}${!isResolved ? ' [unresolved]' : ''}`,
      ])

      if (isResolved) {
        link.addEventListener('click', (e) => {
          e.stopPropagation()
          setPage(targetPage)
          highlightEl(ref)
        })
      }
      refs.append(link)
    }
    wrapper.append(refs)
  }

  // Metadata (hidden until expanded)
  if (data.metadata || data.cross_references.length > 0) {
    const metaParts: string[] = [`ID: ${data.id}`]
    if (data.metadata) {
      metaParts.push(`Extracted: ${data.metadata.extracted_by}`)
      metaParts.push(`QC: ${data.metadata.qc_status}`)
    }

    const meta = el('div', { className: 'el-meta' }, [metaParts.join(' | ')])

    // Show all xrefs as clickable links in expanded metadata
    if (data.cross_references.length > 0) {
      const refsLine = el('div', { className: 'el-meta-refs' })
      refsLine.append(document.createTextNode('Refs: '))
      for (let i = 0; i < data.cross_references.length; i++) {
        const ref = data.cross_references[i]
        const targetPage = resolveElementPage(ref)
        const link = el('span', {
          className: `xref${targetPage === null ? ' xref-broken' : ''}`,
        }, [ref])
        if (targetPage !== null) {
          link.addEventListener('click', (e) => {
            e.stopPropagation()
            setPage(targetPage)
            highlightEl(ref)
          })
        }
        refsLine.append(link)
        if (i < data.cross_references.length - 1) refsLine.append(document.createTextNode(', '))
      }
      meta.append(refsLine)
    }

    wrapper.append(meta)
  }

  // Click to expand metadata
  wrapper.addEventListener('click', () => {
    wrapper.classList.toggle('expanded')
  })

  return wrapper
}

function renderText(wrapper: HTMLElement, data: PageElement): void {
  wrapper.append(renderBoldText(data.text))
}

/** Parse **bold** markers in text and render as mixed bold/normal spans */
function renderBoldText(text: string): HTMLElement {
  const container = el('span', { className: 'el-text' })
  const parts = text.split(/(\*\*[^*]+\*\*)/)
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**')) {
      container.append(el('span', { className: 'el-bold' }, [part.slice(2, -2)]))
    } else {
      container.append(document.createTextNode(part))
    }
  }
  return container
}

function renderLatex(latex: string): HTMLElement {
  const container = el('span', {})
  try {
    container.innerHTML = katex.renderToString(latex, {
      throwOnError: false,
      displayMode: false,
      trust: true,
    })
  } catch {
    container.textContent = latex
  }
  return container
}

function renderFormula(wrapper: HTMLElement, data: PageElement): void {
  if (data.expression) {
    const exprDiv = el('div', { className: 'el-expression' })
    exprDiv.append(renderLatex(data.expression))
    wrapper.append(exprDiv)
  }
  if (data.parameters && data.parameters.length > 0) {
    const params = el('div', { className: 'el-params' })
    for (const p of data.parameters) {
      // Parameters may contain inline LaTeX (variable = description)
      const paramDiv = el('div', {})
      // Try to render the variable part as LaTeX
      const eqIdx = p.indexOf('=')
      if (eqIdx > 0 && eqIdx < 30) {
        const varPart = p.slice(0, eqIdx).trim()
        const descPart = p.slice(eqIdx + 1).trim()
        paramDiv.append(renderLatex(varPart))
        paramDiv.append(document.createTextNode(' = ' + descPart))
      } else {
        paramDiv.append(document.createTextNode(p))
      }
      params.append(paramDiv)
    }
    wrapper.append(params)
  }
  if (data.text && data.text !== data.expression) {
    wrapper.append(el('span', { className: 'el-text' }, [data.text]))
  }
}

function renderTable(wrapper: HTMLElement, data: PageElement): void {
  if (!data.columns || !data.rows) {
    wrapper.append(el('span', { className: 'el-text' }, [data.text]))
    return
  }

  // Table title
  wrapper.append(el('div', { className: 'el-table-title' }, [data.text]))

  const tableWrap = el('div', { className: 'el-table-wrap' })
  const table = el('table', { className: 'el-table' })
  const thead = el('thead')
  const headerRow = el('tr')
  for (const col of data.columns) {
    headerRow.append(el('th', {}, [col]))
  }
  thead.append(headerRow)
  table.append(thead)

  const tbody = el('tbody')
  const colCount = data.columns.length
  for (const row of data.rows) {
    const tr = el('tr')
    for (let ci = 0; ci < colCount; ci++) {
      const cell = row[ci] ?? ''
      const isNum = /^[\d.,\-+/()\s]+$/.test(cell.trim()) && cell.trim().length > 0
      tr.append(el('td', isNum ? { className: 'num' } : {}, [cell]))
    }
    tbody.append(tr)
  }
  table.append(tbody)
  tableWrap.append(table)
  wrapper.append(tableWrap)
}

function renderFigure(wrapper: HTMLElement, data: PageElement): void {
  if (data.image_url) {
    const img = el('img', {
      src: data.image_url,
      alt: data.caption ?? data.text,
      style: 'max-width:100%;cursor:pointer',
    })
    img.addEventListener('click', (e) => {
      e.stopPropagation()
      setOverlay(data.image_url!)
    })
    wrapper.append(img)
  } else {
    // Placeholder for missing figures
    wrapper.append(el('div', { className: 'figure-placeholder' }, ['[Figure not yet digitized]']))
  }
  const caption = el('span', { className: 'el-text' }, [data.caption ?? data.text])
  wrapper.append(caption)
}
