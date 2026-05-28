import { deployScript, loadArtifact, logDeployTx } from "../../rocketh/deploy.js";
import { ZeroAddress, isAddress } from "ethers";

function requireAddress(value: string, name: string): `0x${string}` {
  if (!isAddress(value) || value === ZeroAddress) {
    throw new Error(`${name} must be set to a valid non-zero EVM address.`);
  }

  return value as `0x${string}`;
}

export default deployScript(
  async ({ deploy, namedAccounts, getOrNull, network }) => {
    const deployer = namedAccounts.deployer;
    const flashLoanAddress = (getOrNull("ApprovalFlashLoan")?.address ?? "").trim();

    const flashLoanReceiverSimpleArtifact = await loadArtifact(
      "FlashLoanReceiverSimple",
      "example/FlashLoanReceiverSimple"
    );
    const result = await deploy("FlashLoanReceiverSimple", {
      artifact: flashLoanReceiverSimpleArtifact,
      account: deployer,
      args: [requireAddress(flashLoanAddress, "ApprovalFlashLoan deployment")],
    });

    await logDeployTx(network.provider, result);
  },
  { tags: ["FlashLoanReceiverSimple"], dependencies: ["ApprovalFlashLoan"] }
);
