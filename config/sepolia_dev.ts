import type { NetworkConfig } from "./types.js";

const config: NetworkConfig = {
  aclManager: "0x625670739e80c5a7A1336F56d0d3276636A313E8",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  flashLoanFeeRecipient: "0x12643B525CC34282bA84298d32bF2d094448F1C4",
  weth: "0xDCaCbfb9970163530A16C3dDaE2b77f3A775B64C",
  protocolToken: "0x0000000000000000000000000000000000000000",
  veToken: "0x0000000000000000000000000000000000000000",
  flashLoanFeeBps: 6n,
  maxStaleness: 86_400n,
  rebateInitialDailyWithdrawalCapTokens: [],
  rebateInitialDailyWithdrawalCaps: [],
  erc20VaultInitialWhitelistedTokens: [],
  erc20VaultInitialMinimumDepositAmounts: [],
};

export default config;
