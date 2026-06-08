import type { NetworkConfig } from "./types.js";

const config: NetworkConfig = {
  aclManager: "0x",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  flashLoanFeeRecipient: "0x",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  protocolToken: "0x",
  veToken: "0x",
  flashLoanFeeBps: 5n,
  maxStaleness: 86_400n,
  rebateInitialDailyWithdrawalCapTokens: [],
  rebateInitialDailyWithdrawalCaps: [],
  erc20VaultInitialWhitelistedTokens: [],
  erc20VaultInitialMinimumDepositAmounts: [],
};

export default config;
