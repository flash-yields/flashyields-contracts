import { deployScript, loadArtifact, logDeployTx } from "../../rocketh/deploy.js";
import { ZeroAddress, isAddress } from "ethers";

function requireAddress(value: string, name: string): `0x${string}` {
  if (!isAddress(value) || value === ZeroAddress) {
    throw new Error(`${name} must be set to a valid non-zero EVM address.`);
  }

  return value as `0x${string}`;
}

const MAINNET_UNISWAP_V3_POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const SEPOLIA_UNISWAP_V3_POSITION_MANAGER = "0x1238536071E1c677A632429e3655c799b22cDA52";

function getUniswapV3PositionManagerAddress(networkName: string): `0x${string}` {
  const positionManagerAddress = networkName === "sepolia_dev"
    ? SEPOLIA_UNISWAP_V3_POSITION_MANAGER
    : MAINNET_UNISWAP_V3_POSITION_MANAGER;

  return requireAddress(positionManagerAddress, "Uniswap V3 position manager");
}

export default deployScript(
  async ({ deploy, namedAccounts, getOrNull, network, name }) => {
    const deployer = namedAccounts.deployer;
    const flashLoanAddress = (getOrNull("ApprovalFlashLoan")?.address ?? "").trim();
    const uniswapV3PositionManagerAddress = getUniswapV3PositionManagerAddress(name);

    const flashLoanReceiverWithUniswapArtifact = await loadArtifact(
      "FlashLoanReceiverWithUniswap",
      "example/FlashLoanReceiverWithUniswap"
    );
    const result = await deploy("FlashLoanReceiverWithUniswap", {
      artifact: flashLoanReceiverWithUniswapArtifact,
      account: deployer,
      args: [
        requireAddress(flashLoanAddress, "ApprovalFlashLoan deployment"),
        uniswapV3PositionManagerAddress,
      ],
    });

    await logDeployTx(network.provider, result);
  },
  { tags: ["FlashLoanReceiverWithUniswap"], dependencies: ["ApprovalFlashLoan"] }
);
