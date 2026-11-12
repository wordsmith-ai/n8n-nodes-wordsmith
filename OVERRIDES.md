# pnpm overrides

`package.json` can't hold comments, so this file records why each entry in `pnpm.overrides`
exists. Update it in the same commit as any override change. The package pins pnpm 10.33.2, which
reads `pnpm.overrides` from `package.json`.

Every pin below is for a devDependency. The published package ships only `dist/`, which has no
runtime dependencies.

| Override | Advisory | Why a plain update doesn't work |
| -------- | -------- | ------------------------------- |
| `lodash@>=4.0.0 <4.18.1` → `>=4.18.1 <5` | GHSA-r5fr-rjxr-66jc, GHSA-f23m-r3pf-42rh | `n8n-workflow` 2.16.0 and `@n8n/expression-runtime` 0.8.0 exact-pin `lodash` 4.17.23 |
| `form-data@>=4.0.0 <4.0.6` → `>=4.0.6 <5` | GHSA-hmw2-7cc7-3qxx | `n8n-workflow` 2.16.0 exact-pins `form-data` 4.0.4 |
| `basic-ftp@<6.2.1` → `>=6.2.1 <7` | GHSA-c475-qrg2-pj4r | `get-uri` 8.0.1 (via `release-it`) declares `^5.3.1` |
| `zod@>=3.0.0 <4` and `zod@>=4.0.0 <4.6.6` → `>=4.6.6 <5` | GHSA-mrhx-c7xc-m3w5 | `n8n-workflow` 2.16.0 exact-pins `zod` 3.25.67 |
| `@n8n/node-cli@0.56.2>@n8n/ai-node-sdk` → `-` (removed) | `stream-json` GHSA-528h-pc64-c93x, GHSA-mjw6-4jj6-33hc, GHSA-hqr4-qq8f-hg3x; `qs` GHSA-6pq8-jhm2-2vcw; `deepmerge` GHSA-gcqx-w48m-w2h4; `uuid` GHSA-w5hq-g745-h8pq (`@langchain` copy) | `@n8n/node-cli` 0.56.x depends on `@n8n/ai-node-sdk`, which pulls in `@n8n/backend-common` (exact `stream-json` 1.9.1), `@n8n/backend-network` (exact `qs` 6.16.0) and LangChain (`deepmerge`, which has no patched release). The CLI never loads the SDK: in `@n8n/node-cli` 0.56.2's `dist/`, only the scaffolding templates that `n8n-node new` copies mention it, and no command imports it. With the SDK removed, `build`, `lint` and `prerelease` run, and `dev` and `release` load. Removing it drops about 2,700 lockfile lines. The selector names CLI 0.56.2, so a CLI bump brings the SDK back until someone re-checks this. Delete the entry when the CLI stops depending on the SDK |
| `@n8n/node-cli>rimraf` → `>=6.1.4 <7` | `glob` GHSA-3g3m-2fjr-6pw4 | `@n8n/node-cli` exact-pins `rimraf` 6.0.1, which needs `glob` ^11. `rimraf` 6.1.4 moves to `glob` ^14.0.3. `n8n-node build` calls `rimraf('dist')`, so the build exercises it |
| `uuid@>=10.0.0 <11.1.1` → `>=11.1.1 <12` | `uuid` GHSA-w5hq-g745-h8pq | `n8n-workflow` 2.16.0, the `latest` tag, exact-pins `uuid` 10.0.0, and 10.x has no backport. `uuid` 11 keeps the CommonJS build and the named exports |
| `minimatch@>=10.0.0 <11.0.1` → `>=11.0.1 <12` | `minimatch` GHSA-g3hv-75wg-m249 | `@oclif/core`, `@ts-morph/common` and `@typescript-eslint/typescript-estree` declare `^10`, and the fix exists only in 11.0.1. The `minimatch` 3.1.5 copy from `eslint` stays: the advisory covers only `>=7.0.0`. `web/` takes the same 10 → 11 lift |
