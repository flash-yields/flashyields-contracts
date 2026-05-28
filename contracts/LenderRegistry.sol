// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "./dependencies/openzeppelin-v5.0.1/token/ERC20/IERC20.sol";
import { Pausable } from "./dependencies/openzeppelin-v5.0.1/utils/Pausable.sol";
import { IACLManager } from "./interfaces/IACLManager.sol";
import { IApprovalFlashLoan } from "./interfaces/IApprovalFlashLoan.sol";
import { ILenderRegistry } from "./interfaces/ILenderRegistry.sol";

/// @title LenderRegistry
/// @notice Standalone registry that lets lenders indicate token participation for off-chain discovery.
contract LenderRegistry is Pausable, ILenderRegistry {
    struct BitmapUpdate {
        uint256 wordIndex;
        uint256 originalWord;
        uint256 updatedWord;
        uint256 delta;
    }

    /// @notice The flash loan contract this registry tracks lender availability for.
    IApprovalFlashLoan public immutable approvalFlashLoan;

    /// @notice The ACL manager contract for role-based access control.
    IACLManager public immutable aclManager;

    /// @notice Whether any address can update its own participation.
    bool public permissionlessParticipationEnabled = false;

    /// @notice Active registry set id used to scope lender participation state.
    uint256 public currentRegistrySetId;

    /// @notice Stores each token that has at least one participating lender in a registry set.
    mapping(uint256 => address[]) private potentialTokenList;

    /// @notice Stores every lender that has received a bitmap id in a registry set.
    mapping(uint256 => address[]) private lenderList;

    /// @notice 1-based stable bitmap id of each lender in a registry set (0 = never registered).
    mapping(uint256 => mapping(address => uint256)) private lenderIndex;

    /// @notice Stores lender participation bits by registry set, token, and 256-lender word.
    mapping(uint256 => mapping(address => mapping(uint256 => uint256))) private tokenLenderBitmap;

    /// @notice Number of participating lenders currently set for each token in a registry set.
    mapping(uint256 => mapping(address => uint256)) private tokenLenderCount;

    /// @notice 1-based index of each token in a registry set's potentialTokenList (0 = not present).
    mapping(uint256 => mapping(address => uint256)) private potentialTokenListIndex;

    modifier onlyAdminRole() {
        aclManager.checkAdminRole(msg.sender);
        _;
    }

    modifier onlyPauserRole() {
        aclManager.checkPauserRole(msg.sender);
        _;
    }

    modifier onlyBookKeeperRole() {
        aclManager.checkBookKeeperRole(msg.sender);
        _;
    }

    /// @notice Sets the flash loan contract and reads its ACL manager.
    /// @param approvalFlashLoan_ The flash loan contract this registry tracks availability for.
    constructor(IApprovalFlashLoan approvalFlashLoan_) {
        if (address(approvalFlashLoan_) == address(0)) revert InvalidZeroAddress();

        IACLManager aclManager_ = approvalFlashLoan_.aclManager();
        if (address(aclManager_) == address(0)) revert InvalidZeroAddress();

        approvalFlashLoan = approvalFlashLoan_;
        aclManager = aclManager_;
    }

    function pause() external onlyPauserRole {
        _pause();
    }

    function unpause() external onlyAdminRole {
        _unpause();
    }

    /// @notice Resets lender participation by moving registry logic to a fresh empty registry set.
    /// @dev Old registry set storage remains on-chain but is ignored by all lender participation logic.
    function resetRegistrySet() external onlyBookKeeperRole whenNotPaused {
        currentRegistrySetId++;

        emit RegistrySetReset(currentRegistrySetId);
    }

    /// @notice Enables or disables self-service participation updates.
    /// @param isEnabled Whether any address can call self-service participation update functions.
    function setPermissionlessParticipationEnabled(bool isEnabled) external onlyAdminRole whenNotPaused {
        permissionlessParticipationEnabled = isEnabled;

        emit PermissionlessParticipationUpdated(isEnabled);
    }

    /// @notice Indicates that the caller can participate as a lender for multiple tokens.
    /// @param tokens The token addresses the caller can lend.
    function indicateParticipation(address[] calldata tokens) external whenNotPaused {
        if (!permissionlessParticipationEnabled) revert PermissionlessParticipationDisabled();
        if (tokens.length == 0) return;

        uint256 registrySetId = currentRegistrySetId;
        address lender = msg.sender;
        uint256 lenderId = _getOrCreateLenderIndex(registrySetId, lender);
        uint256 wordIndex = _wordIndex(lenderId);
        uint256 bitMask = _bitMask(lenderId);

        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            if (token == address(0)) revert InvalidZeroAddress();
            if (approvalFlashLoan.blacklistedTokens(token)) revert TokenBlacklisted(token);

            uint256 bitmapWord = tokenLenderBitmap[registrySetId][token][wordIndex];
            // if the lender bit is not set yet
            if (bitmapWord & bitMask == 0) {
                tokenLenderBitmap[registrySetId][token][wordIndex] = bitmapWord | bitMask;  // flip the lender bit to 1
                _increaseTokenLenderCount(registrySetId, token, 1);
            }
        }
    }

    /// @notice Indicates participation for multiple tokens and lender sets.
    /// @param lenderParticipations Token addresses and lenders that can lend each token.
    function indicateParticipationFor(LenderParticipation[] calldata lenderParticipations) external onlyBookKeeperRole whenNotPaused {
        uint256 registrySetId = currentRegistrySetId;

        for (uint256 i = 0; i < lenderParticipations.length; i++) {
            address token = lenderParticipations[i].token;
            if (token == address(0)) revert InvalidZeroAddress();
            if (approvalFlashLoan.blacklistedTokens(token)) revert TokenBlacklisted(token);

            address[] calldata lenders = lenderParticipations[i].lenders;
            if (lenders.length == 0) continue;

            BitmapUpdate[] memory updates = new BitmapUpdate[](lenders.length);
            uint256 updateCount;

            for (uint256 j = 0; j < lenders.length; j++) {
                address lender = lenders[j];
                if (lender == address(0)) revert InvalidZeroAddress();

                uint256 lenderId = _getOrCreateLenderIndex(registrySetId, lender);
                uint256 wordIndex = _wordIndex(lenderId);
                uint256 bitMask = _bitMask(lenderId);

                (uint256 updateIndex, bool found) = _findBitmapUpdate(updates, updateCount, wordIndex);
                if (!found) {
                    uint256 bitmapWord = tokenLenderBitmap[registrySetId][token][wordIndex];
                    updates[updateCount] = BitmapUpdate({
                        wordIndex: wordIndex,
                        originalWord: bitmapWord,
                        updatedWord: bitmapWord,
                        delta: 0
                    });
                    updateIndex = updateCount;
                    updateCount++;
                }

                if (updates[updateIndex].updatedWord & bitMask == 0) {
                    updates[updateIndex].updatedWord = updates[updateIndex].updatedWord | bitMask;
                    updates[updateIndex].delta++;
                }
            }

            _writeBitmapUpdates(registrySetId, token, updates, updateCount);
            for (uint256 j = 0; j < updateCount; j++) {
                if (updates[j].delta != 0) {
                    _increaseTokenLenderCount(registrySetId, token, updates[j].delta);
                }
            }
        }
    }

    /// @notice Removes the caller's participation for the given tokens.
    /// @param tokens The token addresses the caller no longer wants to lend.
    function removeParticipation(address[] calldata tokens) external whenNotPaused {
        if (!permissionlessParticipationEnabled) revert PermissionlessParticipationDisabled();

        uint256 registrySetId = currentRegistrySetId;
        address lender = msg.sender;
        uint256 lenderId = lenderIndex[registrySetId][lender];
        if (lenderId == 0) return;

        uint256 wordIndex = _wordIndex(lenderId);
        uint256 bitMask = _bitMask(lenderId);

        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            uint256 bitmapWord = tokenLenderBitmap[registrySetId][token][wordIndex];
            if (bitmapWord & bitMask == 0) continue;

            tokenLenderBitmap[registrySetId][token][wordIndex] = bitmapWord & ~bitMask;  // flip the lender bit to 0
            _decreaseTokenLenderCount(registrySetId, token, 1);
        }
    }

    /// @notice Removes participation for multiple tokens and lender sets.
    /// @param lenderParticipations Token addresses and lenders to remove for each token.
    function removeParticipationFor(LenderParticipation[] calldata lenderParticipations) external onlyBookKeeperRole whenNotPaused {
        uint256 registrySetId = currentRegistrySetId;

        for (uint256 i = 0; i < lenderParticipations.length; i++) {
            address token = lenderParticipations[i].token;
            if (token == address(0)) revert InvalidZeroAddress();

            address[] calldata lenders = lenderParticipations[i].lenders;
            if (lenders.length == 0) continue;

            BitmapUpdate[] memory updates = new BitmapUpdate[](lenders.length);
            uint256 updateCount;

            for (uint256 j = 0; j < lenders.length; j++) {
                address lender = lenders[j];
                if (lender == address(0)) revert InvalidZeroAddress();

                uint256 lenderId = lenderIndex[registrySetId][lender];
                if (lenderId == 0) continue;

                uint256 wordIndex = _wordIndex(lenderId);
                uint256 bitMask = _bitMask(lenderId);

                (uint256 updateIndex, bool found) = _findBitmapUpdate(updates, updateCount, wordIndex);
                if (!found) {
                    uint256 bitmapWord = tokenLenderBitmap[registrySetId][token][wordIndex];
                    updates[updateCount] = BitmapUpdate({
                        wordIndex: wordIndex,
                        originalWord: bitmapWord,
                        updatedWord: bitmapWord,
                        delta: 0
                    });
                    updateIndex = updateCount;
                    updateCount++;
                }

                if (updates[updateIndex].updatedWord & bitMask != 0) {
                    updates[updateIndex].updatedWord = updates[updateIndex].updatedWord & ~bitMask;
                    updates[updateIndex].delta++;
                }
            }

            _writeBitmapUpdates(registrySetId, token, updates, updateCount);
            for (uint256 j = 0; j < updateCount; j++) {
                if (updates[j].delta != 0) {
                    _decreaseTokenLenderCount(registrySetId, token, updates[j].delta);
                }
            }
        }
    }

    /// @notice Returns all non-blacklisted potential tokens and each lender with a non-zero available amount for that token.
    /// @dev Available amount is the lower of lender balance and allowance to the flash loan contract.
    function getAllPotentialLendersAvailability() external view returns (TokenLenderAvailability[] memory tokenLenderAvailability) {
        uint256 registrySetId = currentRegistrySetId;
        address[] storage activePotentialTokenList = potentialTokenList[registrySetId];
        uint256 availableTokenCount;

        for (uint256 i = 0; i < activePotentialTokenList.length; i++) {
            address token = activePotentialTokenList[i];
            if (!approvalFlashLoan.blacklistedTokens(token)) {
                availableTokenCount++;
            }
        }

        tokenLenderAvailability = new TokenLenderAvailability[](availableTokenCount);

        uint256 availabilityIndex;

        for (uint256 i = 0; i < activePotentialTokenList.length; i++) {
            address token = activePotentialTokenList[i];
            if (approvalFlashLoan.blacklistedTokens(token)) continue;

            uint256 lenderCount = tokenLenderCount[registrySetId][token];
            address[] memory lenders = new address[](lenderCount);
            uint256[] memory availableAmounts = new uint256[](lenderCount);
            uint256 availableLenderCount = _populateAvailability(registrySetId, token, lenders, availableAmounts);
            assembly ("memory-safe") {
                mstore(lenders, availableLenderCount) // shrink the memory array by updating the length word to a lower value
                mstore(availableAmounts, availableLenderCount)
            }

            tokenLenderAvailability[availabilityIndex].token = token;
            tokenLenderAvailability[availabilityIndex].lenders = lenders;
            tokenLenderAvailability[availabilityIndex].availableAmounts = availableAmounts;

            availabilityIndex++;
        }
    }

    /// @notice Returns the potential lenders registered for a non-blacklisted token with non-zero available amounts.
    /// @dev Available amount is the lower of lender balance and allowance to the flash loan contract.
    /// @param token The token address to query.
    function getPotentialLendersAvailabilityByToken(address token) external view returns (LenderAvailability[] memory lenderAvailability) {
        if (approvalFlashLoan.blacklistedTokens(token)) return lenderAvailability;

        uint256 registrySetId = currentRegistrySetId;
        address[] storage activeLenderList = lenderList[registrySetId];
        uint256 lenderCount = tokenLenderCount[registrySetId][token];
        lenderAvailability = new LenderAvailability[](lenderCount);
        IERC20 asset = IERC20(token);
        uint256 participatingLenderCount;
        uint256 availabilityIndex;

        for (uint256 i = 0; i < activeLenderList.length && participatingLenderCount < lenderCount; i++) {
            uint256 lenderId = i + 1;
            if (!_isParticipating(registrySetId, token, lenderId)) continue;

            participatingLenderCount++;
            address lender = activeLenderList[i];
            uint256 availableAmount = _availableAmount(asset, lender);
            if (availableAmount == 0) continue;

            lenderAvailability[availabilityIndex] = LenderAvailability({
                lender: lender,
                availableAmount: availableAmount
            });
            availabilityIndex++;
        }

        assembly ("memory-safe") {
            mstore(lenderAvailability, availabilityIndex)
        }
    }

    /// @notice Returns available amounts for a user-provided lender list and token.
    /// @dev Available amount is the lower of lender balance and allowance to the flash loan contract.
    /// @param token The token address to query.
    /// @param lenders The lender addresses to query. This input is independent from registry storage.
    function getAvailableAmountsByTokenAndLenders(address token, address[] calldata lenders)
        external
        view
        returns (uint256[] memory availableAmounts)
    {
        availableAmounts = new uint256[](lenders.length);
        if (approvalFlashLoan.blacklistedTokens(token)) return availableAmounts;

        IERC20 asset = IERC20(token);
        for (uint256 i = 0; i < lenders.length; i++) {
            availableAmounts[i] = _availableAmount(asset, lenders[i]);
        }
    }

    /// @notice Returns the total number of lenders registered in the current registry set.
    function getTotalPotentialLenders() external view returns (uint256) {
        return lenderList[currentRegistrySetId].length;
    }

    /// @notice Returns whether the token has registered lenders and is not blacklisted.
    function potentialTokens(address token) external view returns (bool) {
        return tokenLenderCount[currentRegistrySetId][token] != 0 && !approvalFlashLoan.blacklistedTokens(token);
    }

    function _populateAvailability(
        uint256 registrySetId,
        address token,
        address[] memory lenders,
        uint256[] memory availableAmounts
    ) private view returns (uint256 availabilityIndex) {
        address[] storage activeLenderList = lenderList[registrySetId];
        IERC20 asset = IERC20(token);
        uint256 participatingLenderCount;

        for (uint256 i = 0; i < activeLenderList.length && participatingLenderCount < lenders.length; i++) {
            uint256 lenderId = i + 1;
            if (!_isParticipating(registrySetId, token, lenderId)) continue;

            participatingLenderCount++;
            address lender = activeLenderList[i];
            uint256 availableAmount = _availableAmount(asset, lender);
            if (availableAmount == 0) continue;

            lenders[availabilityIndex] = lender;
            availableAmounts[availabilityIndex] = availableAmount;
            availabilityIndex++;
        }
    }

    function _availableAmount(IERC20 asset, address lender) private view returns (uint256) {
        uint256 balance;
        try asset.balanceOf(lender) returns (uint256 bal) {
            balance = bal;
        } catch {
            balance = 0;
        }

        uint256 allowance;
        try asset.allowance(lender, address(approvalFlashLoan)) returns (uint256 alw) {
            allowance = alw;
        } catch {
            allowance = 0;
        }

        return balance < allowance ? balance : allowance;
    }

    function _getOrCreateLenderIndex(uint256 registrySetId, address lender) private returns (uint256) {
        uint256 index = lenderIndex[registrySetId][lender];
        if (index == 0) {
            lenderList[registrySetId].push(lender);
            index = lenderList[registrySetId].length;
            lenderIndex[registrySetId][lender] = index;
        }

        return index;
    }

    function _isParticipating(uint256 registrySetId, address token, uint256 lenderId) private view returns (bool) {
        return tokenLenderBitmap[registrySetId][token][_wordIndex(lenderId)] & _bitMask(lenderId) != 0;
    }

    function _wordIndex(uint256 lenderId) private pure returns (uint256) {
        return (lenderId - 1) / 256;
    }

    function _bitMask(uint256 lenderId) private pure returns (uint256) {
        return 1 << ((lenderId - 1) % 256);
    }

    function _increaseTokenLenderCount(uint256 registrySetId, address token, uint256 delta) private {
        uint256 currentCount = tokenLenderCount[registrySetId][token];
        if (currentCount == 0) {
            potentialTokenList[registrySetId].push(token);
            potentialTokenListIndex[registrySetId][token] = potentialTokenList[registrySetId].length;
        }

        tokenLenderCount[registrySetId][token] = currentCount + delta;
    }

    function _decreaseTokenLenderCount(uint256 registrySetId, address token, uint256 delta) private {
        uint256 newCount = tokenLenderCount[registrySetId][token] - delta;
        tokenLenderCount[registrySetId][token] = newCount;

        if (newCount == 0) {
            uint256 tokenIdx = potentialTokenListIndex[registrySetId][token] - 1;
            uint256 lastTokenIdx = potentialTokenList[registrySetId].length - 1;
            if (tokenIdx != lastTokenIdx) {
                address lastToken = potentialTokenList[registrySetId][lastTokenIdx];
                potentialTokenList[registrySetId][tokenIdx] = lastToken;
                potentialTokenListIndex[registrySetId][lastToken] = tokenIdx + 1;
            }

            potentialTokenList[registrySetId].pop();
            delete potentialTokenListIndex[registrySetId][token];
        }
    }

    function _findBitmapUpdate(
        BitmapUpdate[] memory updates,
        uint256 updateCount,
        uint256 wordIndex
    ) private pure returns (uint256, bool) {
        for (uint256 i = 0; i < updateCount; i++) {
            if (updates[i].wordIndex == wordIndex) {
                return (i, true);
            }
        }

        return (0, false);
    }

    function _writeBitmapUpdates(
        uint256 registrySetId,
        address token,
        BitmapUpdate[] memory updates,
        uint256 updateCount
    ) private {
        for (uint256 i = 0; i < updateCount; i++) {
            if (updates[i].updatedWord != updates[i].originalWord) {
                tokenLenderBitmap[registrySetId][token][updates[i].wordIndex] = updates[i].updatedWord;
            }
        }
    }

}
