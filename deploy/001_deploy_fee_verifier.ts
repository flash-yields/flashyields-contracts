import { deployScript, loadArtifact, logDeployTx } from "../rocketh/deploy.js";
import { getNetworkConfig } from "../config/types.js";

export default deployScript(
  async ({ deploy, namedAccounts, network, name }) => {
    const config = getNetworkConfig(name);
    const deployer = namedAccounts.deployer;
    const flashLoanFeeRecipient = config.flashLoanFeeRecipient ?? deployer;
    const flashLoanFeeBps = config.flashLoanFeeBps ?? 9n;
    const maxStaleness = config.maxStaleness ?? 86_400n;

    if (!config.aclManager) {
      throw new Error("aclManager address must be set in the network config.");
    }

    if (flashLoanFeeBps > 10_000n) {
      throw new Error("FLASH_LOAN_FEE_BPS must be less than or equal to 10000.");
    }

    if (maxStaleness === 0n) {
      throw new Error("maxStaleness must be greater than zero.");
    }

    const feeVerifierArtifact = await loadArtifact("FeeVerifier");
    const result = await deploy("FeeVerifier", {
      artifact: feeVerifierArtifact,
      account: deployer,
      args: [config.aclManager, flashLoanFeeRecipient, flashLoanFeeBps, maxStaleness],
    });

    await logDeployTx(network.provider, result);
  },
  { tags: ["FeeVerifier", "flashloan"] }
);
