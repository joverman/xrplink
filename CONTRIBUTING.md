# Contributing to XRPLink

Thanks for your interest! XRPLink is in alpha — contributions are welcome.

## Getting Started

1. Fork the repo
2. `npm install`
3. Copy `.env.example` to `.env` and fill in your test keys
4. `npx hardhat compile` to verify Solidity compiles

## Running Tests

```bash
npx hardhat test
```

All 8 tests should pass.

## Pull Request Process

1. Keep PRs focused — one feature/fix per PR
2. Update tests if changing contract or API behavior
3. Run `npx hardhat test` before submitting
4. Update docs if changing configuration or endpoints

## Code Style

- Solidity: 0.8.25, EVM cancun, NatSpec comments
- TypeScript: ESM, strict mode
- Scripts: `tsx` runtime
- No `any` types unless absolutely necessary

## Reporting Issues

- Bug reports: include server logs, `.env` config (redact keys), and steps to reproduce
- Feature requests: describe the use case, not just the solution

## Questions?

Open a discussion or issue.
