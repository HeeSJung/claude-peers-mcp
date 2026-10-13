# anti-slop provenance

- **Source repository:** https://github.com/dmmulroy/anti-slop, commit `c44ef22`.
- **Copied from:** the `anti-slop` skill bundle in `sooth-os/dot-claude` at commit
  `8db655e9b43b847dc43067ff7c50049668c21119` (`skills/anti-slop/assets`), via its
  `scripts/install.mjs`; files copied unchanged.
- **Installed paths:** `tools/oxlint/anti-slop/index.ts` (generic plugin, registered in
  `.oxlintrc.json`), `tools/oxlint/anti-slop/effect/index.ts` (not registered: no `effect`
  dependency).
- **Dependencies:** `oxlint` 1.87.0, `@oxlint/plugins` 1.87.0 (exact pins, dev).
- **Intentional deviations:** none in the vendored source. `.oxlintrc.json` enables only a
  type-safety and testing subset; its header comment lists every rule on and off.
  `tsconfig.json` excludes this folder from the repo typecheck.
