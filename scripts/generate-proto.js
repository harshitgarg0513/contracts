#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const standaloneRoot = path.resolve(__dirname, '..');
const boilerplateRoot = path.resolve(__dirname, '../..');
const standaloneMode = fs.existsSync(path.join(standaloneRoot, 'proto'));

const repoRoot = standaloneMode ? standaloneRoot : boilerplateRoot;
const protoRoot = standaloneMode
  ? path.join(repoRoot, 'proto')
  : path.join(repoRoot, 'contracts', 'proto');
const generatedRoot = standaloneMode
  ? path.join(repoRoot, 'generated', 'typescript')
  : path.join(repoRoot, 'contracts', 'generated', 'typescript');

function walkProtoFiles(dir, result = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkProtoFiles(fullPath, result);
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.proto')) {
      result.push(fullPath);
    }
  }
  return result;
}

function ensureExecutableExists(command, args = ['--version']) {
  const check = spawnSync(command, args, { stdio: 'pipe' });
  return check.status === 0;
}

function resolveTsProtoPluginPath() {
  const executableName = process.platform === 'win32' ? 'protoc-gen-ts_proto.cmd' : 'protoc-gen-ts_proto';
  const candidates = [
    path.join(repoRoot, 'contracts', 'node_modules', '.bin', executableName),
    path.join(repoRoot, 'node_modules', '.bin', executableName),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function run() {
  if (!fs.existsSync(protoRoot)) {
    console.error(`Proto directory not found at ${protoRoot}.`);
    process.exit(1);
  }

  if (!ensureExecutableExists('protoc')) {
    console.error('protoc is not installed or not available in PATH.');
    process.exit(1);
  }

  const pluginPath = resolveTsProtoPluginPath();
  if (!fs.existsSync(pluginPath)) {
    console.error('ts-proto plugin not found. Run npm install in contracts or project root first.');
    process.exit(1);
  }

  const protoFiles = walkProtoFiles(protoRoot);
  if (protoFiles.length === 0) {
    console.error(`No proto files found under ${protoRoot}.`);
    process.exit(1);
  }

  fs.rmSync(generatedRoot, { recursive: true, force: true });
  fs.mkdirSync(generatedRoot, { recursive: true });

  const args = [
    '--experimental_allow_proto3_optional',
    `--plugin=${pluginPath}`,
    `--proto_path=${protoRoot}`,
    `--ts_proto_out=${generatedRoot}`,
    '--ts_proto_opt=nestJs=true,outputServices=grpc-js,esModuleInterop=true',
    ...protoFiles,
  ];

  const generation = spawnSync('protoc', args, {
    stdio: 'inherit',
    cwd: repoRoot,
  });

  if (generation.status !== 0) {
    process.exit(generation.status || 1);
  }

  console.info(`Generated ${protoFiles.length} proto files into ${generatedRoot}.`);
}

run();
