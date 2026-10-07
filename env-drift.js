#!/usr/bin/env node
// env-diff - compare .env files: keys missing between environments, values that differ,
// empty values, and a .env.example skeleton. Single file, no dependencies.
// Copyright (c) 2026 Peter Jedra - MIT License
import { readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

// Help message for the CLI - printed when no arguments are given or --help is passed
const HELP = `env-diff - compare .env files across environments

Usage
  env-diff [files...] [options]

With no files, every .env* file in the current folder is compared.

Examples
  env-diff                                  compare all .env* files here
  env-diff .env .env.production             dev vs prod
  env-diff --example > .env.example         write a skeleton with every key

Options
      --all            Also list keys that are identical everywhere
      --keys-only      Only report missing keys, ignore value differences
      --show-values    Print values instead of A/B/C labels (careful: secrets)
  -i, --ignore <keys>  Comma-separated keys to skip (e.g. -i HOSTNAME,PORT)
      --example        Print a .env.example skeleton (all keys, no values) and exit
      --json           Machine-readable output
  -h, --help           Show this help

Exit code 1 when a key is missing from any file, so it can run in CI.
`;

// ---------- parsing ----------

// KEY=VALUE with optional "export " prefix; keys may contain dots and dashes
const KEY_VALUE_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
// List of quotation marks to look for - value starting with one of these will be a quoted value
const QUOTES = ['"', "'", '`'];
// Escapes understood inside double quotes. Any other escaped character is kept as-is, so \" gives " and \\ gives \
const ESCAPES = { n: '\n', t: '\t', r: '\r' };
// Column order for discovered files: dev-like environments first, production last
const ENV_ORDER = ['.env', 'local', 'development', 'dev', 'test', 'staging', 'stage', 'production', 'prod'];

// The command-line options (see HELP at the top)
const CLI_OPTIONS = {
    all: { type: 'boolean' },
    'keys-only': { type: 'boolean' },
    'show-values': { type: 'boolean' },
    ignore: { type: 'string', short: 'i' },
    example: { type: 'boolean' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
};

// Returns a Map(key -> { value, comments }) in file order.
// Handles export, # comments, and single/double/backtick quoted values (which can span several lines).
export function parseEnv(text) {
    const entries = new Map();

    // Strip a UTF-8 BOM and normalise Windows/old Mac line endings
    const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');

    // The # lines directly above the next key
    let comments = [];

    // Parse each line
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Blank line or comment line - neither is a key, so move on.
        // A blank line clears the comments; a comment line is added to them for the next key.
        if (trimmed === '' || trimmed.startsWith('#')) {
            // If the line was a comment, add it to the comments for the next key - in ENV files comments are above the key
            comments = trimmed === '' ? [] : [...comments, trimmed];
            continue;
        }

        // Anything that isn't KEY=VALUE is skipped
        const match = KEY_VALUE_LINE.exec(line);
        if (!match) {
            comments = [];
            continue;
        }

        const key = match[1];      // the name before the =
        const rawValue = match[2]; // everything after the =, as written (quotes, inline comment and all)
        let value;                 // the cleaned-up value that gets stored

        // A value starting with a quote is a quoted value. It only continues onto the next lines
        // if the closing quote isn't on this line, e.g. KEY="first line / second line"
        if (QUOTES.includes(rawValue[0])) {
            const quoted = readQuotedValue(lines, i, rawValue);
            value = quoted.value;
            i = quoted.lastLine; // skip the extra lines a multi-line value used
        } else {
            // Unquoted: drop an inline comment (needs a space before the #) and surrounding spaces
            value = rawValue.replace(/\s+#.*$/, '').trim();
        }

        entries.set(key, { value, comments });
        comments = [];
    }

    return entries;
}

// Reads a quoted value starting on lines[firstLine], continuing onto the following lines until the closing quote.
// Only double quotes process escapes; single quotes and backticks are taken literally.
// Returns the value and the index of the line the value ended on.
function readQuotedValue(lines, firstLine, rawValue) {
    const quote = rawValue[0]; // which quote opened the value: " ' or `
    let text = rawValue.slice(1); // the text to read, starting after the opening quote
    let lastLine = firstLine; // the line we've read up to
    let value = ''; // the value built up so far
    let pos = 0; // position of the next character to read in text

    // Read one character at a time until the closing quote
    while (true) {
        // Used up all the text without finding the closing quote - add the next line and keep reading
        if (pos >= text.length) {
            const atEndOfFile = lastLine + 1 >= lines.length;
            if (atEndOfFile) break; // the quote is never closed: the value is the rest of the file
            lastLine++;
            text += '\n' + lines[lastLine];
            continue;
        }

        const ch = text[pos];

        // Found the closing quote - the value is complete
        if (ch === quote) break;

        // Inside double quotes a backslash escapes the next character, e.g. \n becomes a new line.
        // A backslash at the very end of a line is kept as a normal character.
        const isEscape = quote === '"' && ch === '\\' && pos + 1 < text.length;
        if (isEscape) {
            const escaped = text[pos + 1];
            value += ESCAPES[escaped] ?? escaped; // \n \t \r are translated, anything else (\" or \\) is kept as-is
            pos += 2;
        } else {
            value += ch;
            pos += 1;
        }
    }

    return { value, lastLine };
}

// Builds one row per key, with one cell per file. A cell's state is:
//   missing - the file doesn't have the key
//   present - the file is a template, so only the key matters, not its value
//   empty   - the key is there with no value
//   set     - the key has a value, labelled with a letter: equal values share a letter (A, B, C... in order of appearance)
export function compare(files, { ignore = [] } = {}) {
    // Every key from every file, in the order they first appear
    const keys = [];
    for (const file of files) {
        for (const key of file.entries.keys()) {
            if (keys.includes(key)) continue;
            if (ignore.includes(key)) continue;
            keys.push(key);
        }
    }
    const rows = [];
    // One row per key
    for (const key of keys) {
        const letters = new Map(); // value -> its letter
        const cells = [];
        const missingIn = [];      // labels of the files without this key
        const emptyIn = [];        // labels of the files where this key is empty

        for (const file of files) {
            const entry = file.entries.get(key);

            if (!entry) {
                cells.push({ state: 'missing' });
                missingIn.push(file.label);
            } else if (file.template) {
                cells.push({ state: 'present', value: entry.value });
            } else if (entry.value === '') {
                cells.push({ state: 'empty', value: '' });
                emptyIn.push(file.label);
            } else {
                // A value we haven't seen yet for this key gets the next letter
                if (!letters.has(entry.value)) {
                    const nextLetter = String.fromCharCode('A'.charCodeAt(0) + letters.size);
                    letters.set(entry.value, nextLetter);
                }
                cells.push({ state: 'set', value: entry.value, letter: letters.get(entry.value) });
            }
        }

        // distinctValues = how many different values the key has (1 means the same everywhere)
        rows.push({ key, cells, missingIn, emptyIn, distinctValues: letters.size });
    }

    return rows;
}

// Builds a .env.example: every key in the order they first appear, with no values.
// The comments written above each key are copied over, and keys that only some environments have are flagged.
export function example(files, { ignore = [] } = {}) {
    const realFiles = files.filter(file => !file.template); // the actual environments, not templates
    const lines = [];
    const done = new Set(); // keys already written

    for (const file of files) {
        for (const [key, entry] of file.entries) {
            if (done.has(key)) continue;
            if (ignore.includes(key)) continue;
            done.add(key);

            // The key's comments, with a blank line before them to keep the groups apart
            if (entry.comments.length) {
                lines.push('');
                lines.push(...entry.comments);
            }

            // Say which environments have the key, if it isn't all of them
            const definedIn = realFiles.filter(f => f.entries.has(key));
            if (definedIn.length < realFiles.length) {
                const names = definedIn.map(f => f.label).join(', ');
                lines.push(`# only in: ${names}`);
            }

            lines.push(`${key}=`);
        }
    }

    // One text, without a blank first line, ending in a newline
    let text = lines.join('\n');
    if (text.startsWith('\n')) text = text.slice(1);
    return text + '\n';
}

// Find .env, .env.* and *.env files in a folder (skipping editor/backup leftovers and macOS "._" metadata files),
// sorted by ENV_ORDER. Unknown environments go after the known ones, templates go last.
function discover(dir = '.') {
    const files = readdirSync(dir).filter(f => /^\.env(\..+)?$|\.env$/.test(f) && !/\.(swp|bak|orig)$/.test(f) && !f.startsWith('._'));

    const rank = (f) => {
        if (isTemplate(f)) return 100;
        const i = ENV_ORDER.indexOf(label(f));
        return i === -1 ? 50 : i;
    };
    return files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}


// Runs the program and returns the exit code: 0 = ok, 1 = a key is missing somewhere, 2 = usage / file error
function main(argv) {
    // 1. Read the command-line options
    let args;
    try {
        args = parseArgs({ args: argv, allowPositionals: true, options: CLI_OPTIONS });
    } catch (err) {
        console.error(`env-diff: ${err.message}`); // e.g. an unknown option
        return 2;
    }
    // Retrieve the actual options
    const opts = args.values;
    if (opts.help) { // If --help is passed, print help and exit
        process.stdout.write(HELP);
        return 0;
    }

    // --ignore "A, B" -> ['A', 'B']
    let ignore = [];
    if (opts.ignore) ignore = opts.ignore.split(',').map(key => key.trim()); // trim whitespace

    // 2. Decide which files to read: the ones named on the command line, otherwise every .env* file in this folder
    let paths = args.positionals.length > 0 ? args.positionals : discover(); // If files passed, use them, otherwise discover
    if (paths.length === 0) { // No files found?
        console.error('env-diff: no .env files found here - pass the files to compare');
        return 2;
    }
    // --example works with a single file, comparing needs at least two
    if (paths.length < 2 && !opts.example) {
        console.error(`env-diff: need at least two files to compare (found ${paths.join(', ')})`);
        return 2;
    }

    // 3. Read and parse the files
    const files = loadFiles(paths);
    if (!files) return 2;

    // 4. --example: print the skeleton and stop
    if (opts.example) {
        process.stdout.write(example(files, { ignore }));
        return 0;
    }

    // 5. Compare the files and sort the keys into missing / different / empty / identical
    const rows = compare(files, { ignore });
    const groups = groupRows(rows, opts);

    // 6. Print the result
    if (opts.json) printJson(files, groups, opts);
    else printReport(files, groups, opts);

    // A missing key fails the run, so it can be used in CI
    if (groups.missing.length > 0) return 1;
    return 0;
}

// Template files (.env.example etc.) only need the key to exist - their values are never compared
const isTemplate = (file) => /\.(example|sample|template|dist)$/i.test(file);

// The short name shown as a column heading:
// ".env.production" -> "production", "prod.env" -> "prod", ".env" -> ".env"
export function label(file) {
    const fileName = basename(file); // Use the node path module to get the file name
    if (fileName === '.env') return '.env'; // ".env" is a special case
    // Strip a leading ".env." or a trailing ".env"
    const envName = fileName.replace(/^\.env\./, '').replace(/\.env$/, '');

    // Nothing left after stripping - use the whole file name
    return envName || fileName;
}

// Reads and parses each file. If a file can't be read, prints why and returns null.
function loadFiles(paths) {
    const files = [];

    // Go through the paths provided through the command line or discovered
    for (const path of paths) {
        let text;
        try { // Try to read the file
            text = readFileSync(path, 'utf8');
        } catch (err) { // File can't be read
            const reason = err.code === 'ENOENT' ? 'no such file' : err.message;
            console.error(`env-diff: can't read ${path}: ${reason}`);
            return null;
        }

        // Parse the file: label, template, entries...
        files.push({
            path, // full path
            label: label(path), // column heading, e.g. "production"
            template: isTemplate(path), // .env.example etc.
            entries: parseEnv(text), // key -> { value, comments }
        });
    }

    // Two files with the same label (e.g. a/.env and b/.env) can't be told apart - use their full paths instead
    const labels = new Set(files.map(file => file.label));
    if (labels.size < files.length) {
        for (const file of files) file.label = file.path;
    }

    return files;
}

// Sorts the compared rows into groups. A missing key is the most serious problem, so a key that's missing
// somewhere isn't also counted as different or empty. A key can be both different and empty.
// Rows with no problem at all are identical.
function groupRows(rows, opts) {
    const missing = [];
    const differ = [];
    const empty = [];
    const identical = [];

    for (const row of rows) { // Each row is a key
        const isMissing = row.missingIn.length > 0;
        const isEmpty = !isMissing && row.emptyIn.length > 0;
        // --keys-only ignores values, so nothing counts as different
        const isDifferent = !isMissing && row.distinctValues > 1 && !opts['keys-only'];

        // Add the row to the appropriate group
        if (isMissing) missing.push(row); // missing keys are the most serious
        if (isDifferent) differ.push(row); // differing keys
        if (isEmpty) empty.push(row); // empty keys
        if (!isMissing && !isDifferent && !isEmpty) identical.push(row); // identical keys
    }

    return { missing, differ, empty, identical };
}

// --json output
function printJson(files, groups, opts) {
    // One key's details. For each file: null if the key is missing there,
    // otherwise the value (with --show-values) or its letter / "empty" / "present"
    const describe = (row) => {
        const values = {};
        for (let i = 0; i < files.length; i++) {
            const cell = row.cells[i];
            const fileLabel = files[i].label;

            if (cell.state === 'missing') values[fileLabel] = null;
            else if (opts['show-values']) values[fileLabel] = cell.value;
            else values[fileLabel] = cell.letter || cell.state;
        }
        return { key: row.key, missingIn: row.missingIn, emptyIn: row.emptyIn, values };
    };

    // Report: files, keys with missing values, keys with different values, keys with empty values
    const report = {
        files: files.map(file => file.path),
        missing: groups.missing.map(describe),
        different: groups.differ.map(describe),
        empty: groups.empty.map(describe),
        identical: groups.identical.map(row => row.key),
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

// ANSI colours - only when writing to a terminal, and never when NO_COLOR is set
function makeColours() {
    const enabled = process.stdout.isTTY && !process.env.NO_COLOR;
    // Colour codes: https://en.wikipedia.org/wiki/ANSI_escape_code
    const style = (code) => (text) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
    return { red: style(31), yellow: style(33), green: style(32), dim: style(2), bold: style(1) };
}

// Normal output: the table of problem keys, then a summary line
function printReport(files, groups, opts) {
    const colors = makeColours();
    const { missing, differ, empty, identical } = groups;

    // Rows for the table: problems first, then identical keys only with --all
    const shown = [...missing, ...differ];
    for (const row of empty) { // empty keys are less serious
        if (!differ.includes(row)) shown.push(row); // skip keys already listed as different
    }
    // if --all is passed, also shows identical keys
    if (opts.all) shown.push(...identical);

    console.log(colors.dim(`Comparing ${files.map(file => file.path).join(', ')}`));
    if (shown.length > 0) printTable(files, shown, opts, colors);
    printSummary(groups, opts, colors);

    // Explain the symbols - not needed when real values are shown, or with --keys-only
    if (shown.length > 0 && !opts['show-values'] && !opts['keys-only']) {
        console.log(colors.dim('Same letter = same value. — missing, ∅ empty, · in a template. Values hidden; --show-values to print them.'));
    }
}

// The table: one row per key, one column per file, and a note at the end of each row
function printTable(files, rows, opts, colors) {
    const { red, yellow, dim, bold } = colors;

    // What goes in a cell: a symbol for missing / empty / template, otherwise the letter (or the value with --show-values)
    const cellText = (cell) => {
        if (cell.state === 'missing') return '—';
        if (cell.state === 'empty') return '∅';
        if (cell.state === 'present') return '·';
        if (!opts['show-values']) return cell.letter;
        // Shorten long values so the table stays readable
        if (cell.value.length > 24) return cell.value.slice(0, 23) + '…';
        return cell.value;
    };

    // Cell colour: red = missing, yellow = empty, dim = template
    const paint = (cell, text) => {
        if (cell.state === 'missing') return red(text);
        if (cell.state === 'empty') return yellow(text);
        if (cell.state === 'present') return dim(text);
        return text;
    };

    // Each column is as wide as its longest entry. Padding happens before colouring,
    // because the colour codes are invisible but would still count as characters.
    const keyWidth = Math.max('KEY'.length, ...rows.map(row => row.key.length));
    const colWidths = files.map((file, i) => {
        const cellWidths = rows.map(row => cellText(row.cells[i]).length);
        return Math.max(file.label.length, ...cellWidths);
    });

    // Header row
    const headings = files.map((file, i) => bold(file.label.padEnd(colWidths[i])));
    console.log('\n' + bold('KEY'.padEnd(keyWidth)) + '  ' + headings.join('  '));

    for (const row of rows) {
        // Note at the end of the row - the most serious problem wins
        let note = '';
        if (row.missingIn.length) note = red(`missing in ${row.missingIn.join(', ')}`);
        else if (row.emptyIn.length) note = yellow(`empty in ${row.emptyIn.join(', ')}`);
        else if (row.distinctValues > 1) note = dim(`${row.distinctValues} different values`);

        const cols = row.cells.map((cell, i) => paint(cell, cellText(cell).padEnd(colWidths[i])));
        console.log(`${row.key.padEnd(keyWidth)}  ${cols.join('  ')}  ${note}`);
    }
}

// Summary line, e.g. "✖ 10 missing somewhere · 2 differ · 1 empty · 3 identical"
function printSummary(groups, opts, colors) {
    const { red, yellow, green, dim } = colors;
    const { missing, differ, empty, identical } = groups;

    const parts = [];
    if (missing.length) parts.push(red(`${missing.length} missing somewhere`));
    else parts.push(green('no missing keys'));
    if (!opts['keys-only']) parts.push(`${differ.length} differ`);
    if (empty.length) parts.push(yellow(`${empty.length} empty`));

    let identicalText = `${identical.length} ${opts['keys-only'] ? 'present everywhere' : 'identical'}`;
    if (identical.length && !opts.all) identicalText += dim(' (--all to show)');
    parts.push(identicalText);

    const icon = missing.length ? red('✖ ') : green('✔ ');
    console.log('\n' + icon + parts.join(' · '));
}

// Run as a CLI (not when imported by the tests). realpath resolves the symlink npm creates for the bin.
if (process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:fs')).realpathSync(process.argv[1])) {
    process.exitCode = main(process.argv.slice(2));
}
