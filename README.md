# env-drift

Every environment has its own `.env` file, and over time they drift apart. A key gets added to
staging and never makes it to production, or a value is changed in one file and not the others.
In DevOps this is called "configuration drift", and it usually shows up as a failed deploy.

env-drift compares selected `.env` files side by side and lists the keys that are missing somewhere,
the values that differ, and the ones left empty. Values are shown as letters rather than
printed, so it can be run in CI logs or on a shared screen.

```sh
npx env-drift
```

```
Comparing .env, .env.staging, .env.production, .env.example

KEY            .env  staging  production  example
LOG_LEVEL      A     B        B           —        missing in example
REDIS_URL      A     B        —           ·        missing in production
FEATURE_FLAGS  A     A        —           —        missing in production, example
CDN_URL        —     —        A           —        missing in .env, staging, example
PRIVATE_KEY    —     —        A           —        missing in .env, staging, example
NODE_ENV       A     B        B           ·        2 different values
DATABASE_URL   A     B        C           ·        3 different values
GOOGLE_API     ∅     A        A           ·        empty in .env

✖ 5 missing somewhere · 2 differ · 1 empty · 1 identical (--all to show)
Same letter = same value. — missing, ∅ empty, · in a template. Values hidden; --show-values to print them.
```

## How to read it?

- **Letters** stand for values: the same letter means the same value. `STRIPE_KEY A A B` means
  dev and staging share a key and production has its own. Your secrets never appear on screen
  unless you ask for them with `--show-values`.
- `—` the key is missing, `∅` it's set but empty, `·` it's in a template (`.env.example`), where
  only the key matters.
- Rows with problems come first. Keys that are identical everywhere are hidden (`--all` shows them).

## Usage

You need Node 18.3+ (ideally v24). There are a few ways to run it:

- `node env-drift.js` runs it without installing anything.
- `npm install -g env-drift` gives nn `env-drift` command that can be used anywhere.
- Or just grab `env-drift.js` and run `node env-drift.js`. It's a single file with no dependencies,
  so nothing else is needed. If Node complains about `import`, rename it to `env-drift.mjs`.

Run it from the folder that holds the `.env` files (any project root). It only looks in
that folder, not in subfolders. If the files are somewhere else, pass their paths instead, which
works from anywhere:

```sh
env-drift config/.env config/.env.production
```

```sh
node env-drift.js examples\.env examples\.env.production` # If not installed, checks the example env files
env-drift                              # every .env* file in this folder (if installed)
env-drift .env .env.production         # just these two (if installed)
env-drift --keys-only                  # only missing keys; different values are expected
env-drift --example > .env.example     # skeleton with every key and no values
```

| Option | Description
| --- | ---
| `--all` | Also list keys that are identical everywhere
| `--keys-only` | Only report missing keys
| `--show-values` | Print the actual values (careful, secrets)
| `-i, --ignore <keys>` | Comma-separated keys to skip
| `--example` | Print a `.env.example` skeleton and exit
| `--json` | Machine-readable output

With no file arguments it picks up `.env`, `.env.*` and `*.env` and orders them dev → test →
staging → production, with templates (`.example`, `.sample`, `.template`) last.

### On Windows

Everything above works the same in PowerShell or Command Prompt, and both `config/.env` and
`config\.env` are fine as paths.

One thing to watch out for: in the old Windows PowerShell (5.1, the one that comes with Windows),
`>` saves files as UTF-16, which most `.env` loaders can't read. So instead of
`env-drift --example > .env.example`, use:

```powershell
env-drift --example | Out-File -Encoding utf8 .env.example
```

Command Prompt and PowerShell 7 don't have this problem.

### Uninstalling

If you installed it with `npm install -g`, remove it with:
```sh
npm uninstall -g env-drift
```

With `npx` there's nothing to uninstall, and if you just copied the file, delete it. env-drift
never creates any files or settings of its own.

**Exit codes:** `0` every key is in every file, `1` at least one key is missing somewhere,
`2` usage error. In CI:

```sh
npx env-drift .env.example .env.production --keys-only
```

## The `.env.example` skeleton

`--example` merges every file into one list of keys, keeping the order and the comments from
the files, and notes keys that only some environments have:

```sh
# Database
DATABASE_URL=
# only in: .env, staging
REDIS_URL=
```

## Parsing

Standard dotenv syntax: `KEY=value`, optional `export`, `#` comments (an inline `#` needs a space
before it, so `URL=https://x/#a` is kept intact), single quotes are literal, double quotes support
`\n` and `\"`, and quoted values can span several lines. Lines that aren't `KEY=value` are skipped.
`${VAR}` references are compared as written, not expanded.

## License

MIT
