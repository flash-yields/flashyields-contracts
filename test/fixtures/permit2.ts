import permit2Sdk from "@uniswap/permit2-sdk";
import type { PermitSingle } from "@uniswap/permit2-sdk";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import type { BigNumberish, TypedDataDomain, TypedDataField } from "ethers";
import { ethers } from "./deploy.js";

const { AllowanceTransfer } = permit2Sdk as typeof import("@uniswap/permit2-sdk");

export type Permit2SignatureData = {
  amount: BigNumberish;
  expiration: BigNumberish;
  nonce: BigNumberish;
  sigDeadline: BigNumberish;
  signature: string;
};

export function emptyPermit(): Permit2SignatureData {
  return {
    amount: 0n,
    expiration: 0n,
    nonce: 0n,
    sigDeadline: 0n,
    signature: "0x",
  };
}

export async function signPermit2Allowance(params: {
  owner: HardhatEthersSigner;
  permit2: string;
  spender: string;
  token: string;
  amount: bigint;
  expiration: bigint;
  nonce: bigint;
  sigDeadline: bigint;
}): Promise<Permit2SignatureData> {
  const { owner, permit2, spender, token, amount, expiration, nonce, sigDeadline } = params;
  const chain = await ethers.provider.getNetwork();
  const permit: PermitSingle = {
    details: {
      token,
      amount: amount.toString(),
      expiration: expiration.toString(),
      nonce: nonce.toString(),
    },
    spender,
    sigDeadline: sigDeadline.toString(),
  };
  const { domain, types, values } = AllowanceTransfer.getPermitData(
    permit,
    permit2,
    Number(chain.chainId)
  );
  const signature = await owner.signTypedData(
    domain as TypedDataDomain,
    types as Record<string, TypedDataField[]>,
    values
  );

  return {
    amount,
    expiration,
    nonce,
    sigDeadline,
    signature,
  };
}
