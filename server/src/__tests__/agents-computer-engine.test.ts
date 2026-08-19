/**
 * Unit tests for BYOA local engine adapters.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-engine.test.ts
 */
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { getAdapter, resolveSpawn } from '../agents/computer/engine.js'

const IS_WIN = process.platform === 'win32'
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test('local engine failure returns stderr tail for observability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)
  const fakeClaude = join(binDir, 'claude')
  await writeFile(
    fakeClaude,
    '#!/bin/sh\n' +
    'echo "Claude Code error: usage limit reached, no tokens left" >&2\n' +
    'exit 1\n',
    'utf8',
  )
  await chmod(fakeClaude, 0o755)

  const logs: string[] = []
  const result = await getAdapter('claude').run({
    home,
    prompt: 'wake',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    model: null,
    fastModel: null,
    onLog: (line) => logs.push(line),
    signal: new AbortController().signal,
  })

  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /usage limit reached, no tokens left/i)
  assert.deepEqual(logs, ['Claude Code error: usage limit reached, no tokens left'])
})

test('persistent Claude startup failure keeps stderr for first send', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-session-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)
  const fakeClaude = join(binDir, 'claude')
  await writeFile(
    fakeClaude,
    '#!/bin/sh\n' +
    'echo "Claude Code error: subscription expired" >&2\n' +
    'exit 1\n',
    'utf8',
  )
  await chmod(fakeClaude, 0o755)

  const logs: string[] = []
  const session = getAdapter('claude').startSession?.({
    home,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    model: null,
    fastModel: null,
    onLog: (line) => logs.push(line),
  })

  assert.ok(session)
  await delay(50)
  const result = await session.send('wake')

  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /subscription expired/i)
  // The engine's stderr passes through verbatim, followed by the session-death
  // trace (die() now ALWAYS logs a process death — idle deaths used to be
  // silent, which made fleet-wide session disappearances undiagnosable).
  assert.equal(logs[0], 'Claude Code error: subscription expired')
  assert.equal(logs.length, 2)
  assert.match(logs[1] ?? '', /\[session\] engine process died .*exit 1/)
  })

  // Regression: nvm-windows on Windows ships an extensionless POSIX shell-shim
  // (`#!/bin/sh` wrapper) alongside the real `.cmd`. The OLD resolveSpawn iterated
  // `['', ...PATHEXT]` → matched the shim first → returned `shell:false` → Node
  // could not exec the shim and every BYOA turn died with ENOENT.
  // See https://github.com/yetone/cumora/issues/5
  test('resolveSpawn prefers .cmd over extensionless shim on Windows', { skip: !IS_WIN }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cumora-resolve-'))
    tempDirs.push(root)
    const binDir = join(root, 'bin')
    await mkdir(binDir)
    // Both files exist — mirrors the standard nvm-windows layout.
    await writeFile(join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', 'utf8')
    await writeFile(join(binDir, 'claude.cmd'), '@echo off\nexit /b 0\n', 'utf8')
    process.env.PATH = `${binDir};${process.env.PATH ?? ''}`
    const r = resolveSpawn('claude')
    // NTFS is case-insensitive, and Windows resolves `claude.cmd` as `claude.CMD`
    // — compare with a normalized basename so the test passes regardless of FS.
    assert.equal(
      r.command.toLowerCase().endsWith('claude.cmd'),
      true,
      `must pick the .cmd, not the shim — got ${r.command}`,
    )
    assert.equal(r.shell, true, '.cmd must run via the shell')
    assert.equal(r.wantsStdinPrompt, true, '.cmd needs the big prompt via stdin')
  })

// Regression: doctor's small-tier probe hardcoded 'haiku' / 'gpt-5.4-mini' while
// the daemon's triage path already honored CUMORA_TRIAGE_MODEL (daemon.ts, both
// the classify() call and triageModel()'s cost-ledger pricing). On a provider
// that names its models differently, doctor therefore probed a model triage
// never runs on — reporting a red small brain the wake path never hits, or a
// green one when the real triage model is broken. probe() must spawn the SAME
// model as triage.
//
// The fake engine echoes its argv so the assertion is on what was actually
// spawned, not on a mock's bookkeeping.
async function probeArgv(engine: 'claude' | 'codex', tier: 'big' | 'small'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `cumora-probe-${engine}-`))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const cwd = join(root, 'cwd')
  await mkdir(binDir)
  await mkdir(cwd)
  const fake = join(binDir, engine)
  await writeFile(fake, '#!/bin/sh\necho "$@"\n', 'utf8')
  await chmod(fake, 0o755)
  const res = await getAdapter(engine).probe({
    tier,
    cwd,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    signal: new AbortController().signal,
  })
  return res.text
}

test('probe small tier spawns CUMORA_TRIAGE_MODEL, big tier stays on the default', { skip: IS_WIN }, async () => {
  const saved = process.env.CUMORA_TRIAGE_MODEL
  process.env.CUMORA_TRIAGE_MODEL = 'triage-model-under-test'
  try {
    const claudeSmall = await probeArgv('claude', 'small')
    assert.match(claudeSmall, /--model triage-model-under-test/)
    assert.doesNotMatch(claudeSmall, /--model haiku/)

    const codexSmall = await probeArgv('codex', 'small')
    assert.match(codexSmall, /--model triage-model-under-test/)
    assert.doesNotMatch(codexSmall, /gpt-5\.4-mini/)

    // 'big' means "whatever the engine's own default is" — passing --model here
    // would pin the main brain to the triage model and make the big-tier probe
    // a duplicate of the small one.
    assert.doesNotMatch(await probeArgv('claude', 'big'), /--model/)
    assert.doesNotMatch(await probeArgv('codex', 'big'), /--model/)
  } finally {
    if (saved === undefined) delete process.env.CUMORA_TRIAGE_MODEL
    else process.env.CUMORA_TRIAGE_MODEL = saved
  }
})

test('probe small tier falls back to the engine cerebellum when unset', { skip: IS_WIN }, async () => {
  const saved = process.env.CUMORA_TRIAGE_MODEL
  delete process.env.CUMORA_TRIAGE_MODEL
  try {
    assert.match(await probeArgv('claude', 'small'), /--model haiku/)
    assert.match(await probeArgv('codex', 'small'), /--model gpt-5\.4-mini/)
  } finally {
    if (saved !== undefined) process.env.CUMORA_TRIAGE_MODEL = saved
  }
})
