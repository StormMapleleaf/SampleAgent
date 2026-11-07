import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { archiveName, debVersion, installLayout, launcherScript, LINUX_TARGETS, pnpmManifestPath, pnpmShimScript } from './build-runtime.ts'

describe('debVersion', () => {
  it('maps a release to a Debian version with revision 1', () => {
    expect(debVersion('0.2.2')).toBe('0.2.2-1')
  })

  it('sorts a prerelease before its release with a tilde', () => {
    expect(debVersion('0.2.2-rc.1')).toBe('0.2.2~rc.1-1')
  })

  it('normalizes characters Debian version syntax does not allow', () => {
    expect(debVersion('1.0.0-beta+sha_1')).toBe('1.0.0~beta+sha~1-1')
  })

  it('rejects a version without a plain X.Y.Z core', () => {
    expect(() => debVersion('v0.2.2')).toThrow(/not X\.Y\.Z/u)
    expect(() => debVersion('0.2')).toThrow(/not X\.Y\.Z/u)
  })
})

describe('archiveName', () => {
  it('names the tarball after the version and runtime arch', () => {
    expect(archiveName('0.2.2-rc.1', LINUX_TARGETS['linux-x64']!)).toBe('dsh-0.2.2-rc.1-linux-x64.tar.gz')
    expect(archiveName('0.2.2', LINUX_TARGETS['linux-arm64']!)).toBe('dsh-0.2.2-linux-arm64.tar.gz')
  })
})

describe('installLayout', () => {
  it('places the launcher, closure, and interpreters under the prefix', () => {
    const layout = installLayout('/opt/dsh')
    expect(layout.bin).toBe('/opt/dsh/bin/dsh')
    expect(layout.app).toBe('/opt/dsh/app')
    expect(layout.node).toBe('/opt/dsh/runtime/node/bin/node')
    expect(layout.pnpm).toBe('/opt/dsh/runtime/pnpm/bin/pnpm.mjs')
  })
})

describe('launcherScript', () => {
  const script = launcherScript('dsh')

  it('resolves a chain of symlinks before deriving the install root', () => {
    expect(script).toContain('while [ -L "$self" ]')
    expect(script).toContain('root=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd -P)')
  })

  it('runs the bundled interpreter with the bundled package manager on PATH', () => {
    expect(script).toContain('export PATH="$root/runtime/node/bin:$root/runtime/pnpm/bin:$PATH"')
    expect(script).toContain('exec "$root/runtime/node/bin/node" "$root/app/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"')
  })

  it('uses the requested binary name in its comment', () => {
    expect(launcherScript('mydsh')).toContain('# Run mydsh with')
  })

  it('is POSIX shell without bashisms', () => {
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).not.toMatch(/\b(?:function|local|source)\b/u)
    expect(script).not.toContain('[[')
  })
})

describe('pnpmShimScript', () => {
  const script = pnpmShimScript()

  it('executes the bundled pnpm entry with the sibling node', () => {
    expect(script).toContain('exec "$here/../../node/bin/node" "$here/pnpm.mjs" "$@"')
  })

  it('derives its own directory from the invoked path', () => {
    expect(script).toContain('here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)')
  })
})

describe('pnpmManifestPath', () => {
  it('resolves the installed pnpm package manifest', async () => {
    const manifest = JSON.parse(await readFile(pnpmManifestPath(), 'utf8')) as { name?: string; version?: string }
    expect(manifest.name).toBe('pnpm')
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/u)
  })
})
