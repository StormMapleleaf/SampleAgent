import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { installedSizeKib, renderTemplate, type TemplateValues } from './build-deb.ts'

const fixtures: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deb-'))
  fixtures.push(root)
  return root
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true })
})

const VALUES: TemplateValues = {
  PACKAGE: 'dsh',
  VERSION: '0.2.2~rc.1-1',
  ARCH: 'amd64',
  MAINTAINER: 'Maintainer <dsh@example.com>',
  INSTALLED_SIZE: '1234',
  HOMEPAGE: 'https://example.com/dsh',
  DESCRIPTION: 'DSH runtime',
  APP_NAME: 'DSH',
  BINARY: 'dsh',
  PORT: '3080',
}

describe('renderTemplate', () => {
  it('replaces every placeholder once', () => {
    expect(renderTemplate('Version: {{VERSION}} ({{ARCH}})', VALUES)).toBe('Version: 0.2.2~rc.1-1 (amd64)')
  })

  it('rejects a placeholder without a value instead of shipping it literally', () => {
    expect(() => renderTemplate('Port: {{PORT}}', {})).toThrow(/PORT/u)
  })

  it('ignores single braces and lowercase names', () => {
    expect(renderTemplate('{ {PORT}} {{port}}', { PORT: '1' })).toBe('{ {PORT}} {{port}}')
  })
})

describe('installedSizeKib', () => {
  it('rounds the payload up to whole KiB', async () => {
    const root = fixture()
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'dsh'), Buffer.alloc(2048))
    expect(await installedSizeKib(root)).toBe(2)

    writeFileSync(join(root, 'small'), Buffer.alloc(1))
    expect(await installedSizeKib(root)).toBe(3)
  })

  it('counts nested directories', async () => {
    const root = fixture()
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'file'), Buffer.alloc(1024))
    expect(await installedSizeKib(root)).toBe(1)
  })
})

describe('shipped deb templates', () => {
  const templates = [
    'packaging/ubuntu/deb/DEBIAN/control.in',
    'packaging/ubuntu/deb/systemd/dsh-web.service',
    'packaging/ubuntu/deb/applications/dsh.desktop',
  ]

  it.each(templates)('renders %s with no placeholder left behind', (relative) => {
    const rendered = renderTemplate(readFileSync(resolve(import.meta.dirname, '../..', relative), 'utf8'), { ...VALUES })
    expect(rendered).not.toContain('{{')
    expect(rendered.endsWith('\n')).toBe(true)
  })

  it('declares the sandbox runner the base profile requires', () => {
    const control = renderTemplate(readFileSync(resolve(import.meta.dirname, '../..', templates[0]!), 'utf8'), { ...VALUES })
    expect(control).toMatch(/^Depends: .*\bbubblewrap\b/mu)
    expect(control).toContain('Version: 0.2.2~rc.1-1')
    expect(control).toContain('Architecture: amd64')
  })

  it('starts the Web UI without opening a browser', () => {
    const unit = renderTemplate(readFileSync(resolve(import.meta.dirname, '../..', templates[1]!), 'utf8'), { ...VALUES })
    expect(unit).toContain('ExecStart=/usr/bin/dsh web --no-open --port 3080')
    expect(unit).toContain('Environment=DSH_HOME=%h/.dsh')
  })
})
