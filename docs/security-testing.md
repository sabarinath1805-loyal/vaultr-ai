# Pinned security regression suite

Run the fixed, workstream-grouped security regression set from the repository
root with:

```bash
npm run test:security
```

Membership is explicit in `scripts/security-test-membership.json`; the runner
uses serial Vitest execution for backend and frontend groups and the native
Node test runner for script and Word server tests. The inventory test requires
every test placed in a `security`, `security-tests`, or `__security_tests__`
directory, and every `*.security.test.*` file, to be listed. Add new security
tests to the appropriate workstream group and keep them under that convention
so omissions fail the suite. Stack-dependent files remain listed and report
their normal skip status when the local Supabase stack is not configured; run
the stack suite separately with `npm run test:stack --prefix backend`.
