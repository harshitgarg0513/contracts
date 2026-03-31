# Contracts Repository

Shared protobuf contracts and governance scripts for BeatRoute services.

## Contents

- `proto/`: versioned protobuf contracts
- `generated/typescript/`: generated TypeScript artifacts
- `scripts/generate-proto.js`: code generation
- `scripts/compatibility-check.js`: lint and breaking compatibility gate
- `scripts/governance-policy-check.js`: freeze, reserved, and completeness policy checks

## Usage

Install dependencies:

```bash
npm ci
```

Generate TypeScript contracts:

```bash
npm run generate
```

Compatibility checks:

```bash
CONTRACT_BASE_REF=origin/main npm run check
```

Governance checks:

```bash
CONTRACT_BASE_REF=origin/main CONTRACT_ENFORCE_FREEZE=true node scripts/governance-policy-check.js
```
