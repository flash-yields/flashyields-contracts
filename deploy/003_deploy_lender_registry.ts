import { deployScript, loadArtifact, logDeployTx } from "../rocketh/deploy.js";

export default deployScript(
  async ({ deploy, namedAccounts, network, getOrNull }) => {
    const deployer = namedAccounts.deployer;

    const approvalFlashLoanDeployment = getOrNull("ApprovalFlashLoan");
    if (!approvalFlashLoanDeployment?.address) {
      throw new Error("ApprovalFlashLoan must be deployed before LenderRegistry.");
    }

    const lenderRegistryArtifact = await loadArtifact("LenderRegistry");
    const result = await deploy("LenderRegistry", {
      artifact: lenderRegistryArtifact,
      account: deployer,
      args: [approvalFlashLoanDeployment.address],
    });

    await logDeployTx(network.provider, result);
  },
  { tags: ["LenderRegistry", "flashloan"], dependencies: ["ApprovalFlashLoan"] }
);
