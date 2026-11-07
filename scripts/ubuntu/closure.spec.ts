import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { verifyRuntimeClosure } from '../verify-runtime-closure.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const MANIFEST = 'packaging/ubuntu/package.json'

describe('Ubuntu distribution closure', () => {
  it('is the deploy root the assembly script filters on', () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, MANIFEST), 'utf8')) as { name?: string }
    expect(manifest.name).toBe('dsh-ubuntu-closure')
  })

  it('supplies every plugin the shipped bundles activate', async () => {
    const result = await verifyRuntimeClosure(ROOT, MANIFEST, true)
    expect(result.failures).toEqual([])
    expect(result.workspacePackageCount).toBeGreaterThan(0)
  }, 60_000)
})
