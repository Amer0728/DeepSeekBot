import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each(['coded-json', 'non-json'])(
  'stops the actual performance runner after a %s cancellation failure',
  (mode) => {
    const home = mkdtempSync(join(tmpdir(), 'perf-tob-cancel-unit-'));
    try {
      const fixture = join(home, 'fixture.json'),
        instance = join(home, 'instance.json');
      const output = join(home, 'output.json'),
        calls = join(home, 'calls.json');
      writeFileSync(fixture, JSON.stringify({ argv: ['approval-templates'] }));
      writeFileSync(instance, JSON.stringify({ home, url: 'http://127.0.0.1:1/?token=unit-only' }));
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          new URL('./fixtures/perf-tob-cli-refusal-preload.mjs', import.meta.url).href,
          fileURLToPath(new URL('../perf-tob-cli.mjs', import.meta.url)),
          '--source-sha',
          'f'.repeat(40),
          '--fixture',
          fixture,
          '--instance',
          instance,
          '--output',
          output,
        ],
        {
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
          timeout: 10000,
          env: { ...process.env, PERF_TEST_CALLS: calls, PERF_TEST_CANCEL_MODE: mode },
        },
      );
      expect(child.status).toBe(1);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      expect(report.failures).toContain('cancel-request-failed');
      expect(report.samples).toHaveLength(1);
      const commands = JSON.parse(readFileSync(calls, 'utf8'));
      expect(commands.filter((argv) => argv[0] === 'tob-cli' && argv[1] === 'start')).toHaveLength(
        1,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
