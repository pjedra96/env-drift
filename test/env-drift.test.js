import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv, compare, example, label } from '../env-drift.js';

// CLI and example files
const CLI = fileURLToPath(new URL('../env-drift.js', import.meta.url)); // CLI execution
const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url)); // example files
const file = (name, text) => ({ path: name, label: label(name), template: /example$/.test(name), entries: parseEnv(text) });
const values = (text) => Object.fromEntries([...parseEnv(text)].map(([k, v]) => [k, v.value]));

test('parses dotenv syntax', () => {
    assert.deepEqual(values([
        'export A=1',
        'B = spaced ',
        'C=x # comment',
        'D=https://x.io/#frag',
        'E="line\\nbreak \\"q\\""',
        "F='literal \\n $HOME'",
        'G="multi',
        'line"',
        'H=',
        'not a valid line',
        '#I=commented out',
    ].join('\r\n')), { A: '1', B: 'spaced', C: 'x', D: 'https://x.io/#frag', E: 'line\nbreak "q"', F: 'literal \\n $HOME', G: 'multi\nline', H: '' });
});

test('keeps the comments written above each key', () => {
    const e = parseEnv('# Database\n# primary\nDB=x\n\n# unrelated\n\nPORT=1');
    assert.deepEqual(e.get('DB').comments, ['# Database', '# primary']);
    assert.deepEqual(e.get('PORT').comments, []);
});

test('labels files by environment name', () => {
    assert.equal(label('.env'), '.env');
    assert.equal(label('config/.env.production'), 'production');
    assert.equal(label('prod.env'), 'prod');
});

test('finds missing keys, empty values and differing values without exposing them', () => {
    const rows = compare([
        file('.env', 'A=1\nB=x\nC=\nD=same'),
        file('.env.production', 'A=2\nC=set\nD=same\nE=new'),
    ]);
    const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
    assert.deepEqual(byKey.B.missingIn, ['production']);
    assert.deepEqual(byKey.E.missingIn, ['.env']);
    assert.deepEqual(byKey.C.emptyIn, ['.env']);
    assert.equal(byKey.A.distinctValues, 2);
    assert.deepEqual(byKey.A.cells.map(c => c.letter), ['A', 'B']);
    assert.equal(byKey.D.distinctValues, 1);
});

test('template files only count for keys, not values', () => {
    const rows = compare([file('.env', 'A=1'), file('.env.example', 'A=\nB=')]);
    assert.equal(rows[0].cells[1].state, 'present');
    assert.deepEqual(rows[0].emptyIn, []);
    assert.deepEqual(rows[1].missingIn, ['.env']);
});

test('builds a .env.example skeleton with comments and partial-key notes', () => {
    const out = example([file('.env', '# DB\nDB=x\nDEV_ONLY=1'), file('.env.production', 'DB=y\nCDN=z')]);
    assert.equal(out, '# DB\nDB=\n# only in: .env\nDEV_ONLY=\n# only in: production\nCDN=\n');
});

test('CLI exit codes, hidden values and JSON', () => {
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: EXAMPLES, env: { ...process.env, NO_COLOR: '1' } });

    const all = run();
    assert.equal(all.status, 1);
    const text = all.stdout.toString();
    assert.match(text, /REDIS_URL\s+A\s+B\s+—\s+·\s+missing in production/);
    assert.doesNotMatch(text, /sk902o9wnaq20l!km!lxu76vvlk082zcn|prod-db/, 'values must stay hidden by default');

    // --show-values reveals the real value (checked in the --json output, because the table shortens long values)
    const shown = run('--show-values', '--json', '.env', '.env.production').stdout.toString();
    assert.match(shown, /sk902o9wnaq20l!km!lxu76vvlk082zcn/);

    const json = JSON.parse(run('--json', '.env', '.env.staging').stdout.toString());
    assert.deepEqual(json.missing, []);
    assert.equal(run('.env', '.env.staging').status, 0);
    assert.ok(json.different.some(d => d.key === 'DATABASE_URL'));

    assert.equal(run('-i', 'REDIS_URL,FEATURE_FLAGS,CDN_URL,PRIVATE_KEY,LOG_LEVEL,GOOGLE_API', '.env', '.env.production', '--keys-only').status, 0);
    assert.equal(run('only-one').status, 2);
});
