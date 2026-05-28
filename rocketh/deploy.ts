import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupDeployScripts } from "rocketh";
import type { Abi } from "@rocketh/deploy";
import { extensions, type Accounts, type Data, type Extensions } from "./config.js";

type JsonRpcProviderLike = {
  request(args: {
    method: "eth_getTransactionReceipt";
    params: readonly [`0x${string}`];
  }): Promise<{ gasUsed?: string } | null>;
};

type DeployResultLike = {
  newlyDeployed: boolean;
  transaction?: { hash: `0x${string}` };
};

type ArtifactLike = {
  abi: Abi;
  bytecode: `0x${string}`;
  metadata: string;
  deployedBytecode?: `0x${string}`;
  contractName: string;
  sourceName: string;
};

type RawArtifactLike = Omit<ArtifactLike, "metadata"> & {
  metadata?: string;
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function logDeployTx(provider: JsonRpcProviderLike, result: DeployResultLike) {
  if (!result.newlyDeployed || !result.transaction?.hash) return;

  const receipt = await provider.request({
    method: "eth_getTransactionReceipt",
    params: [result.transaction.hash] as const,
  });

  console.log(`\ntxHash=${result.transaction.hash}`);
  console.log(`gasUsed=${receipt?.gasUsed ? parseInt(receipt.gasUsed, 16) : "unknown"}`);
}

export async function loadArtifact(contractName: string, sourceName = contractName): Promise<ArtifactLike> {
  const artifactPath = path.join(rootDir, "artifacts", "contracts", `${sourceName}.sol`, `${contractName}.json`);
  const artifactFile = await readFile(artifactPath, "utf8");
  const artifact = JSON.parse(artifactFile) as RawArtifactLike;
  return { ...artifact, metadata: artifact.metadata ?? "" };
}

const { deployScript } = setupDeployScripts<Extensions, Accounts, Data>(extensions);

export { deployScript };
