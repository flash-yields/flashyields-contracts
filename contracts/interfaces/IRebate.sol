// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "./IACLManager.sol";


/// @title Rebate Interface
/// @notice An interface containing externally accessible functions of the Rebate contract
/// @dev The automatically generated public view functions for the state variables and mappings are not included in the interface
interface IRebate{

    /*//////////////////////////////////////////////////////////////
                            Errors
    //////////////////////////////////////////////////////////////*/

    error MerkleRootNotSet(); // Thrown when the claimReward function is called but not Merkle Root is stored in contract.
    error InvalidMerkleRoot(); // Thrown when if the merkle root to be updated is invalid
    error InvalidProof(); //Thrown if the token as already been enabled or disabled 
    error RewardAlreadyClaimed(); // Thrown if staker attempts to call deposit() with zero amount
    error RewardPoolOutOfFunds(); //Thrown if staker attempts to call withdraw() with zero amount
    error DailyWithdrawalCapReached(); // Thrown if the withdrawal hits the daily withdrawal cap for the particular token.
    error RestrictedModeOn(); // Thrown if users claim reward when restricted mode on.
    error RestrictedModeOff(); // Thrown if merkle root is updated when restricted mode off.
    error InvalidArrayLength();
    error InvalidDepositAmount(); //Thrown if user does not have sufficient balance to deposit
    error DepositNotAllowed(); //Thrown if user is not whitelisted for deposits. 
    error UnauthorizedClaim(); // Thrown if primary wallet of the claim entry is not msg.sender
    error StakeRequired(); // Thrown if staking is required for the merkle tree category but the user refuses to stake
    error InvalidUnlockTime(); // Thrown if user specified unlock time is less than the min unlock time of the merkle tree category
    error CannotStakeForExpiredLock();
    

    /*//////////////////////////////////////////////////////////////
                            Staker Events
    //////////////////////////////////////////////////////////////*/

    ///@notice Emitted an reward is successfully claimed. 
    ///@param user The user that is conducting the claim. 
    ///@param token The token that the user is claiming
    ///@param amount The amount of the reward to be claimed. 
    event RewardClaimed(address user, address token, uint256 amount);

    ///@notice Emitted an reward is successfully staked. 
    ///@param user The user that is conducting the stake. 
    ///@param amount The amount of the reward to be staked. 
    event RewardStaked(address user, uint256 amount, uint256 initUnlockTime);
    
    
    ///@notice Emitted when the Merkle Root of this contract is updated. 
    ///@param newRoot The root to be updated to. 
    event MerkleRootUpdated(bytes32 newRoot, bytes32 category);

    event MerkleRootInfoUpdated(bool isStake, uint256 minUnlockDuration, bytes32 category);

    ///@notice Emitted when ACLManager has been changed
    ///@param aclManager The address of the new ACLManager
    event AclManagerChanged(address aclManager);

    /// @notice Emitted when restricted mode is updated
    /// @param mode either true or false
    event RestrictedModeUpdated(bool mode);

    ///@notice Emitted an address is whitelisted for deposit 
    ///@param depositor The address of the depositor
    ///@param status The status of the whitelist.
	event DepositWhitelistStatusChanged(
		address depositor, bool status
	);

    ///@notice Emitted when the daily withdrawal cap is set. 
    ///@param token The token address of the cap to be implemeneted on. 
    ///@param cap The amount that is capped. 
	event DailyWithdrawalCapChanged(
		address token, uint256 cap
	);

    ///@notice Emitted when some calls the deposits function to deposit funds to the rewards contract. 
	event Deposit(
		address token, address depositor, uint256 amount
	);

    ///@notice Emitted when some calls the withdraws function to withdraw funds to the rewards contract. 
    event Withdrawal(
        address token, uint256 amount, address receiver
    );

    ///@notice Emitted when adminApprove approves a spender for tokens held by this contract.
    event AdminApproval(
        address token, uint256 amount, address spender
    );

    /*//////////////////////////////////////////////////////////////
                            Admin Functions
    //////////////////////////////////////////////////////////////*/


    ///@notice Change the ACL Manager to update the ACL 
    ///@param _aclManager address of the ACL Manager
    function setAclManager(IACLManager _aclManager) external ;

    ///@notice Pause further staking through the deposit function.
    ///@dev Only callable by the owner. Withdrawals and migrations will still be possible when paused
    function pause() external;

    ///@notice Unpause staking allowing the deposit function to be used again
    ///@dev Only callable by the owner
    function unpause() external;

    ///@notice function to set the daily withdrawal cap
    ///@param _tokenAddr The token addresses of the caps to be implemented on.
    ///@param _cap The amounts that are capped.
    function setDailyWithdrawalCap(address[] calldata _tokenAddr, uint256[] calldata _cap) external;

    ///@notice function to set depositor whitelist
    ///@param _depositorAddr The address of the depositor to be whitelisted.
    ///@param _status Enable or disaable whitelist.
    function setDepositorWhitelist(address[] calldata _depositorAddr, bool[] calldata _status) external;

    ///@notice function withdraw funds from the rewards contract to admin.
    ///@param _tokenAddr Tokens to withdraw
    ///@param amount Amounts to withdraw for each token
    ///@param _receiver Receiver of the withdrawn tokens
    function adminWithdraw(address[] calldata _tokenAddr, uint256[] calldata amount, address _receiver) external;

    ///@notice function to approve a spender to use ERC20 tokens held by this contract
    ///@param _tokenAddr The ERC20 tokens to approve
    ///@param _amount The allowance amounts corresponding to each token
    ///@param _spender The address to approve as spender
    function adminApprove(address[] calldata _tokenAddr, uint256[] calldata _amount, address _spender) external;

    /*//////////////////////////////////////////////////////////////
                            Reward Claim Functions
    //////////////////////////////////////////////////////////////*/

    ///@notice called to update the Merkle Root from the backend server
    ///@param _newMerkleRoot The Merkle Root to be updated. 
    ///@param _category The Merkle Root Category 
    ///@dev only callable by bookkeeper
    function updateMerkleRoot(bytes32 _newMerkleRoot, bytes32 _category) external;

    function updateMerkleRootInfo(bool _isStake, uint248 _minUnlockDuration, bytes32 _category) external;
    
    struct ClaimEntry {
        address user;
        address token;
        uint256 claimAmount;
    }
    struct TokenClaim {
        address token;
        uint256 totalClaimAmount;
    }
    ///@notice After the Merkle Proof is retrived from the backend server, user can call this function to claim the rewards
    ///@param _entries refer to ClaimEntry Struct
    ///@param _merkleProof Merkle Proof retrieved from backend server to verify this transaction
    ///@param _category The Merkle Root Category
    ///@dev cannot be called when the contract is paused. 
    function claimReward(
        ClaimEntry[] calldata _entries,
        address[] calldata _tokens,
        bytes32[] calldata _merkleProof,
        bytes32 _category,
        bool _isStake,
        uint256 _initUnlockTime
    ) external;

    /*//////////////////////////////////////////////////////////////
                            Other Functions
    //////////////////////////////////////////////////////////////*/
    ///@notice function to deposit native ETH to the rewards contract.
    function deposit() payable external; 


    ///@notice function to deposit funds to the rewards contract.
    ///@param _tokenAddr The token address of the deposit.
    ///@param _amount The amount to deposit.
    function deposit(address[] calldata _tokenAddr, uint256[] calldata _amount) external; 

}
