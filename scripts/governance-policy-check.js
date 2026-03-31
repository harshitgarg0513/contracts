#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_BASES = ['origin/main', 'main', 'HEAD~1'];
const standaloneRoot = path.resolve(__dirname, '..');
const boilerplateRoot = path.resolve(__dirname, '../..');
const standaloneMode = fs.existsSync(path.join(standaloneRoot, 'proto'));
const REPO_ROOT = standaloneMode ? standaloneRoot : boilerplateRoot;
const CONTRACT_ROOT = standaloneMode ? 'proto' : 'contracts/proto';

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

function getChangedProtoFiles(baseRef) {
  const output = run(`git diff --name-only --diff-filter=ACMRT ${baseRef}...HEAD -- ${CONTRACT_ROOT}`);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.proto'));
}

function ensureBufInstalled() {
  const check = spawnSync('buf', ['--version'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  return check.status === 0;
}

function runBufBreaking(baseRef) {
  const against = `.git#ref=${baseRef},subdir=${CONTRACT_ROOT}`;
  return spawnSync('buf', ['breaking', CONTRACT_ROOT, '--against', against], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

function getGitFile(ref, filePath) {
  return run(`git show ${ref}:${filePath}`);
}

function getCurrentFile(filePath) {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, filePath), 'utf8');
  } catch (error) {
    return '';
  }
}

function findBlocks(content, keyword) {
  const blocks = [];
  const pattern = new RegExp(`\\b${keyword}\\s+(\\w+)\\s*\\{`, 'g');
  let match = pattern.exec(content);

  while (match) {
    const name = match[1];
    const openBraceIndex = content.indexOf('{', match.index);
    let depth = 1;
    let i = openBraceIndex + 1;
    while (i < content.length && depth > 0) {
      const ch = content[i];
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
      }
      i += 1;
    }

    if (depth === 0) {
      blocks.push({
        name,
        body: content.slice(openBraceIndex + 1, i - 1),
      });
      pattern.lastIndex = i;
    } else {
      break;
    }

    match = pattern.exec(content);
  }

  return blocks;
}

function parseReservedEntries(body) {
  const reservedNumbers = new Set();
  const reservedNames = new Set();
  const reservedRanges = [];

  const reservedRegex = /^\s*reserved\s+([^;]+);/gm;
  let match = reservedRegex.exec(body);
  while (match) {
    const entries = match[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const entry of entries) {
      const nameMatch = entry.match(/^"([^"]+)"$/);
      if (nameMatch) {
        reservedNames.add(nameMatch[1]);
        continue;
      }

      const rangeMatch = entry.match(/^(\d+)\s+to\s+(\d+|max)$/i);
      if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = rangeMatch[2].toLowerCase() === 'max' ? Number.MAX_SAFE_INTEGER : Number(rangeMatch[2]);
        reservedRanges.push({ start, end });
        continue;
      }

      const num = Number(entry);
      if (!Number.isNaN(num)) {
        reservedNumbers.add(num);
      }
    }

    match = reservedRegex.exec(body);
  }

  return { reservedNumbers, reservedNames, reservedRanges };
}

function isNumberReserved(number, reservedInfo) {
  if (reservedInfo.reservedNumbers.has(number)) {
    return true;
  }
  return reservedInfo.reservedRanges.some((range) => number >= range.start && number <= range.end);
}

function parseMessages(content) {
  const blocks = findBlocks(content, 'message');
  const messages = {};

  for (const block of blocks) {
    const fieldsByName = {};
    const fieldRegex = /^\s*(?:repeated\s+|optional\s+|required\s+)?[A-Za-z0-9_.]+\s+(\w+)\s*=\s*(\d+)\s*(?:\[[^\]]*\])?\s*;/gm;
    let fieldMatch = fieldRegex.exec(block.body);
    while (fieldMatch) {
      fieldsByName[fieldMatch[1]] = Number(fieldMatch[2]);
      fieldMatch = fieldRegex.exec(block.body);
    }

    messages[block.name] = {
      fieldsByName,
      ...parseReservedEntries(block.body),
    };
  }

  return messages;
}

function parseEnums(content) {
  const blocks = findBlocks(content, 'enum');
  const enums = {};

  for (const block of blocks) {
    const valuesByName = {};
    const enumValueRegex = /^\s*(\w+)\s*=\s*(\d+)\s*(?:\[[^\]]*\])?\s*;/gm;
    let enumMatch = enumValueRegex.exec(block.body);
    while (enumMatch) {
      valuesByName[enumMatch[1]] = Number(enumMatch[2]);
      enumMatch = enumValueRegex.exec(block.body);
    }

    enums[block.name] = {
      valuesByName,
      ...parseReservedEntries(block.body),
    };
  }

  return enums;
}

function checkReservedDeletionPolicy(filePath, oldContent, newContent, errors) {
  const oldMessages = parseMessages(oldContent);
  const newMessages = parseMessages(newContent);

  for (const [messageName, oldMessage] of Object.entries(oldMessages)) {
    const newMessage = newMessages[messageName];
    if (!newMessage) {
      continue;
    }

    for (const [fieldName, oldNumber] of Object.entries(oldMessage.fieldsByName)) {
      if (Object.prototype.hasOwnProperty.call(newMessage.fieldsByName, fieldName)) {
        continue;
      }

      const numberReserved = isNumberReserved(oldNumber, newMessage);
      const nameReserved = newMessage.reservedNames.has(fieldName);
      if (!numberReserved && !nameReserved) {
        errors.push(
          `${filePath} :: message ${messageName} removed field ${fieldName}=${oldNumber} without reserving number or name`,
        );
      }
    }
  }

  const oldEnums = parseEnums(oldContent);
  const newEnums = parseEnums(newContent);

  for (const [enumName, oldEnum] of Object.entries(oldEnums)) {
    const newEnum = newEnums[enumName];
    if (!newEnum) {
      continue;
    }

    for (const [valueName, oldNumber] of Object.entries(oldEnum.valuesByName)) {
      if (Object.prototype.hasOwnProperty.call(newEnum.valuesByName, valueName)) {
        continue;
      }

      const numberReserved = isNumberReserved(oldNumber, newEnum);
      const nameReserved = newEnum.reservedNames.has(valueName);
      if (!numberReserved && !nameReserved) {
        errors.push(
          `${filePath} :: enum ${enumName} removed value ${valueName}=${oldNumber} without reserving number or name`,
        );
      }
    }
  }
}

function getVersionDir(filePath) {
  const match = filePath.match(/^(contracts\/proto\/.+\/v\d+)\//);
  return match ? match[1] : '';
}

function pathExistsInRef(ref, treePath) {
  const out = run(`git ls-tree -d --name-only ${ref} -- ${treePath}`);
  return out === treePath;
}

function getVersionNumber(versionDir) {
  const match = versionDir.match(/\/v(\d+)$/);
  return match ? Number(match[1]) : NaN;
}

function getNamespaceRoot(versionDir) {
  return versionDir.replace(/\/v\d+$/, '');
}

function listProtoFilesInRef(ref, dirPath) {
  const out = run(`git ls-tree -r --name-only ${ref} -- ${dirPath}`);
  if (!out) {
    return [];
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.proto'));
}

function listProtoFilesInWorkspace(dirPath) {
  const absoluteDir = path.join(REPO_ROOT, dirPath);
  if (!fs.existsSync(absoluteDir)) {
    return [];
  }

  const result = [];
  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.endsWith('.proto')) {
        const relative = path.relative(REPO_ROOT, fullPath).replace(/\\/g, '/');
        result.push(relative);
      }
    }
  }

  walk(absoluteDir);
  return result;
}

function parseServiceRpcMap(content) {
  const services = {};
  const blocks = findBlocks(content, 'service');
  const rpcRegex = /^\s*rpc\s+(\w+)\s*\(\s*(?:stream\s+)?[A-Za-z0-9_.]+\s*\)\s*returns\s*\(\s*(?:stream\s+)?[A-Za-z0-9_.]+\s*\)\s*(?:\{[\s\S]*?\})?\s*;?/gm;

  for (const block of blocks) {
    const rpcNames = new Set();
    let rpcMatch = rpcRegex.exec(block.body);
    while (rpcMatch) {
      rpcNames.add(rpcMatch[1]);
      rpcMatch = rpcRegex.exec(block.body);
    }
    services[block.name] = rpcNames;
  }

  return services;
}

function parseTopLevelNames(content) {
  const messages = new Set(Object.keys(parseMessages(content)));
  const enums = new Set(Object.keys(parseEnums(content)));
  return { messages, enums };
}

function enforceNewVersionCompleteness(baseRef, newVersionDirs, errors) {
  for (const newVersionDir of newVersionDirs) {
    const version = getVersionNumber(newVersionDir);
    if (!Number.isFinite(version) || version <= 1) {
      continue;
    }

    const previousVersionDir = `${getNamespaceRoot(newVersionDir)}/v${version - 1}`;
    if (!pathExistsInRef(baseRef, previousVersionDir)) {
      continue;
    }

    const oldFiles = listProtoFilesInRef(baseRef, previousVersionDir);
    const newFiles = listProtoFilesInWorkspace(newVersionDir);

    const oldRelToPrev = new Set(oldFiles.map((filePath) => filePath.replace(`${previousVersionDir}/`, '')));
    const newRelToNew = new Set(newFiles.map((filePath) => filePath.replace(`${newVersionDir}/`, '')));

    for (const relPath of oldRelToPrev) {
      if (!newRelToNew.has(relPath)) {
        errors.push(
          `${newVersionDir} :: missing proto file ${relPath} from previous version baseline ${previousVersionDir}`,
        );
      }
    }

    for (const relPath of oldRelToPrev) {
      if (!newRelToNew.has(relPath)) {
        continue;
      }

      const oldFilePath = `${previousVersionDir}/${relPath}`;
      const newFilePath = `${newVersionDir}/${relPath}`;
      const oldContent = getGitFile(baseRef, oldFilePath);
      const newContent = getCurrentFile(newFilePath);
      if (!oldContent || !newContent) {
        continue;
      }

      const oldServices = parseServiceRpcMap(oldContent);
      const newServices = parseServiceRpcMap(newContent);

      for (const [serviceName, oldRpcs] of Object.entries(oldServices)) {
        const newRpcs = newServices[serviceName];
        if (!newRpcs) {
          errors.push(`${newFilePath} :: missing service ${serviceName} from ${oldFilePath}`);
          continue;
        }
        for (const rpcName of oldRpcs) {
          if (!newRpcs.has(rpcName)) {
            errors.push(`${newFilePath} :: missing rpc ${serviceName}.${rpcName} from ${oldFilePath}`);
          }
        }
      }

      const oldTopLevel = parseTopLevelNames(oldContent);
      const newTopLevel = parseTopLevelNames(newContent);

      for (const messageName of oldTopLevel.messages) {
        if (!newTopLevel.messages.has(messageName)) {
          errors.push(`${newFilePath} :: missing message ${messageName} from ${oldFilePath}`);
        }
      }

      for (const enumName of oldTopLevel.enums) {
        if (!newTopLevel.enums.has(enumName)) {
          errors.push(`${newFilePath} :: missing enum ${enumName} from ${oldFilePath}`);
        }
      }
    }
  }
}

function main() {
  if (!ensureBufInstalled()) {
    console.error('buf CLI is required for contract governance policy checks.');
    process.exit(1);
  }

  const baseRef = resolveBaseRef();
  if (!baseRef) {
    console.error('Unable to resolve base ref for governance policy checks.');
    console.error('Set CONTRACT_BASE_REF (for CI use origin/<base-branch>, e.g. origin/main).');
    process.exit(1);
  }

  const changedFiles = getChangedProtoFiles(baseRef);
  if (changedFiles.length === 0) {
    console.info('No proto changes detected for governance policy checks.');
    process.exit(0);
  }

  const changedVersionDirs = Array.from(new Set(changedFiles.map(getVersionDir).filter(Boolean)));
  const existingVersionDirs = changedVersionDirs.filter((dir) => pathExistsInRef(baseRef, dir));
  const newVersionDirs = changedVersionDirs.filter((dir) => !pathExistsInRef(baseRef, dir));

  const enforceFreeze = (process.env.CONTRACT_ENFORCE_FREEZE || '').toLowerCase() === 'true';
  if (enforceFreeze && existingVersionDirs.length > 0) {
    console.error('ERROR: Released contract versions are frozen and cannot be modified.');
    for (const dir of existingVersionDirs) {
      console.error(` - ${dir}`);
    }
    console.error('Policy: create a new version directory (for example v2) for any API evolution.');
    process.exit(1);
  }

  const reservedPolicyErrors = [];
  for (const filePath of changedFiles) {
    const oldContent = getGitFile(baseRef, filePath);
    const newContent = getCurrentFile(filePath);
    if (!oldContent || !newContent) {
      continue;
    }

    checkReservedDeletionPolicy(filePath, oldContent, newContent, reservedPolicyErrors);
  }

  if (reservedPolicyErrors.length > 0) {
    console.error('ERROR: Reserved deletion policy violations detected.');
    for (const error of reservedPolicyErrors) {
      console.error(` - ${error}`);
    }
    process.exit(1);
  }

  const completenessErrors = [];
  enforceNewVersionCompleteness(baseRef, newVersionDirs, completenessErrors);
  if (completenessErrors.length > 0) {
    console.error('ERROR: New version completeness policy violations detected.');
    for (const error of completenessErrors) {
      console.error(` - ${error}`);
    }
    process.exit(1);
  }

  const breakingResult = runBufBreaking(baseRef);
  if (breakingResult.status === 0) {
    console.info('Governance policy check passed.');
    process.exit(0);
  }

  if (existingVersionDirs.length > 0) {
    console.error('ERROR: Breaking changes were introduced in existing released version directories.');
    for (const dir of existingVersionDirs) {
      console.error(` - ${dir}`);
    }
    if (newVersionDirs.length > 0) {
      console.error('A new version directory was added, but existing version directories were still broken.');
      console.error('Keep existing versions backward compatible and place breaking changes only in the new version.');
    } else {
      console.error('Policy: breaking changes must be introduced under a new version directory (for example v2).');
    }
    process.exit(1);
  }

  console.error('ERROR: Breaking changes detected and governance policy could not confirm a safe version migration path.');
  process.exit(1);
}

main();
