import hardhat from "./hardhat.js";
import sepoliaDev from "./sepolia_dev.js";
import mainnetProd from "./mainnet_prod.js";

export type NetworkConfig = {
  aclManager?: `0x${string}`;
  permit2?: `0x${string}`;
  flashLoanFeeRecipient?: `0x${string}`;
  weth?: `0x${string}`;
  protocolToken?: `0x${string}`;
  veToken?: `0x${string}`;
  flashLoanFeeBps?: bigint;
  maxStaleness?: bigint;
  rebateInitialDailyWithdrawalCapTokens?: `0x${string}`[];
  rebateInitialDailyWithdrawalCaps?: bigint[];
  erc20VaultInitialWhitelistedTokens?: `0x${string}`[];
  erc20VaultInitialMinimumDepositAmounts?: bigint[];
};

const configs: Record<string, NetworkConfig> = {
  default: hardhat,
  sepolia_dev: sepoliaDev,
  mainnet_prod: mainnetProd,
};

export function getNetworkConfig(networkName: string): NetworkConfig {
  return configs[networkName] ?? {};
}
