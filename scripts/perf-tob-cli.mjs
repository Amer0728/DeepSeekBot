import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
const source = argument('--source-sha');
if (!/^[a-f0-9]{40}$/.test(source ?? '')) throw new Error('Pass frozen --source-sha');
const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureBytes = readFileSync(argument('--fixture'));
const fixture = JSON.parse(fixtureBytes);
if (
  !Array.isArray(fixture.argv) ||
  fixture.argv[0] !== 'approval-templates' ||
  !fixture.argv.every((item) => typeof item === 'string')
)
  throw new Error('Use a readonly approval-templates argv fixture');
const instance = JSON.parse(readFileSync(argument('--instance')));
const url = new URL(instance.url);
const token = url.searchParams.get('token');
if (!token) throw new Error('Private authenticated instance required');
const budget = JSON.parse(readFileSync(new URL('./perf-budgets/tob-cli.json', import.meta.url)));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const run = (argv, stdin = '') =>
  new Promise((resolve, reject) => {
    const started = performance.now();
    const child = execFile(
      process.execPath,
      [
        fileURLToPath(new URL('../packages/deepseekbot/dist/deepseekbot.mjs', import.meta.url)),
        ...argv,
      ],
      {
        cwd: root,
        env: { ...process.env, DEEPSEEKBOT_HOST: url.origin, DEEPSEEKBOT_HOST_TOKEN: token },
        shell: false,
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        try {
          resolve({
            code: error?.code ?? 0,
            ms: performance.now() - started,
            value: JSON.parse(stdout),
          });
        } catch {
          reject(new Error('CLI measurement produced no JSON result'));
        }
      },
    );
    child.stdin.end(stdin);
  });
const nativeAudit = async () => {
  const home = await run(['tob-home']);
  const slug = home.value.botSlug;
  if (home.code !== 0 || typeof slug !== 'string') throw new Error('Owned Tob unavailable');
  const trace = await run(['bot-trace', slug, '--turns', '1']);
  const id = trace.value.sessionId;
  if (typeof id !== 'string') return { sessionId: null, counts: {} };
  const directory = join(instance.home, 'sessions');
  const matches = readdirSync(directory)
    .map((name) => join(directory, name, id, 'session.v4.jsonl.zstd'))
    .filter(existsSync);
  if (matches.length !== 1) throw new Error('Native audit identity unavailable');
  const bytes = readFileSync(matches[0]);
  if (bytes.length > 16 * 1024 * 1024) throw new Error('Native audit exceeds capture bound');
  const counts = {};
  for (const line of zstdDecompressSync(bytes).toString('utf8').split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return { sessionId: id, counts, sha256: hash(bytes) };
};
const auditBefore = await nativeAudit();
const samples = [],
  failures = [];
for (let round = 0; round < budget.rounds; round++) {
  let id;
  try {
    const direct = await run(fixture.argv);
    const began = performance.now();
    const start = await run(
      ['tob-cli', 'start', '--args-stdin'],
      JSON.stringify({ argv: fixture.argv, stdin: '' }),
    );
    id = start.value.id;
    if (start.code !== 0 || !id) throw new Error('Typed CLI start refused');
    let status;
    const polls = [];
    while (performance.now() - began < budget.maxCaptureMs) {
      status = await run(['tob-cli', 'status', id]);
      polls.push(status.ms);
      if (status.code !== 0 || status.value.state !== 'running') break;
    }
    const journeyMs = performance.now() - began;
    const result = status?.value.result;
    const value = result?.exitCode === 0 ? JSON.parse(result.stdout) : undefined;
    const correct =
      direct.code === 0 &&
      status?.value.state === 'completed' &&
      hash(JSON.stringify(value)) === hash(JSON.stringify(direct.value));
    const row = {
      round,
      correct,
      directMs: direct.ms,
      startMs: start.ms,
      journeyMs,
      addedMs: journeyMs - direct.ms,
      statusMs: polls,
      polls: polls.length,
      resultCode: result?.exitCode,
    };
    samples.push(row);
    if (!correct) failures.push('command-result-mismatch');
    if (row.directMs > budget.maxDirectCliMs) failures.push('direct-latency');
    if (row.journeyMs > budget.maxJourneyMs || row.addedMs > budget.maxAddedNativeJourneyMs)
      failures.push('native-journey-latency');
    if (polls.some((ms) => ms > budget.maxStatusCliMs)) failures.push('status-latency');
  } catch {
    samples.push({ round, correct: false, error: 'journey-failed' });
    failures.push('journey-failed');
  } finally {
    if (id) await run(['tob-cli', 'cancel', id]);
  }
}
const auditAfter = await nativeAudit();
if (auditBefore.sessionId && auditBefore.sessionId !== auditAfter.sessionId)
  failures.push('native-session-changed');
if (
  (auditAfter.counts['turn/start'] ?? 0) - (auditBefore.counts['turn/start'] ?? 0) !==
  samples.filter((sample) => sample.correct).length
)
  failures.push('native-turn-count');
for (const kind of [
  'step/start',
  'request/header',
  'request/context',
  'assistant/message',
  'assistant/attempt',
]) {
  if ((auditAfter.counts[kind] ?? 0) !== (auditBefore.counts[kind] ?? 0))
    failures.push('unexpected-model-step:' + kind);
}
const result = {
  source,
  node: process.version,
  fixtureSha256: hash(fixtureBytes),
  capturedAt: new Date().toISOString(),
  artifacts: [
    'packages/core/dist/index.mjs',
    'packages/core/cli/index.mjs',
    'packages/deepseekbot/dist/deepseekbot.mjs',
  ].map((file) => ({ file, sha256: hash(readFileSync(new URL('../' + file, import.meta.url))) })),
  samples,
  nativeAudit: { before: auditBefore, after: auditAfter },
  budget,
  failures,
};
writeFileSync(argument('--output'), JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify({ samples: samples.length, failures }));
if (failures.length) process.exitCode = 1;
