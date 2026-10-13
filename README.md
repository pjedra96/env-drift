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

- **Letters** stand for values: the same letter means the same value. `NODE_ENV A B B` means
  .env has its own value and staging and production share one. Your secrets never appear on screen
  unless you ask for them with `--show-values`.
- `—` the key is missing, `∅` it's set but empty, `·` it's in a template (`.env.example`), where
  only the key matters.
- Rows with problems come first. Keys that are identical everywhere are hidden (`--all` shows them).

## Usage

You need Node 18.3 or newer. There are three ways to run it:

- `npx env-drift`: nothing to install
- `npm install -g env-drift`: gives you an `env-drift` command you can use anywhere
- copy `env-drift.js` and run `node env-drift.js`: it's a single file with no dependencies.
  If Node complains about `import`, rename it to `env-drift.mjs`.

Run it from the folder that holds the `.env` files (any project root). It only looks in that
folder, not in subfolders. If the files are somewhere else, pass their paths instead:

```sh
env-drift                                      # every .env* file in this folder
env-drift .env .env.production                 # just these two
env-drift config/.env config/.env.production   # files in another folder
env-drift examples/.env examples/.env.production   # try it on the sample files
env-drift --keys-only                          # only missing keys; different values are expected
env-drift --example > .env.example             # skeleton with every key and no values
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

**Exit codes:** `0` every key is in every file, `1` at least one key is missing somewhere,
`2` usage error. In CI:

```sh
npx env-drift .env.example .env.production --keys-only
```

### On Windows

Paths work with `/` or `\`. In Windows PowerShell 5.1 (the one built into Windows), `>` saves
files as UTF-16, which most `.env` loaders can't read, so use this instead:

```powershell
env-drift --example | Out-File -Encoding utf8 .env.example
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

## Uninstalling

If you installed it globally, run `npm uninstall -g env-drift`. Otherwise there's nothing to
remove: env-drift never creates any files or settings of its own.

## License

MIT
