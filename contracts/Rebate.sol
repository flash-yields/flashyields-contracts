// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "./dependencies/openzeppelin-v5.0.1/token/ERC20/IERC20.sol";
import {SafeERC20} from "./dependencies/openzeppelin-v5.0.1/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "./dependencies/openzeppelin-v5.0.1/utils/cryptography/MerkleProof.sol";
import "./dependencies/openzeppelin-v5.0.1/utils/Pausable.sol";
import {IACLManager} from "./interfaces/IACLManager.sol";
import {IRebate} from "./interfaces/IRebate.sol";
import {IVotingEscrow} from "./interfaces/IVotingEscrow.sol";
import {IWETH} from "./interfaces/IWETH.sol";
import "./libraries/InputValidator.sol";
import "./dependencies/openzeppelin-v5.0.1/utils/ReentrancyGuard.sol";

contract Rebate is Pausable, IRebate, ReentrancyGuard {

    using SafeERC20 for IERC20;

    IACLManager public aclManager;
    IWETH public immutable weth;
    IERC20 public immutable protocolToken;
    IVotingEscrow public immutable veToken;

    struct MerkleRootInfo {
        bool isStake;
        uint248 minUnlockDuration;
    }
    // category --> MerkleRootInfo
    mapping(bytes32 => MerkleRootInfo) public merkleRootInfo;
    // category --> merkleRoot
    mapping(bytes32 => bytes32) public merkleRoot;
    bool public isRestrictedMode;
    
    // user address --> category --> merkleRoot --> isClaimed
    mapping(address => mapping(bytes32 => mapping(bytes32 => bool))) public rewardClaimed;
    mapping(address => uint256) public dailyWithdrawalCap;
	mapping(address => uint256) public currentDailyWithdrawalAmount;
	mapping(address => uint256) public lastWithdrawalTime;
    mapping(address => bool) public depositWhitelist;
    
    constructor(IACLManager _aclManager, address[] memory _token, uint256[] memory _cap, IWETH _weth, IERC20 _protocolToken, IVotingEscrow _veToken) {
        InputValidator.validateAddr(address(_aclManager));
        if (_token.length != _cap.length) {
            revert InvalidArrayLength();
        }
        aclManager = _aclManager;
        uint256 length = _token.length;
        weth = _weth;
        protocolToken = _protocolToken;
        veToken = _veToken;
        for (uint256 i = 0; i < length; i++) {
            InputValidator.validateAddr(_token[i]);
            dailyWithdrawalCap[_token[i]] = _cap[i];
            emit DailyWithdrawalCapChanged(_token[i], _cap[i]);
        }
    }

    modifier onlyPauserRole() {
		aclManager.checkPauserRole(msg.sender);
		_;
	}

    modifier onlyAdminRole() {
		aclManager.checkAdminRole(msg.sender);
		_;
	}

    modifier onlyTimelockRole() {
		aclManager.checkTimelockRole(msg.sender);
		_;
	}

    modifier onlyBookKeeperRole() {
		aclManager.checkBookKeeperRole(msg.sender);
		_;
	}

    modifier onlyDepositor() {
		if (depositWhitelist[msg.sender] == false) {
            revert DepositNotAllowed();
        }
		_;
	}
    
    function pause() external onlyPauserRole {
        _pause();
    }

    function unpause() external onlyAdminRole {
        _unpause();
    }
    

    function setAclManager(IACLManager _aclManager) external onlyTimelockRole whenNotPaused {
		InputValidator.validateAddr(address(_aclManager));
        aclManager = _aclManager;
        emit AclManagerChanged(address(_aclManager));
	}



    function setDailyWithdrawalCap(address[] calldata _token, uint256[] calldata _cap) external onlyAdminRole whenNotPaused {
        if (_token.length != _cap.length) {
            revert InvalidArrayLength();
        }
        for (uint256 i; i < _token.length; i++) {
            InputValidator.validateAddr(_token[i]);
            dailyWithdrawalCap[_token[i]] = _cap[i];
            emit DailyWithdrawalCapChanged(_token[i], _cap[i]);
        }
	}

    function startRestrictedMode() external onlyBookKeeperRole whenNotPaused {
        isRestrictedMode = true;
        emit RestrictedModeUpdated(true);
    }

    function endRestrictedMode() external onlyBookKeeperRole whenNotPaused {
        isRestrictedMode = false;
        emit RestrictedModeUpdated(false);
    }

    function setDepositorWhitelist(address[] calldata _depositorAddr, bool[] calldata _status) external onlyBookKeeperRole whenNotPaused {
        if (_depositorAddr.length != _status.length) {
            revert InvalidArrayLength();
        }
        for (uint i; i < _depositorAddr.length; i++) {
            InputValidator.validateAddr(_depositorAddr[i]);
            depositWhitelist[_depositorAddr[i]] = _status[i];
            emit DepositWhitelistStatusChanged(_depositorAddr[i], _status[i]);
        }
	}

    function updateMerkleRoot(bytes32 _newMerkleRoot, bytes32 _category) external onlyBookKeeperRole whenNotPaused {
        // can only update when restricted mode is on
        if (!isRestrictedMode) {
            revert RestrictedModeOff();
        }
        if (_newMerkleRoot == 0) {
            revert InvalidMerkleRoot();
        }
        merkleRoot[_category] = _newMerkleRoot;
        emit MerkleRootUpdated(_newMerkleRoot, _category);
    }

    function updateMerkleRootInfo(bool _isStake, uint248 _minUnlockDuration, bytes32 _category) external onlyBookKeeperRole whenNotPaused {
        // can only update when restricted mode is on
        if (!isRestrictedMode) {
            revert RestrictedModeOff();
        }
        merkleRootInfo[_category] = MerkleRootInfo(_isStake, _minUnlockDuration);
        emit MerkleRootInfoUpdated(_isStake, _minUnlockDuration, _category);
    }

    // users have to claim all token and all primary & sub wallets at once otherwise the root is marked as claimed
    function claimReward(
        ClaimEntry[] calldata _entries,
        address[] calldata _tokens,
        bytes32[] calldata _merkleProof,
        bytes32 _category,
        bool _isStake,
        uint256 _initUnlockTime // only useful for users without any lock before
    ) external nonReentrant whenNotPaused {
        uint256 initUnlockTime = (_initUnlockTime / 1 weeks) * 1 weeks;
        // can only claim when restricted mode is off
        if (isRestrictedMode) {
            revert RestrictedModeOn();
        }
        if(rewardClaimed[msg.sender][_category][merkleRoot[_category]]) {
            revert RewardAlreadyClaimed();
        }
        rewardClaimed[msg.sender][_category][merkleRoot[_category]] = true;
        if (_entries.length == 0) {
            revert InvalidArrayLength();
        }
        if (_entries[0].user != msg.sender) { // primary wallet address
            revert UnauthorizedClaim();
        }
        TokenClaim[] memory tokenClaims = new TokenClaim[](_tokens.length);
        for (uint256 i = 0; i < _tokens.length; i++) {
            tokenClaims[i].token = _tokens[i];
        }

        bytes memory packed;
        for (uint256 i = 0; i < _entries.length; i++) {
            packed = bytes.concat(packed, abi.encodePacked(_entries[i].user, _entries[i].token, _entries[i].claimAmount));
            for (uint256 j = 0; j < _tokens.length; j++) {
                if (tokenClaims[j].token == _entries[i].token) {
                    tokenClaims[j].totalClaimAmount += _entries[i].claimAmount;
                    break;
                }
            }
        }

        // Create leaf node
        bytes32 leaf = keccak256(abi.encodePacked(packed));
        // Verify the proof
        if(!MerkleProof.verify(_merkleProof, merkleRoot[_category], leaf)) {
            revert InvalidProof();
        }
        
        for (uint256 i = 0; i < _tokens.length; i++) {
            address token = _tokens[i];
            uint256 totalClaimAmount = tokenClaims[i].totalClaimAmount;
            if (totalClaimAmount == 0) {
                continue;
            }

            // reset limit after a day
            if (block.timestamp - lastWithdrawalTime[token] > 1 days) {
                lastWithdrawalTime[token] = block.timestamp;
                currentDailyWithdrawalAmount[token] = 0;
            }

            if (currentDailyWithdrawalAmount[token] + totalClaimAmount <= dailyWithdrawalCap[token]) {
                currentDailyWithdrawalAmount[token] += totalClaimAmount;
                if(IERC20(token).balanceOf(address(this)) < totalClaimAmount) {
                    revert RewardPoolOutOfFunds();
                }
                if (merkleRootInfo[_category].isStake && !_isStake) {
                    revert StakeRequired();
                }
                if (_isStake && token == address(protocolToken)) {
                    IVotingEscrow.LockedBalance memory l = veToken.locked(msg.sender);
                    protocolToken.approve(address(veToken), totalClaimAmount);
                    if (l.end > block.timestamp) {
                        if (l.end - block.timestamp < uint256(merkleRootInfo[_category].minUnlockDuration)) {
                            revert InvalidUnlockTime();
                        }
                        veToken.increase_amount_for(msg.sender, totalClaimAmount);
                        emit RewardStaked(msg.sender, totalClaimAmount, 0);
                    } else if (l.amount == 0) {
                        if (initUnlockTime <= block.timestamp) { 
                            revert InvalidUnlockTime();
                        }
                        if (initUnlockTime - block.timestamp < uint256(merkleRootInfo[_category].minUnlockDuration)) {
                            revert InvalidUnlockTime();
                        }
                        veToken.create_lock_for(msg.sender, totalClaimAmount, initUnlockTime);
                        emit RewardStaked(msg.sender, totalClaimAmount, initUnlockTime);
                    } else {
                        revert CannotStakeForExpiredLock();
                    }

                } else {
                    IERC20(token).safeTransfer(msg.sender, totalClaimAmount);
                }
                emit RewardClaimed(msg.sender, token, totalClaimAmount);
            } else {
                revert DailyWithdrawalCapReached();
            }
        }
    }

    function adminWithdraw(address[] calldata _tokenAddr, uint256[] calldata _amount, address _receiver) external onlyAdminRole whenNotPaused {
        if (_tokenAddr.length != _amount.length) {
            revert InvalidArrayLength();
        }
        InputValidator.validateAddr(_receiver);
        for (uint256 i; i < _tokenAddr.length; i++) {
            IERC20(_tokenAddr[i]).safeTransfer(_receiver, _amount[i]);
            emit Withdrawal(_tokenAddr[i], _amount[i], _receiver);
        }
    }

    function adminApprove(address[] calldata _tokenAddr, uint256[] calldata _amount, address _spender) external onlyAdminRole whenNotPaused {
        if (_tokenAddr.length != _amount.length) {
            revert InvalidArrayLength();
        }
        InputValidator.validateAddr(_spender);
        for (uint256 i; i < _tokenAddr.length; i++) {
            InputValidator.validateAddr(_tokenAddr[i]);
            IERC20(_tokenAddr[i]).forceApprove(_spender, _amount[i]);
            emit AdminApproval(_tokenAddr[i], _amount[i], _spender);
        }
    }

    function deposit() payable external onlyDepositor nonReentrant whenNotPaused {
        if(msg.value > 0) {
            IWETH(weth).deposit{value: msg.value}(); 
            emit Deposit(address(weth), msg.sender, msg.value);
        } else {
            revert InvalidDepositAmount();
        }
    }

    function deposit(address[] calldata _tokenAddr, uint256[] calldata _amount) external onlyDepositor nonReentrant whenNotPaused {
        if (_tokenAddr.length != _amount.length) {
            revert InvalidArrayLength();
        }
        for (uint256 i; i < _tokenAddr.length; i++) {
            IERC20(_tokenAddr[i]).safeTransferFrom(msg.sender, address(this), _amount[i]);
            emit Deposit(_tokenAddr[i], msg.sender, _amount[i]);
        }
    }

    
}
