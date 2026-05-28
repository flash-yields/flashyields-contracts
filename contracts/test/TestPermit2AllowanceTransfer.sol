// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "../dependencies/openzeppelin-v5.0.1/token/ERC20/IERC20.sol";
import { SafeERC20 } from "../dependencies/openzeppelin-v5.0.1/token/ERC20/utils/SafeERC20.sol";
import { ECDSA } from "../dependencies/openzeppelin-v5.0.1/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "../dependencies/openzeppelin-v5.0.1/utils/cryptography/MessageHashUtils.sol";
import { IAllowanceTransfer } from "../interfaces/IAllowanceTransfer.sol";

/// @title TestPermit2AllowanceTransfer
/// @notice Minimal Permit2 AllowanceTransfer-compatible test implementation with EIP-712 signatures.
contract TestPermit2AllowanceTransfer is IAllowanceTransfer {
    using SafeERC20 for IERC20;

    struct StoredAllowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address => mapping(address => mapping(address => StoredAllowance))) internal _allowances;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 internal constant PERMIT_DETAILS_TYPEHASH =
        keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)");
    bytes32 internal constant PERMIT_SINGLE_TYPEHASH =
        keccak256(
            "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)"
            "PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
        );
    bytes32 internal constant NAME_HASH = keccak256("Permit2");

    error InvalidSigner();
    error SignatureExpired();
    error NonceMismatch();
    error InsufficientPermit2Allowance();
    error Permit2AllowanceExpired();

    function allowance(
        address owner,
        address token,
        address spender
    ) external view returns (uint160 amount, uint48 expiration, uint48 nonce) {
        StoredAllowance memory stored = _allowances[owner][token][spender];
        return (stored.amount, stored.expiration, stored.nonce);
    }

    function permit(
        address owner,
        PermitSingle memory permitSingle,
        bytes calldata signature
    ) external {
        if (permitSingle.sigDeadline < block.timestamp) revert SignatureExpired();

        PermitDetails memory details = permitSingle.details;
        StoredAllowance memory current = _allowances[owner][details.token][permitSingle.spender];
        if (details.nonce != current.nonce) revert NonceMismatch();

        bytes32 detailsHash = keccak256(
            abi.encode(
                PERMIT_DETAILS_TYPEHASH,
                details.token,
                details.amount,
                details.expiration,
                details.nonce
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_SINGLE_TYPEHASH,
                detailsHash,
                permitSingle.spender,
                permitSingle.sigDeadline
            )
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(_domainSeparator(), structHash);

        if (ECDSA.recover(digest, signature) != owner) revert InvalidSigner();

        _allowances[owner][details.token][permitSingle.spender] = StoredAllowance({
            amount: details.amount,
            expiration: details.expiration,
            nonce: details.nonce + 1
        });
    }

    function transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) external {
        StoredAllowance storage stored = _allowances[from][token][msg.sender];
        if (stored.expiration < block.timestamp) revert Permit2AllowanceExpired();
        if (stored.amount < amount) revert InsufficientPermit2Allowance();

        stored.amount -= amount;
        IERC20(token).safeTransferFrom(from, to, amount);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, block.chainid, address(this)));
    }
}
