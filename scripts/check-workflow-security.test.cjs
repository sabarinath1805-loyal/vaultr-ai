const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkflow } = require('./check-workflow-security.cjs');
const sha = 'a'.repeat(40);
function fixture(uses = `actions/checkout@${sha}`) {
  return { on: { pull_request: {} }, permissions: {}, jobs: { build: {
    'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ uses }],
  } } };
}
test('accepts full SHAs, local actions and Docker references distinctly', () => {
  for (const ref of [`actions/checkout@${sha}`, `owner/repo/path@${sha}`, './local/action', 'docker://alpine:3'])
    assert.deepEqual(validateWorkflow(fixture(ref), 'ci.yml'), []);
});
test('rejects tags, branches, short SHAs and dynamic external refs', () => {
  for (const ref of ['actions/checkout@v7', 'owner/repo@main', 'owner/repo@abc123', 'owner/repo@${{ inputs.ref }}'])
    assert.ok(validateWorkflow(fixture(ref), 'ci.yml').some(e => e.includes('immutable')));
});
test('checks reusable workflow refs', () => {
  const f = fixture(); f.jobs.build = { uses: 'owner/repo/.github/workflows/build.yml@main', permissions: {} };
  assert.ok(validateWorkflow(f, 'ci.yml').some(e => e.includes('immutable')));
});
test('rejects broad defaults and absent job permissions', () => {
  const f = fixture(); f.permissions = 'write-all'; delete f.jobs.build.permissions;
  assert.equal(validateWorkflow(f, 'ci.yml').length, 2);
});
test('rejects repository writes and limits security upload permissions', () => {
  const f = fixture(); f.jobs.build.permissions.contents = 'write';
  assert.ok(validateWorkflow(f, 'ci.yml').length);
  f.jobs.build.permissions = { contents: 'read', 'security-events': 'write' };
  assert.ok(validateWorkflow(f, 'ci.yml').length);
  f.jobs.analyze = f.jobs.build; delete f.jobs.build;
  assert.deepEqual(validateWorkflow(f, 'codeql.yml'), []);
});
test('rejects privileged PR events and shell secret/event interpolation', () => {
  const f = fixture(); f.on = { pull_request_target: {} };
  f.jobs.build.steps = [{ run: 'echo "${{ secrets.TOKEN }}"' }, { run: '${{ github.event.pull_request.title }}' }];
  assert.equal(validateWorkflow(f, 'ci.yml').length, 3);
});
test('preserves safe environment-bound secret handling', () => {
  const f = fixture(); f.jobs.build.steps = [{ env: { TOKEN: '${{ secrets.TOKEN }}' }, run: 'printf "%s" "$TOKEN"' }];
  assert.deepEqual(validateWorkflow(f, 'ci.yml'), []);
});
test('rejects missing workflow/job structure and mixed run/uses steps', () => {
  assert.ok(validateWorkflow({}, 'ci.yml').length);
  const f = fixture(); delete f.jobs.build['runs-on']; f.jobs.build.steps[0].run = 'echo hi';
  assert.equal(validateWorkflow(f, 'ci.yml').length, 2);
});
test('rejects independently upgraded CodeQL init/analyze actions', () => {
  const f = fixture();
  f.jobs.build.steps = [
    { uses: `github/codeql-action/init@${sha}` },
    { uses: `github/codeql-action/analyze@${'b'.repeat(40)}` },
  ];
  assert.ok(validateWorkflow(f, 'codeql.yml').some(e => e.includes('same commit SHA')));
  f.jobs.build.steps[1].uses = `github/codeql-action/analyze@${sha}`;
  assert.deepEqual(validateWorkflow(f, 'codeql.yml'), []);
});
test('E2E frontend CSP permits the configured local signed-upload origin', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const YAML = require('../backend/node_modules/yaml');
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/e2e.yml'), 'utf8'));
  const steps = workflow.jobs.playwright.steps;
  const backend = steps.find(step => step.run?.includes('> backend/.env')).run;
  const frontend = steps.find(step => step.run?.includes('> frontend/.env.local')).run;
  const storageOrigin = backend.match(/echo "R2_ENDPOINT_URL=([^"]+)"/)?.[1];
  const cspOrigin = frontend.match(/echo "R2_PUBLIC_ENDPOINT_URL=([^"]+)"/)?.[1];
  assert.equal(storageOrigin, 'http://localhost:9000');
  assert.equal(cspOrigin, storageOrigin);
});
