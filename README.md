# flashyields-contracts

## Mainnet Deployments
* `ApprovalFlashLoan` was deployed at [0x51a6262916c1fDD5dD25E3bA11cbF76427A126A3](https://etherscan.io/address/0x51a6262916c1fDD5dD25E3bA11cbF76427A126A3#code)
* `FeeVerifier` was deployed at [0x7F8C574610b1EA0C333E5d2681e2916403284FFf](https://etherscan.io/address/0x7F8C574610b1EA0C333E5d2681e2916403284FFf#code)
* `Rebate` was deployed at [0x4D71B255963DaC711506020B5139402b168B3418](https://etherscan.io/address/0x4D71B255963DaC711506020B5139402b168B3418#code)
* `LenderRegistry` was deployed at [0xB8b30e5497aaA6f4FbA9Bf373Cf8831fE15A1662](https://etherscan.io/address/0xB8b30e5497aaA6f4FbA9Bf373Cf8831fE15A1662#code)
* [Sigma Prime](https://x.com/sigp_io) and [Quantstamp](https://x.com/Quantstamp) have audited the main contracts and verified the mainnet deployments. Please refer to [here](./audit-reports/).

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
```
