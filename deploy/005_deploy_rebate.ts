import { deployScript, loadArtifact, logDeployTx } from "../rocketh/deploy.js";
import { getNetworkConfig } from "../config/types.js";

export default deployScript(
  async ({ deploy, namedAccounts, network, name }) => {
    const config = getNetworkConfig(name);
    const deployer = namedAccounts.deployer;

    if (!config.aclManager) {
      throw new Error("aclManager address must be set in the network config.");
    }

    if (!config.weth) {
      throw new Error("weth address must be set in the network config.");
    }

    if (!config.protocolToken) {
      throw new Error("protocolToken address must be set in the network config.");
    }

    if (!config.veToken) {
      throw new Error("veToken address must be set in the network config.");
    }

    const initialDailyWithdrawalCapTokens = config.rebateInitialDailyWithdrawalCapTokens ?? [];
    const initialDailyWithdrawalCaps = config.rebateInitialDailyWithdrawalCaps ?? initialDailyWithdrawalCapTokens.map(() => 0n);
    if (initialDailyWithdrawalCapTokens.length !== initialDailyWithdrawalCaps.length) {
      throw new Error("rebateInitialDailyWithdrawalCapTokens and rebateInitialDailyWithdrawalCaps length mismatch.");
    }

    const rebateArtifact = await loadArtifact("Rebate");
    const result = await deploy("Rebate", {
      artifact: rebateArtifact,
      account: deployer,
      args: [
        config.aclManager,
        initialDailyWithdrawalCapTokens,
        initialDailyWithdrawalCaps,
        config.weth,
        config.protocolToken,
        config.veToken,
      ],
    });

    await logDeployTx(network.provider, result);
  },
  { tags: ["Rebate", "flashloan"] }
);
