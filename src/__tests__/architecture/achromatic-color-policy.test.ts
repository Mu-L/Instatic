/**
 * Architecture Gate Tests - Achromatic color policy.
 *
 * Keeps editor and admin shell styling on the token-driven neutral palette by
 * blocking hardcoded tinted Tailwind color utility classes.
 */

import { describe, it, expect } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

const SRC_ROOT = join(import.meta.dir, '../../')
const ADMIN_DIR = join(SRC_ROOT, 'admin')
const MODULES_DIR = join(SRC_ROOT, 'modules')
const UI_DIR = join(SRC_ROOT, 'ui')
const TINTED_CLASS_RE = /\b(zinc|slate|blue|indigo|violet)-\d{2,3}\b/

function collectTs(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const info = statSync(full)
    if (info.isDirectory()) {
      results.push(...collectTs(full))
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      results.push(full)
    }
  }

  return results
}

function assertNoTintedClasses(label: string, dir: string) {
  const violations: { file: string; line: number; content: string }[] = []

  for (const filePath of collectTs(dir)) {
    let source: string
    try {
      source = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }

    source.split('\n').forEach((line, index) => {
      if (/^\s*\/\//.test(line)) return
      if (/^\s*\/\*/.test(line)) return

      if (TINTED_CLASS_RE.test(line)) {
        violations.push({
          file: filePath.replace(SRC_ROOT, 'src/'),
          line: index + 1,
          content: line.trim().slice(0, 120),
        })
      }
    })
  }

  if (violations.length > 0) {
    throw new Error(
      `Tinted Tailwind color classes found in ${label}.\n` +
        'Use editor design tokens instead of zinc-*, slate-*, blue-*, indigo-*, or violet-* classes.\n' +
        'Violations:\n' +
        violations
          .map((violation) => `  ${violation.file}:${violation.line} -> ${violation.content}`)
          .join('\n'),
    )
  }

  expect(violations).toHaveLength(0)
}

describe('Achromatic color policy', () => {
  it('does not use tinted Tailwind color classes in src/admin/**', () => {
    assertNoTintedClasses('src/admin/', ADMIN_DIR)
  })

  it('does not use tinted Tailwind color classes in src/modules/**', () => {
    assertNoTintedClasses('src/modules/', MODULES_DIR)
  })

  it('does not use tinted Tailwind color classes in src/ui/**', () => {
    assertNoTintedClasses('src/ui/', UI_DIR)
  })
})
