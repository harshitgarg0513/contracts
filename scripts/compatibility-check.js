#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');
const path = require('path');

const CONTRACT_ROOT = 'contracts/proto';
const DEFAULT_BASES = ['origin/main', 'main', 'HEAD~1'];
const REPO_ROOT = path.resolve(__dirname, '../..');

function run(command) {
  try {
    return execSync(command, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return '';
  }
}

function resolveBaseRef() {
  const explicit = process.env.CONTRACT_BASE_REF;
  if (explicit) {
    const ok = run(`git rev-parse --verify ${explicit}`);
    if (ok) {
      return explicit;
    }
  }

  for (const candidate of DEFAULT_BASES) {
    const ok = run(`git rev-parse --verify ${candidate}`);
    if (ok) {
      return candidate;
    }
  }

  return '';
}

function ensureBufInstalled() {
  const check = spawnSync('buf', ['--version'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  return check.status === 0;
}

function runBufLint(target) {
  return spawnSync('buf', ['lint', target, '--error-format=json'], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runBufBreaking(baseRef) {
  const against = `.git#ref=${baseRef},subdir=${CONTRACT_ROOT}`;
  return spawnSync('buf', ['breaking', CONTRACT_ROOT, '--against', against], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

function parseLintIssues(output) {
  if (!output) {
    return [];
  }

  const text = Buffer.isBuffer(output) ? output.toString('utf8') : String(output);

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

function issueKey(issue) {
  const path = issue.path || '';
  const startLine = issue.start_line || 0;
  const startColumn = issue.start_column || 0;
  const type = issue.type || '';
  const message = issue.message || '';
  return `${path}|${startLine}|${startColumn}|${type}|${message}`;
}

function printIssues(header, issues) {
  if (issues.length === 0) {
    return;
  }

  console.error(header);
  for (const issue of issues) {
    const position = `${issue.start_line || 0}:${issue.start_column || 0}`;
    console.error(` - ${issue.path}:${position} [${issue.type}] ${issue.message}`);
  }
}

function main() {
  if (!ensureBufInstalled()) {
    console.error('buf CLI is required for contract compatibility checks.');
    console.error('Install it from https://buf.build/docs/installation/ and retry.');
    process.exit(1);
  }

  const baseRef = resolveBaseRef();
  if (!baseRef) {
    console.error('Unable to resolve base ref for compatibility check.');
    console.error('Set CONTRACT_BASE_REF (for CI use origin/<base-branch>, e.g. origin/main).');
    process.exit(1);
  }

  const baseTarget = `.git#ref=${baseRef},subdir=${CONTRACT_ROOT}`;
  const baseLintResult = runBufLint(baseTarget);
  const headLintResult = runBufLint(CONTRACT_ROOT);

  const baseIssues = parseLintIssues(baseLintResult.stdout || '');
  const headIssues = parseLintIssues(headLintResult.stdout || '');
  const baseIssueKeys = new Set(baseIssues.map(issueKey));

  const newIssues = headIssues.filter((issue) => !baseIssueKeys.has(issueKey(issue)));
  if (newIssues.length > 0) {
    printIssues('ERROR: New protobuf lint issues introduced compared to base branch:', newIssues);
    process.exit(1);
  }

  if (headLintResult.status !== 0) {
    console.info('Proto lint contains legacy baseline findings; no new lint violations introduced.');
  }

  const result = runBufBreaking(baseRef);
  if (result.status !== 0) {
    console.error('ERROR: Breaking change detected in protobuf contracts.');
    process.exit(result.status || 1);
  }

  console.info('Contract compatibility check passed.');
}

main();
