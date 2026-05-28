# flashyields-contracts

## Setup
* use Node.js v24
* update the network config files under `./config`

```bash
npm install
cp .env.example .env
```

## Deploy

```bash
npx hardhat deploy --tags flashloan --network <network>
```

## Compile

```bash
npm run compile
```

## Test

```bash
npx hardhat test
npx hardhat test test/e2e/Permit2Fork.test.ts --network mainnet_fork
```

## Scripts
```
CONTRACT=LenderRegistry npx hardhat --build-profile default run scripts/verify.ts --network sepolia_dev

LOAN_AMOUNT=5000 LENDER_2_APPROVAL_MODE=<permit2 or onchain> FLASHLOAN_BEST_EFFORT_MODE=3-tokens npx hardhat run scripts/flashloan_best_effort.ts --network sepolia_dev

FLASHLOAN_BEST_EFFORT_LENDER_ADDRESSES=0x...,0x... FLASHLOAN_BEST_EFFORT_TOKEN_ADDRESSES=0x...,0x... FLASHLOAN_BEST_EFFORT_AMOUNTS=100,250.5 npx hardhat run scripts/flashloan_best_effort_without_lender_keys.ts --network sepolia_dev

FLASHLOAN_BEST_EFFORT_LENDER_ADDRESSES=0x...,0x... FLASHLOAN_BEST_EFFORT_TOKEN_ADDRESSES=0x...,0x... FLASHLOAN_BEST_EFFORT_AMOUNTS=null npx hardhat run scripts/flashloan_best_effort_without_lender_keys.ts --network sepolia_dev
```
