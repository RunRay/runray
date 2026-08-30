# Changesets

Version bumps and the changelog are driven by changesets.

Every pull request with a user-visible change adds one:

```bash
pnpm changeset
```

`runray` is the only published package — the workspace packages are private,
so changesets versions them but never publishes them.

Releasing (maintainers): `pnpm changeset version` applies the pending
changesets and rewrites the changelog; the Release workflow publishes the
result. Pre-releases go out under the `next` dist-tag, `latest` is promoted
deliberately with `npm dist-tag add`.
