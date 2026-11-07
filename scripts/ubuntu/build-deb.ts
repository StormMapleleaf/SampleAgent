/**
 * Package an assembled runtime prefix as a Debian package, plus the metadata
 * Ubuntu needs to install it: dependency declarations, the launcher link, a
 * systemd user unit, a desktop entry, and the copyright file.
 *
 * The package installs the prefix under `/opt/dsh` and never touches `~/.dsh`,
 * so removing the package keeps profiles and sessions.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { debVersion, installLayout, LINUX_TARGETS, type LinuxTarget } from './build-runtime.ts'
import branding from '../../packaging/ubuntu/branding.json' with { type: 'json' }

const ROOT = resolve(import.meta.dirname, '../..')
const DEB_TEMPLATES = join(ROOT, 'packaging', 'ubuntu', 'deb')
const DEFAULT_OUT = join(ROOT, 'dist', 'ubuntu')

/** Values the deb templates interpolate. */
export interface TemplateValues extends Readonly<Record<string, string>> {
  readonly PACKAGE: string
  readonly VERSION: string
  readonly ARCH: string
  readonly MAINTAINER: string
  readonly INSTALLED_SIZE: string
  readonly HOMEPAGE: string
  readonly DESCRIPTION: string
  readonly APP_NAME: string
  readonly BINARY: string
  readonly PORT: string
}

/**
 * Replace every `{{NAME}}` placeholder in one template.
 * @param template - template text.
 * @param values - replacement values.
 * @returns the rendered text; an unknown placeholder fails instead of shipping a literal.
 */
export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/gu, (_match, name: string) => {
    const value = values[name]
    if (value === undefined) throw new Error(`linux-deb: template placeholder ${name} has no value`)
    return value
  })
}

/**
 * Measure the installed payload the way dpkg reports it.
 * @param root - package root directory.
 * @returns the size in KiB, rounded up as dpkg expects.
 */
export async function installedSizeKib(root: string): Promise<number> {
  let bytes = 0
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) bytes += (await stat(path)).size
    }
  }
  await walk(root)
  return Math.ceil(bytes / 1024)
}

/**
 * Run one command and require a zero exit status.
 * @param command - executable.
 * @param args - arguments.
 * @param cwd - working directory.
 * @returns the captured stdout.
 */
function run(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolvePromise(output)
      else reject(new Error(`linux-deb: ${command} ${args.join(' ')} exited with ${String(code)}`))
    })
  })
}

/**
 * Render the deb templates into the package root.
 * @param root - package root.
 * @param values - template values.
 */
async function renderIntegration(root: string, values: TemplateValues): Promise<void> {
  const templateValues: Readonly<Record<string, string>> = { ...values }
  const templates = [
    { source: join(DEB_TEMPLATES, 'DEBIAN', 'control.in'), destination: join(root, 'DEBIAN', 'control'), mode: 0o644 },
    { source: join(DEB_TEMPLATES, 'DEBIAN', 'postinst'), destination: join(root, 'DEBIAN', 'postinst'), mode: 0o755 },
    { source: join(DEB_TEMPLATES, 'DEBIAN', 'prerm'), destination: join(root, 'DEBIAN', 'prerm'), mode: 0o755 },
    {
      source: join(DEB_TEMPLATES, 'systemd', 'dsh-web.service'),
      destination: join(root, 'usr', 'lib', 'systemd', 'user', `${branding.packageName}-web.service`),
      mode: 0o644,
    },
    {
      source: join(DEB_TEMPLATES, 'applications', 'dsh.desktop'),
      destination: join(root, 'usr', 'share', 'applications', `${branding.packageName}.desktop`),
      mode: 0o644,
    },
  ]
  for (const { source, destination, mode } of templates) {
    const rendered = renderTemplate(await readFile(source, 'utf8'), templateValues)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, rendered)
    await chmod(destination, mode)
  }
}

/**
 * Write the Debian copyright file from the repository license.
 * @param root - package root.
 * @param values - template values.
 */
async function writeCopyright(root: string, values: TemplateValues): Promise<void> {
  const license = await readFile(join(ROOT, 'LICENSE'), 'utf8')
  const indented = license.trimEnd().split('\n').map(line => ` ${line}`.trimEnd()).join('\n')
  const text = `Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: ${values.PACKAGE}
Source: ${values.HOMEPAGE}

Files: *
Copyright: DeepSeek
License: MIT
${indented}
`
  await writeFile(join(root, 'usr', 'share', 'doc', branding.packageName, 'copyright'), text)
}

/**
 * Assemble the Debian package root without invoking `dpkg-deb`.
 * @param options - runtime tree, output directory, target, and optional icon.
 * @returns the package root, its resolved version, and the intended package path.
 */
export async function stageDeb(options: {
  readonly prefix: string
  readonly out: string
  readonly target: LinuxTarget
  readonly icon?: string
}): Promise<{ readonly root: string; readonly version: string; readonly file: string }> {
  const version = (await readFile(join(options.prefix, 'VERSION'), 'utf8')).trim()
  const root = join(options.out, 'deb-root')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })

  await cp(options.prefix, join(root, 'opt', branding.packageName), { recursive: true, dereference: true })
  await mkdir(join(root, 'usr', 'bin'), { recursive: true })
  for (const name of [branding.binaryName, branding.aliasName]) {
    await run('ln', ['-s', join(branding.installDir, 'bin', branding.binaryName), join(root, 'usr', 'bin', name)], root)
  }
  if (options.icon !== undefined) {
    const icon = join(root, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps', `${branding.packageName}.png`)
    await mkdir(dirname(icon), { recursive: true })
    await cp(options.icon, icon)
  }
  await mkdir(join(root, 'usr', 'share', 'doc', branding.packageName), { recursive: true })

  const values: TemplateValues = {
    PACKAGE: branding.packageName,
    VERSION: debVersion(version),
    ARCH: options.target.debArch,
    MAINTAINER: branding.maintainer,
    INSTALLED_SIZE: String(await installedSizeKib(root)),
    HOMEPAGE: branding.homepage,
    DESCRIPTION: branding.description,
    APP_NAME: branding.appName,
    BINARY: branding.binaryName,
    PORT: String(branding.defaultPort),
  }
  await renderIntegration(root, values)
  await writeCopyright(root, values)
  return { root, version: values.VERSION, file: join(options.out, `${branding.packageName}_${values.VERSION}_${values.ARCH}.deb`) }
}

/**
 * Build the `.deb` from an assembled runtime tree.
 * @param options - runtime tree, output directory, target, optional icon, and whether to keep the staging root.
 * @returns the package path.
 */
export async function buildDeb(options: {
  readonly prefix: string
  readonly out: string
  readonly target: LinuxTarget
  readonly icon?: string
  readonly keepRoot?: boolean
}): Promise<string> {
  const staged = await stageDeb(options)
  await run('dpkg-deb', ['--root-owner-group', '--build', staged.root, staged.file], options.out)
  console.log((await run('dpkg-deb', ['--field', staged.file], options.out)).trimEnd())
  if (options.keepRoot !== true) await rm(staged.root, { recursive: true, force: true })
  return staged.file
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    runtime: { type: 'string' },
    out: { type: 'string' },
    target: { type: 'string' },
    icon: { type: 'string' },
    'keep-root': { type: 'boolean', default: false },
    'stage-only': { type: 'boolean', default: false },
  } })
  const out = resolve(values.out ?? DEFAULT_OUT)
  const prefix = resolve(values.runtime ?? join(out, branding.packageName))
  if (!existsSync(join(prefix, 'VERSION'))) {
    throw new Error(`linux-deb: ${prefix} is not an assembled runtime; run scripts/ubuntu/build-runtime.ts first.`)
  }
  const name = values.target ?? `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  const target = LINUX_TARGETS[name]
  if (target === undefined) throw new Error(`linux-deb: --target must be one of ${Object.keys(LINUX_TARGETS).join(', ')}`)
  if (process.platform !== 'linux' && !values['stage-only']) {
    throw new Error('linux-deb: dpkg-deb is required; build the package on Linux, or use --stage-only to assemble the root elsewhere.')
  }
  const icon = values.icon === undefined ? undefined : resolve(values.icon)
  if (values['stage-only']) {
    const staged = await stageDeb({ prefix, out, target, ...(icon === undefined ? {} : { icon }) })
    console.log(`linux-deb: staged ${staged.root}; build it with dpkg-deb --root-owner-group --build <root> ${staged.file}`)
    return
  }
  const file = await buildDeb({ prefix, out, target, ...(icon === undefined ? {} : { icon }), keepRoot: values['keep-root'] })
  console.log(`linux-deb: ${file}`)
  const layout = installLayout(branding.installDir)
  console.log(`linux-deb: installs ${layout.bin} with the runtime under ${branding.installDir}`)
}

if (import.meta.main) await main()
