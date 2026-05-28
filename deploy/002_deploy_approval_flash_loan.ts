import { deployScript, loadArtifact, logDeployTx } from "../rocketh/deploy.js";
import { getNetworkConfig } from "../config/types.js";

export default deployScript(
  async ({ deploy, namedAccounts, network, name, getOrNull }) => {
    const config = getNetworkConfig(name);
    const deployer = namedAccounts.deployer;

    if (!config.aclManager) {
      throw new Error("aclManager address must be set in the network config.");
    }

    if (!config.permit2) {
      throw new Error("permit2 address must be set in the network config.");
    }

    const feeVerifierDeployment = getOrNull("FeeVerifier");
    if (!feeVerifierDeployment?.address) {
      throw new Error("FeeVerifier must be deployed before ApprovalFlashLoan.");
    }

    const approvalFlashLoanArtifact = await loadArtifact("ApprovalFlashLoan");
    const result = await deploy("ApprovalFlashLoan", {
      artifact: approvalFlashLoanArtifact,
      account: deployer,
      args: [config.aclManager, feeVerifierDeployment.address, config.permit2],
    });

    await logDeployTx(network.provider, result);
  },
  { tags: ["ApprovalFlashLoan", "flashloan"], dependencies: ["FeeVerifier"] }
);
