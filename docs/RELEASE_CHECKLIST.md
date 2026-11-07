# Release Checklist

Releases run through `.github/workflows/release.yml`. Do not manually edit versions
or CHANGELOG.md, create release tags, or run publishing commands locally.

1. Merge contributor PRs with squash commits using their Conventional Commit titles.
2. Review the release-please PR: package.json, src/version.ts, the release manifest,
   and CHANGELOG.md must agree. Feature commits bump the minor version while pre-1.0;
   fixes bump the patch version.
3. Confirm CI passes (`pnpm lint`, `pnpm test`, `pnpm build`, `npm pack --dry-run`).
   Close and reopen a release PR as a maintainer to trigger CI when it was created
   with the default GitHub token.
4. Merge the release PR. release-please creates the GitHub release and tag; the publish
   job builds, tests, and stages the npm package using OIDC trusted publishing.
5. Inspect the staged npm package and approve it with 2FA using
   `npm stage approve <stage-id>`. Stage-only publisher permission prevents the workflow
   from publishing directly.
6. Right after releasing 0.8.0, remove `release-as` from release-please-config.json
   in a follow-up PR so normal version calculation resumes.

Maintain branch protection, squash merge settings, and the stage-only npm trusted
publisher for `kheprilab/wepwawet` and workflow `release.yml` as described in
[Contributing](../CONTRIBUTING.md).
