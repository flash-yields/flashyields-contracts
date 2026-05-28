import { expect } from "chai";
import {
  deployFlashLoanFixture,
  deployToken,
  ethers,
  networkHelpers,
} from "../fixtures/deploy.js";

describe("Gas: LenderRegistry", function () {
  const ERC20_BALANCES_SLOT = 0n;
  const ERC20_ALLOWANCES_SLOT = 1n;
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();

  function formatGasUsed(gasUsed: bigint) {
    return gasUsed.toLocaleString("en-US");
  }

  function erc20MappingSlot(account: string, slot: bigint) {
    return ethers.keccak256(abiCoder.encode(["address", "uint256"], [account, slot]));
  }

  function erc20AllowanceSlot(owner: string, spender: string) {
    const ownerAllowancesSlot = erc20MappingSlot(owner, ERC20_ALLOWANCES_SLOT);
    return ethers.keccak256(abiCoder.encode(["address", "uint256"], [spender, ownerAllowancesSlot]));
  }

  async function setTokenBalanceAndAllowance(tokenAddress: string, owner: string, spender: string, amount: bigint) {
    const storageValue = ethers.toBeHex(amount, 32);
    await networkHelpers.setStorageAt(tokenAddress, erc20MappingSlot(owner, ERC20_BALANCES_SLOT), storageValue);
    await networkHelpers.setStorageAt(tokenAddress, erc20AllowanceSlot(owner, spender), storageValue);
  }

  async function expectBookkeeperUpdateGas(lenderAddresses: string[], tokenCount: number, label: string) {
    const {
      lenderRegistry,
      bookKeeper,
      tokenA,
      tokenB,
      feeToken,
    } = await networkHelpers.loadFixture(deployFlashLoanFixture);
    const tokenAddresses = [
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      await feeToken.getAddress(),
    ];
    for (let i = tokenAddresses.length; i < tokenCount; i++) {
      const token = await deployToken(`Token ${i + 1}`, `TKN${i + 1}`, 18);
      tokenAddresses.push(await token.getAddress());
    }
    tokenAddresses.splice(tokenCount);
    const lenderParticipations = tokenAddresses.map((token) => ({
      token,
      lenders: lenderAddresses,
    }));

    const indicateTx = await lenderRegistry.connect(bookKeeper).indicateParticipationFor(lenderParticipations);
    const indicateReceipt = await indicateTx.wait();

    expect(indicateReceipt).not.to.equal(null);
    expect(indicateReceipt!.gasUsed > 0n).to.equal(true);

    const availability = await lenderRegistry.getAllPotentialLendersAvailability();
    expect(availability).to.have.lengthOf(tokenAddresses.length);
    for (const tokenAvailability of availability) {
      expect([...tokenAvailability.lenders]).to.deep.equal([]);
      expect([...tokenAvailability.availableAmounts]).to.deep.equal([]);
    }

    const removeTx = await lenderRegistry.connect(bookKeeper).removeParticipationFor(lenderParticipations);
    const removeReceipt = await removeTx.wait();

    expect(removeReceipt).not.to.equal(null);
    expect(removeReceipt!.gasUsed > 0n).to.equal(true);
    expect(await lenderRegistry.getAllPotentialLendersAvailability()).to.have.lengthOf(0);

    console.log(
      `LenderRegistry indicateParticipationFor gas used (${label}): ${formatGasUsed(indicateReceipt!.gasUsed)}`
    );
    console.log(
      `LenderRegistry removeParticipationFor gas used (${label}): ${formatGasUsed(removeReceipt!.gasUsed)}`
    );
  }

  async function expectPotentialLendersAvailabilityGas(
    lenderCount: number,
    availableLenderCount: number,
    label: string
  ) {
    const {
      lenderRegistry,
      bookKeeper,
      tokenA,
      flashLoan,
    } = await networkHelpers.loadFixture(deployFlashLoanFixture);
    const lenderAddresses = deterministicLenderAddresses(lenderCount);
    const tokenAddress = await tokenA.getAddress();
    const flashLoanAddress = await flashLoan.getAddress();
    const availableAmount = ethers.parseEther("1");
    const registrationBatchSize = 100;

    expect(availableLenderCount).to.be.lessThanOrEqual(lenderCount);

    for (let i = 0; i < lenderAddresses.length; i += registrationBatchSize) {
      await lenderRegistry.connect(bookKeeper).indicateParticipationFor([
        {
          token: tokenAddress,
          lenders: lenderAddresses.slice(i, i + registrationBatchSize),
        },
      ]);
    }

    for (const lenderAddress of lenderAddresses.slice(0, availableLenderCount)) {
      await setTokenBalanceAndAllowance(tokenAddress, lenderAddress, flashLoanAddress, availableAmount);
    }

    const availability = await lenderRegistry.getPotentialLendersAvailabilityByToken(tokenAddress);
    expect(availability).to.have.lengthOf(availableLenderCount);

    if (availableLenderCount !== 0) {
      expect(availability[0].lender).to.equal(lenderAddresses[0]);
      expect(availability[0].availableAmount).to.equal(availableAmount);
      expect(availability[availableLenderCount - 1].lender).to.equal(lenderAddresses[availableLenderCount - 1]);
      expect(availability[availableLenderCount - 1].availableAmount).to.equal(availableAmount);
    }

    const estimatedGas = await lenderRegistry.getPotentialLendersAvailabilityByToken.estimateGas(tokenAddress);

    expect(estimatedGas > 0n).to.equal(true);

    console.log(
      `LenderRegistry getPotentialLendersAvailabilityByToken estimated gas used (${label}): ${formatGasUsed(estimatedGas)}`
    );
  }

  function deterministicLenderAddresses(lenderCount: number) {
    return Array.from({ length: lenderCount }, (_, index) =>
      ethers.getAddress(ethers.toBeHex(10_000 + index, 20))
    );
  }

  it("estimates gas for bookkeeper updating 5 lenders with the same 5 tokens", async function () {
    const {
      lender1,
      lender2,
      lender3,
      initiator,
      feeRecipient,
    } = await networkHelpers.loadFixture(deployFlashLoanFixture);
    await expectBookkeeperUpdateGas(
      [lender1.address, lender2.address, lender3.address, initiator.address, feeRecipient.address],
      5,
      "5 lenders, same 5 tokens"
    );
  });

  it("estimates gas for bookkeeper updating 40 lenders with the same 5 tokens", async function () {
    await expectBookkeeperUpdateGas(
      deterministicLenderAddresses(40),
      5,
      "40 lenders, same 5 tokens"
    );
  });

  it("estimates gas for bookkeeper updating and removing 160 lenders with 1 token", async function () {
    await expectBookkeeperUpdateGas(
      deterministicLenderAddresses(160),
      1,
      "160 lenders, 1 token"
    );
  });

  it("estimates gas for bookkeeper updating 130 lenders with the same 5 tokens", async function () {
    await expectBookkeeperUpdateGas(
      deterministicLenderAddresses(130),
      5,
      "130 lenders, same 5 tokens"
    );
  });

  it("estimates gas for getPotentialLendersAvailabilityByToken", async function () {
    await expectPotentialLendersAvailabilityGas(
      5_00,
      4_50,
      "500 registered lenders, 450 available lenders, 1 token"
    );
  });

  it("estimates gas for getPotentialLendersAvailabilityByToken", async function () {
    await expectPotentialLendersAvailabilityGas(
      7_00,
      7_00,
      "700 registered lenders, 700 available lenders, 1 token"
    );
  });
});
