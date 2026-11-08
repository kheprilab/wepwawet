# Contributing

Wepwawet is the open-source core published by [Kheprilab](https://kheprilab.com).
Enterprise and paid features belong outside this repository.

Wepwawet is maintained by one person in their spare time. Issues are reviewed weekly.
Bug reports and feature ideas are welcome as [GitHub issues](https://github.com/kheprilab/wepwawet/issues),
which are the only support channel for now. For security issues, please follow
[the private reporting policy](SECURITY.md).

Please open an issue and wait for the maintainer to accept it before starting a pull request.
Pull requests without a linked, accepted issue may be closed.
By contributing, you agree that your contributions are licensed under the MIT License.

Work on a branch and open a pull request; never push changes directly to main.
Run `pnpm install --frozen-lockfile` to install dependencies and enable the commit hook.
Before opening a PR, run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.

Use Conventional Commits for commit messages and PR titles:
`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`, `style`, or `revert`,
an optional lowercase scope, then `: ` and a subject of 1–100 characters.
For example: `feat(cli): add an option`. Put `!` after the type or scope for a breaking change,
for example `feat!: remove an option`. Never add attribution to any AI tool in commits,
PRs, code, or documentation.

PRs are squash-merged using the PR title as the commit message on main.
Do not edit package.json's version, src/version.ts's version, or CHANGELOG.md by hand:
release-please maintains them and opens release PRs from Conventional Commits.
Merging a release PR creates a tagged GitHub release and runs the release workflow.
Never run `npm publish` or `npm stage publish` locally.

## Maintainers

Require PRs and passing CI checks on main. Enable squash merging with the PR title
as its default commit message. Allow GitHub Actions to create and approve pull requests
so release-please can open release PRs.
PRs created with the default GitHub token do not trigger CI automatically;
a maintainer should close and reopen the release PR to run its checks.

The trusted publisher is `.github/workflows/release.yml`. It uses OIDC with stage-only
permission and stages each release on npm. A maintainer inspects the queued package
and approves it with 2FA using `npm stage approve <stage-id>` before it becomes public.
No npm authentication token is needed in GitHub secrets.

<!-- Remove "release-as" from release-please-config.json right after 0.8.0 is released. -->
