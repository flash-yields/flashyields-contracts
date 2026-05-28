import { deployScript, loadArtifact, logDeployTx } from "../rocketh/deploy.js";
import { getNetworkConfig } from "../config/types.js";

export default deployScript(
  async ({ deploy, namedAccounts, network, name, getOrNull }) => {
    const config = getNetworkConfig(name);
    const deployer = namedAccounts.deployer;

    if (!config.aclManager) {
      throw new Error("aclManager address must be set in the network config.");
    }

    const approvalFlashLoanDeployment = getOrNull("ApprovalFlashLoan");
    if (!approvalFlashLoanDeployment?.address) {
      throw new Error("ApprovalFlashLoan must be deployed before ERC20Vault.");
    }

    const initialTokens = config.erc20VaultInitialWhitelistedTokens ?? [];
    const initialMinimumDepositAmounts = config.erc20VaultInitialMinimumDepositAmounts ?? initialTokens.map(() => 0n);
    if (initialTokens.length !== initialMinimumDepositAmounts.length) {
      throw new Error("erc20VaultInitialWhitelistedTokens and erc20VaultInitialMinimumDepositAmounts length mismatch.");
    }

    const erc20VaultArtifact = await loadArtifact("ERC20Vault");
    const result = await deploy("ERC20Vault", {
      artifact: erc20VaultArtifact,
      account: deployer,
      args: [
        approvalFlashLoanDeployment.address,
        config.aclManager,
        initialTokens,
        initialTokens.map(() => true),
        initialMinimumDepositAmounts,
      ],
    });

    await logDeployTx(network.provider, result);
  },
  { tags: ["ERC20Vault", "flashloan"], dependencies: ["ApprovalFlashLoan"] }
);
