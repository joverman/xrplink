# Open Source Preparation Plan

## Three Prep Steps

---

### Step 1: Add `LICENSE` (MIT)

Create `LICENSE` with standard MIT text:

```
MIT License

Copyright (c) 2026 XRPLink

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Also add a `"license": "MIT"` field to `package.json`.

---

### Step 2: Add `CONTRIBUTING.md`

Create `CONTRIBUTING.md` with:

```markdown
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
- TypeScript: ESM, strict mode, no semicolons
- Scripts: `tsx` runtime
- No `any` types unless absolutely necessary

## Reporting Issues
- Bug reports: include server logs, .env config (redact keys), and steps to reproduce
- Feature requests: describe the use case, not just the solution

## Questions?
Open a discussion or issue. We're responsive.
```

---

### Step 3: Update `README.md`

Changes needed:

#### A. Add alpha banner at the very top
```markdown
> **⚠️ Alpha Software** — XRPLink is in active development. The pipeline is validated on
> Coston2 testnet. Mainnet deployment and production use pending. Use at your own risk.
```

#### B. Add open source badge after the title
```markdown
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
```

#### C. Update project status table
Add row at bottom:
```
| Open source release | 📋 Prepared — MIT license, CONTRIBUTING guide |
```

#### D. Add "Quick Start" section after project status
```markdown
## Quick Start
```bash
git clone <repo-url>
cd xrplink
npm install
cp .env.example .env
# Edit .env with your test keys
npm run start:rest
curl http://localhost:3000/health
```
```

#### E. Add "Contributing" section near the bottom
```markdown
## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All contributions welcome —
bug fixes, feature requests, docs improvements, and test additions.

XRPLink is open source (MIT) and built for the Flare ecosystem.
```

#### F. Update `package.json` with repo metadata
Add at the end of `package.json`:
```json
"license": "MIT",
"repository": {
  "type": "git",
  "url": "git+https://github.com/<your-org>/xrp-link-test.git"
},
"homepage": "https://github.com/<your-org>/xrp-link-test#readme",
"bugs": {
  "url": "https://github.com/<your-org>/xrp-link-test/issues"
}
```

---

## Files Created/Modified

| File | Action | Purpose |
|------|--------|---------|
| `LICENSE` | **CREATE** | MIT license text |
| `CONTRIBUTING.md` | **CREATE** | Contribution guide |
| `README.md` | **MODIFY** | Alpha banner, badges, quick start, contributing section |
| `package.json` | **MODIFY** | License + repo metadata fields |

---

## Future: AOE Agent Skills

For later: Create agent skills (config files, tool descriptions, prompt templates) that let AOE agents autonomously use XRPLink without manual configuration. This would include:

- Pre-built MCP server configuration for AOE compatibility
- Skill manifests describing XRPLink's capabilities in AOE format
- Example workflows: "Verify XRP payment", "Check attestation status", "Monitor round completion"

Not implementing now — captured for future roadmap.

---

## Execution Order
1. Create `LICENSE`
2. Create `CONTRIBUTING.md`
3. Update `README.md` (banner + badges + quick start + contributing)
4. Update `package.json`
5. Commit

Ready to execute when you are.
