// Uses the existing backend YAML dependency; no separate tool installation.
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('../backend/node_modules/yaml');

function validateWorkflow(workflow, filename) {
  const errors = [];
  if (!workflow || typeof workflow !== 'object' || !workflow.on || !workflow.jobs) {
    return [`${filename}: workflow requires on and jobs`];
  }
  if (!workflow.permissions || Object.keys(workflow.permissions).length !== 0) {
    errors.push(`${filename}: workflow default permissions must be {}`);
  }
  const events = typeof workflow.on === 'string' ? [workflow.on] : Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on);
  if (events.includes('pull_request_target')) errors.push(`${filename}: privileged PR event needs a separate security design`);
  function checkUse(value, where) {
    if (typeof value !== 'string') return errors.push(`${where}: invalid uses`);
    if (value.startsWith('./') || value.startsWith('docker://')) return;
    if (!/^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[a-f0-9]{40}$/.test(value)) {
      errors.push(`${where}: external uses must have a full immutable commit SHA`);
    }
  }
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const where = `${filename}:${id}`;
    if (job.uses) checkUse(job.uses, where);
    if (!job.permissions || typeof job.permissions !== 'object' || Array.isArray(job.permissions)) {
      errors.push(`${where}: explicit job permissions required`);
    } else {
      const allowed = { contents: 'read' };
      if (filename === 'codeql.yml' && id === 'analyze') allowed['security-events'] = 'write';
      if (filename === 'scorecard.yml' && id === 'analysis') {
        allowed['security-events'] = 'write';
        allowed['id-token'] = 'write';
      }
      for (const [scope, level] of Object.entries(job.permissions)) {
        if (level !== 'none' && allowed[scope] !== level) errors.push(`${where}: unreviewed permission ${scope}:${level}`);
      }
    }
    if (!job.uses && (!job['runs-on'] || !Array.isArray(job.steps))) errors.push(`${where}: runs-on and steps required`);
    const codeqlRefs = new Set((job.steps || [])
      .map(step => typeof step.uses === 'string'
        ? step.uses.match(/^github\/codeql-action\/(?:init|analyze)@(.+)$/)?.[1]
        : undefined)
      .filter(Boolean));
    if (codeqlRefs.size > 1) errors.push(`${where}: CodeQL init and analyze must use the same commit SHA`);
    for (const [index, step] of (job.steps || []).entries()) {
      if (step.uses) checkUse(step.uses, `${where}:step${index}`);
      if (step.uses && step.run) errors.push(`${where}: step cannot both use an action and run shell`);
      if (typeof step.run === 'string' && /\$\{\{\s*(?:secrets\.|github\.event\.)/.test(step.run)) {
        errors.push(`${where}: pass secrets/event input through environment, not shell interpolation`);
      }
    }
  }
  return errors;
}
function validateFile(file) {
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'), { uniqueKeys: true });
  if (doc.errors.length) return doc.errors.map(e => `${file}: ${e.message}`);
  return validateWorkflow(doc.toJS(), path.basename(file));
}
if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const dir = path.join(root, '.github/workflows');
  const files = fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f));
  const errors = files.flatMap(f => validateFile(path.join(dir, f)));
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Validated ${files.length} workflows: immutable external actions, YAML structure, explicit least-privilege permissions and shell input boundaries.`);
}
module.exports = { validateWorkflow, validateFile };
