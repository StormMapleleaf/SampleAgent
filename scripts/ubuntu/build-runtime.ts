/**
 * Assemble the self-contained Linux runtime tree shipped by the Ubuntu
 * distribution: a symlink-free production closure, the locked Node.js and pnpm,
 * the launcher, and the release tarball.
 *
 * The tree layout is the install prefix the `.deb` and `install.sh` deliver:
 * `bin/dsh`, `app/` (the closure), and `runtime/{node,pnpm}`. Building it on the
 * target architecture is required because the closure carries platform-optional
 * native packages (`@vscode/ripgrep-*`, `node-pty` prebuilds, the Landlock
 * packages), which pnpm only installs for the host it resolves on.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, cp, glob, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pnpmInvocation, verifyStagedDependencies } from '../executable-packaging.ts'
import { deduplicateStagedWorkspacePackages, materializeStagedLinks } from '../build-exe-for-python-sdk-staging.ts'
import { downloadNodeRuntime, type PrimaryRuntimeTarget } from '../primary-runtime/prepare.ts'
import branding from '../../packaging/ubuntu/branding.json' with { type: 'json' }
import runtimeLock from '../primary-runtime/lock.json' with { type: 'json' }

const ROOT = resolve(import.meta.dirname, '../..')
const REPOSITORY_ROOT_PACKAGE = join(ROOT, 'package.json')
const CLOSURE_PACKAGE = 'dsh-ubuntu-closure'
const DEFAULT_OUT = join(ROOT, 'dist', 'ubuntu')

/** One Linux release target and the arch names each consumer spells. */
export interface LinuxTarget {
  /** Runtime lock key, also the release artifact suffix. */
  readonly target: PrimaryRuntimeTarget
  /** pnpm os-arch selector and tarball suffix. */
  readonly arch: 'x64' | 'arm64'
  /** Debian architecture name. */
  readonly debArch: 'amd64' | 'arm64'
  /** Node.js process arch that must build this target. */
  readonly nodeArch: 'x64' | 'arm64'
}

/** Supported Linux release targets. */
export const LINUX_TARGETS: Readonly<Record<string, LinuxTarget>> = {
  'linux-x64': { target: 'linux-x64', arch: 'x64', debArch: 'amd64', nodeArch: 'x64' },
  'linux-arm64': { target: 'linux-arm64', arch: 'arm64', debArch: 'arm64', nodeArch: 'arm64' },
}

/** Artifacts this builder requires from an earlier `pnpm run build`. */
const BUILD_ARTIFACTS = [
  'apps/cli/lib/bin.js',
  'apps/web/dist/index.html',
  'packages/bundle/web-app/lib/index.js',
  'packages/bundle/base/lib/index.js',
] as const

/**
 * Convert a repository version into a Debian version.
 *
 * Debian versions sort `~` before the empty string, so a prerelease sorts before
 * its release, and every version carries an explicit revision.
 * @param version - `X.Y.Z` or `X.Y.Z-<prerelease>`.
 * @returns the Debian spelling, for example `0.2.2~rc.1-1`.
 */
export function debVersion(version: string): string {
  const match = /^(\d+\.\d+\.\d+)(?:-(.+))?$/u.exec(version)
  if (match === null) throw new Error(`linux-dist: version ${JSON.stringify(version)} is not X.Y.Z or X.Y.Z-<prerelease>`)
  const [, core, prerelease] = match
  if (core === undefined) throw new Error(`linux-dist: version ${JSON.stringify(version)} has no core`)
  if (prerelease === undefined) return `${core}-1`
  const normalized = prerelease.replace(/[^0-9A-Za-z.+]/gu, '~')
  return `${core}~${normalized}-1`
}

/**
 * Name the release tarball for one target.
 * @param version - repository version.
 * @param target - selected Linux target.
 * @returns the artifact basename.
 */
export function archiveName(version: string, target: LinuxTarget): string {
  return `${branding.packageName}-${version}-linux-${target.arch}.tar.gz`
}

/** Absolute paths of the parts the launcher resolves at run time. */
export interface InstalledLayout {
  readonly bin: string
  readonly alias: string
  readonly app: string
  readonly node: string
  readonly pnpm: string
}

/**
 * Describe the installed layout a prefix receives.
 * @param prefix - installation prefix such as `/opt/sampleagent`.
 * @returns absolute paths of the parts the launcher resolves at run time.
 */
export function installLayout(prefix: string): InstalledLayout {
  return {
    bin: join(prefix, 'bin', branding.binaryName),
    alias: join(prefix, 'bin', branding.aliasName),
    app: join(prefix, 'app'),
    node: join(prefix, 'runtime', 'node', 'bin', 'node'),
    pnpm: join(prefix, 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
  }
}

/**
 * Render the launcher that runs the bundled CLI with the bundled interpreter.
 *
 * It resolves its own symbolic links first, so `install.sh` can link
 * `~/.local/bin/dsh` to a versioned directory.
 * @param binaryName - installed command name.
 * @returns the POSIX shell launcher.
 */
export function launcherScript(binaryName: string): string {
  return `#!/bin/sh
# Run ${binaryName} with the Node.js and pnpm bundled beside this launcher.
set -e
self=$0
while [ -L "$self" ]; do
  directory=$(CDPATH= cd -- "$(dirname -- "$self")" && pwd -P)
  target=$(readlink "$self")
  case $target in
    /*) self=$target ;;
    *) self=$directory/$target ;;
  esac
done
root=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd -P)
export PATH="$root/runtime/node/bin:$root/runtime/pnpm/bin:$PATH"
exec "$root/runtime/node/bin/node" "$root/app/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"
`
}

/**
 * Render the pnpm shim the launcher exposes on PATH, so `dsh plugin` resolves
 * the bundled package manager instead of a host installation.
 * @returns the POSIX shell shim.
 */
export function pnpmShimScript(): string {
  return `#!/bin/sh
# Run the pnpm bundled with this runtime.
set -e
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec "$here/../../node/bin/node" "$here/pnpm.mjs" "$@"
`
}

/**
 * Read the repository version that this distribution reports.
 * @returns the version from the root manifest.
 */
async function repositoryVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(REPOSITORY_ROOT_PACKAGE, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('linux-dist: the root package.json has no version')
  return manifest.version
}

/**
 * Require the artifacts `pnpm run build` produces.
 * @param root - repository root.
 */
function assertBuildArtifacts(root: string): void {
  const missing = BUILD_ARTIFACTS.filter(artifact => !existsSync(join(root, artifact)))
  if (missing.length > 0) {
    throw new Error(`linux-dist: missing build artifacts ${missing.join(', ')}; run "pnpm run build" first.`)
  }
}

/**
 * Run one command to completion and fail loudly on a non-zero status.
 * @param command - executable.
 * @param args - arguments.
 * @param cwd - working directory.
 */
function runCommand(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'inherit', 'inherit'] })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`linux-dist: ${command} ${args.join(' ')} exited with ${String(code)}`))
    })
  })
}

/**
 * Run pnpm from the repository root with build-host hooks removed.
 * @param args - pnpm arguments.
 */
function runPnpm(args: readonly string[]): Promise<void> {
  const [command, invocationArgs] = pnpmInvocation([...args])
  console.log(`linux-dist: ${command} ${args.slice(0, 4).join(' ')} ...`)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, invocationArgs, {
      cwd: ROOT,
      stdio: 'inherit',
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_OPTIONS' && name !== 'NODE_PATH')),
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`linux-dist: pnpm ${args[0] ?? ''} exited with ${String(code)}`))
    })
  })
}

/**
 * Deploy the closure into a symlink-free production tree.
 * @param appDir - install-time `app/` directory.
 */
async function deployClosure(appDir: string): Promise<void> {
  await runPnpm([
    '--filter', CLOSURE_PACKAGE,
    'deploy', '--prod',
    '--config.allow-unused-patches=true',
    '--config.node-linker=hoisted',
    `--config.pnpmfile=${join(ROOT, 'scripts', 'python-runtime-deploy.pnpmfile.mjs')}`,
    '--config.link-workspace-packages=true',
    '--config.hoist-workspace-packages=false',
    appDir,
  ])
  await materializeStagedLinks(appDir)
  await deduplicateStagedWorkspacePackages(appDir, appDir)
  await verifyStagedDependencies(appDir)
}

/**
 * Drop documentation, source maps, and type declarations a runtime never reads.
 * @param appDir - deployed closure.
 */
async function prunePayload(appDir: string): Promise<void> {
  for (const name of ['README.md', 'README.zh.md', 'README.i18n.yaml']) {
    await rm(join(appDir, name), { force: true })
  }
  for await (const file of glob('node_modules/**/{README*.md,CHANGELOG*.md,HISTORY*.md,*.map,*.d.ts,*.d.mts,*.d.cts}', {
    cwd: appDir,
    exclude: ['node_modules/**/assets/**'],
  })) {
    await rm(join(appDir, file), { force: true })
  }
}

/**
 * Stage the locked Node.js runtime.
 * @param prefix - install prefix being assembled.
 * @param target - selected Linux target.
 * @param cache - verified archive cache.
 */
async function stageNode(prefix: string, target: LinuxTarget, cache: string): Promise<void> {
  await downloadNodeRuntime(target.target, join(prefix, 'runtime', 'node'), cache)
}

/**
 * Locate the pnpm package this repository installs.
 *
 * pnpm's `exports` maps its own root to `package.json`, and it does not export
 * the subpath, so the bare specifier is the only resolvable form. A store that
 * placed a real directory instead of a link still resolves through the same
 * entry.
 * @returns the package manifest path.
 */
export function pnpmManifestPath(): string {
  try {
    return createRequire(import.meta.url).resolve('pnpm')
  } catch {
    const directory = join(ROOT, 'node_modules', 'pnpm')
    if (existsSync(join(directory, 'package.json'))) return join(directory, 'package.json')
    throw new Error('linux-dist: the repository pnpm package is missing; run "pnpm install" at the repository root.')
  }
}

/**
 * Stage the pnpm package this repository installs, plus its PATH shim.
 * @param prefix - install prefix being assembled.
 * @returns the staged pnpm version.
 */
async function stagePnpm(prefix: string): Promise<string> {
  const manifestPath = pnpmManifestPath()
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('linux-dist: the installed pnpm has no version')
  const destination = join(prefix, 'runtime', 'pnpm')
  await cp(dirname(manifestPath), destination, { recursive: true, dereference: true })
  const bin = join(destination, 'bin')
  await writeFile(join(bin, 'pnpm'), pnpmShimScript())
  await chmod(join(bin, 'pnpm'), 0o755)
  return manifest.version
}

/**
 * Require the native payload the runtime commands depend on.
 * @param appDir - deployed closure.
 * @param target - selected Linux target.
 */
function verifyNativePayload(appDir: string, target: LinuxTarget): void {
  const nodePty = join(appDir, 'node_modules', 'node-pty')
  const candidates = [
    join(nodePty, 'build', 'Release', 'pty.node'),
    join(nodePty, 'prebuilds', `linux-${target.arch}`, 'pty.node'),
  ]
  if (!candidates.some(existsSync)) {
    throw new Error(`linux-dist: node-pty has no linux-${target.arch} addon; the deploy resolved a different platform.`)
  }
  const ripgrep = join(appDir, 'node_modules', '@vscode', `ripgrep-linux-${target.arch}`, 'bin', 'rg')
  if (!existsSync(ripgrep)) {
    throw new Error(`linux-dist: @vscode/ripgrep-linux-${target.arch} is missing; the deploy resolved a different platform.`)
  }
}

/**
 * Write the launcher and the files the deb and tarball carry.
 * @param prefix - install prefix being assembled.
 * @param version - repository version.
 * @param target - selected Linux target.
 * @param pnpmVersion - staged pnpm version.
 */
async function writeMetadata(prefix: string, version: string, target: LinuxTarget, pnpmVersion: string): Promise<void> {
  const layout = installLayout(prefix)
  await mkdir(dirname(layout.bin), { recursive: true })
  await writeFile(layout.bin, launcherScript(branding.binaryName))
  await chmod(layout.bin, 0o755)
  await rm(layout.alias, { force: true })
  await runCommand('ln', ['-s', branding.binaryName, layout.alias], dirname(layout.bin))
  await writeFile(join(prefix, 'VERSION'), `${version}\n`)
  const manifest = {
    schemaVersion: 1,
    version,
    target: target.target,
    node: runtimeLock.nodeVersion,
    pnpm: pnpmVersion,
  }
  await writeFile(join(prefix, 'runtime.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    if (existsSync(join(ROOT, name))) await cp(join(ROOT, name), join(prefix, name))
  }
}

/**
 * Pack the assembled prefix as the release tarball and record its checksum.
 * @param out - output directory.
 * @param prefix - install prefix being assembled.
 * @param version - repository version.
 * @param target - selected Linux target.
 * @returns the tarball path.
 */
async function writeArchive(out: string, prefix: string, version: string, target: LinuxTarget): Promise<string> {
  if (dirname(prefix) !== resolve(out)) {
    throw new Error(`linux-dist: the tarball member must be ${join(out, branding.packageName)}, found ${prefix}`)
  }
  const file = join(out, archiveName(version, target))
  await runCommand('tar', ['-czf', file, '--', basename(prefix)], out)
  const digest = createHash('sha256').update(await readFile(file)).digest('hex')
  await writeFile(join(out, 'SHA256SUMS'), `${digest}  ${archiveName(version, target)}\n`)
  await writeFile(join(out, 'VERSION'), `${version}\n`)
  await cp(join(ROOT, 'scripts', 'ubuntu', 'install.sh'), join(out, 'install.sh'))
  await chmod(join(out, 'install.sh'), 0o755)
  console.log(`linux-dist: ${file}`)
  return file
}

/**
 * Start the assembled CLI and require the reported version.
 * @param prefix - assembled install prefix.
 * @param version - expected version.
 */
function smokeRuntime(prefix: string, version: string): Promise<void> {
  const { bin } = installLayout(prefix)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`linux-dist: ${bin} --version exited with ${String(code)}`))
        return
      }
      if (output.trim() !== version) {
        reject(new Error(`linux-dist: ${bin} --version reported ${JSON.stringify(output.trim())}, expected ${version}`))
        return
      }
      console.log(`linux-dist: smoke passed (${bin} --version)`)
      resolvePromise()
    })
  })
}

/**
 * Assemble one Linux target.
 * @param target - selected Linux target.
 * @param out - output directory receiving `dsh/`, the tarball, and checksums.
 * @param options - cache location and whether to keep the smoke check.
 */
async function build(target: LinuxTarget, out: string, options: { cache: string; skipSmoke: boolean }): Promise<void> {
  const version = await repositoryVersion()
  const prefix = join(out, branding.packageName)
  console.log(`linux-dist: building dsh ${version} for ${target.target} into ${out}`)
  await rm(prefix, { recursive: true, force: true })
  await mkdir(join(prefix, 'app'), { recursive: true })

  console.log('linux-dist: deploying the closure')
  await deployClosure(join(prefix, 'app'))
  console.log('linux-dist: pruning the payload')
  await prunePayload(join(prefix, 'app'))
  console.log('linux-dist: staging Node.js')
  await stageNode(prefix, target, options.cache)
  console.log('linux-dist: staging pnpm')
  const pnpmVersion = await stagePnpm(prefix)
  console.log('linux-dist: verifying the native payload')
  verifyNativePayload(join(prefix, 'app'), target)
  console.log('linux-dist: writing metadata')
  await writeMetadata(prefix, version, target, pnpmVersion)
  console.log('linux-dist: packing the tarball')
  await writeArchive(out, prefix, version, target)
  if (!options.skipSmoke) await smokeRuntime(prefix, version)

  const size = await stat(join(out, archiveName(version, target)))
  console.log(`linux-dist: ${archiveName(version, target)} is ${String(Math.round(size.size / 1024 / 1024))} MiB`)
}

/**
 * Assert this host can produce the selected target.
 * @param target - selected Linux target.
 */
function assertHost(target: LinuxTarget): void {
  if (process.platform !== 'linux' || process.arch !== target.nodeArch) {
    throw new Error(
      `linux-dist: ${target.target} must be built on linux-${target.nodeArch} (this host is ${process.platform}-${process.arch}); `
      + 'the closure carries platform-optional native packages that are only resolved for the build host.',
    )
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    target: { type: 'string' },
    out: { type: 'string' },
    cache: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'skip-smoke': { type: 'boolean', default: false },
  } })
  const name = values.target ?? `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  const target = LINUX_TARGETS[name]
  if (target === undefined) throw new Error(`linux-dist: --target must be one of ${Object.keys(LINUX_TARGETS).join(', ')}`)
  const out = resolve(values.out ?? DEFAULT_OUT)
  assertBuildArtifacts(ROOT)
  if (values['dry-run']) {
    console.log(`linux-dist: [dry-run] build ${name} into ${out}`)
    console.log(`linux-dist: [dry-run] deploy ${CLOSURE_PACKAGE} into ${join(out, branding.packageName, 'app')}`)
    console.log(`linux-dist: [dry-run] stage node ${runtimeLock.nodeVersion} and the repository pnpm`)
    return
  }
  assertHost(target)
  await build(target, out, {
    cache: resolve(values.cache ?? join(out, 'downloads')),
    skipSmoke: values['skip-smoke'],
  })
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(`linux-dist: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
