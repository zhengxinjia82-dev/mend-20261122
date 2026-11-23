# mend-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/zhengxinjia82-dev/mend-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/zhengxinjia82-dev/mend-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It reads a patch in one of four formats — unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, or JSON text-editor tool calls — finds the lines each edit names at the first of three matching tiers (exact, trailing whitespace, both ends), and writes every change or none. A failed edit is reported and changes nothing; the edits after it still run.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a patch file, or `-` (or absent) to read the patch from standard input. Options: `--format=unified|search-replace|v4a|json|auto` (default `auto`), `--check` to dry-run without writing, `--strict` to match lines exactly. Node 22 and its standard library only; no install step.

---

Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
