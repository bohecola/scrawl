# Contributing translations

Scrawl's UI copy lives in `src/locales/*.json` in [i18next JSON v4](https://www.i18next.com/misc/json-format) format (flat keys, the dots in key names are just naming convention, not nesting).

## Where to change copy

**`src/locales/en.json` is the source language and the single source of truth.**
If a string needs to change, change it there first, then mirror the change in
`zh-CN.json` (the maintainer keeps it complete) or leave other languages to
catch up — missing keys fall back to English at runtime.

A few key shapes you will meet in the files:

- `{{name}}` — interpolation, same as i18next defaults.
- `key_one` / `key_other` / … — plural forms. The variable is always `count`
  (i18next convention); which suffixes a language needs is decided by CLDR,
  see below.
- `key` / `key_file` / `key_directory` — context forms: the code passes
  `context: 'file' | 'directory'` and i18next picks the suffixed key.
  The bare `key` is the fallback and must exist in `en.json`.
- `{{tried, list}}`, `{{chain, chain}}`, `{{issues, compileIssues}}` — values
  formatted by formatters registered in `src/i18n/setup.ts`. Keep the formatter
  name after the comma, translate only the surrounding text.

## Adding a language

1. Copy `src/locales/en.json` to `src/locales/<tag>.json`, where `<tag>` is the
   BCP 47 tag used for `<html lang>` (e.g. `es.json` for Spanish).
2. Translate the values. Incomplete translations are welcome and can be
   submitted — any key you skip displays in English.
3. Register the language:
   - add it to the `Lang` union and `LANG_TAGS` in `src/i18n/langs.ts`
     (`LANG_TAGS` maps the internal name to the BCP 47 tag / file name),
   - add an entry to `LANGS` in `src/i18n/context.ts` — the label is the
     language's native name (never translated), placed following the existing
     ordering rule.
4. Plural suffixes: give every category of your language, as reported by
   `new Intl.PluralRules('<tag>').resolvedOptions().pluralCategories` — for
   example English needs `_one` and `_other`, French `_one`, `_many`, `_other`,
   Arabic all six. You do not have to memorize this: run the check (below) and
   it will list exactly which keys are missing. Until a category is filled in,
   the general (`_other`-style) wording is a fine placeholder.
5. Run `pnpm i18n:check` (also part of `pnpm lint`). It fails on extra keys,
   wrong interpolation variables, missing plural categories, empty strings and
   — for `zh-CN.json` only — missing keys.

## Translation platforms

When the project hooks up Crowdin / Weblate later, choose the file format
"i18next JSON v4" with `src/locales/en.json` as the source file. That step is
not part of the current setup.
