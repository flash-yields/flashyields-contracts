import type { NetworkConfig } from "./types.js";

const config: NetworkConfig = {
  aclManager: "0x12643B525CC34282bA84298d32bF2d094448F1C4",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  flashLoanFeeRecipient: "0x12643B525CC34282bA84298d32bF2d094448F1C4",
  weth: "0x",
  protocolToken: "0x",
  veToken: "0x",
  flashLoanFeeBps: 6n,
  maxStaleness: 86_400n,
  rebateInitialDailyWithdrawalCapTokens: [],
  rebateInitialDailyWithdrawalCaps: [],
  erc20VaultInitialWhitelistedTokens: [],
  erc20VaultInitialMinimumDepositAmounts: [],
};

export default config;
