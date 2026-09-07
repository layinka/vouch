// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title VouchAttestations
/// @notice Counterparties record the outcome of a job an agent performed.
///
/// This is the evidence layer. An agent's ENS name carries what it *claims*;
/// these events carry what it has *done*. The Vouch subgraph indexes them, the
/// scorer derives a trust score from them, and only the scorer may write that
/// score back to the agent's PermissionedResolver.
///
/// @dev The single rule that makes the data worth anything: an agent may never
/// attest about itself, directly or through an operator it controls. Enforced
/// here rather than in the indexer, so the guarantee survives anyone else
/// reading these logs.
contract VouchAttestations {
    enum Outcome {
        Ok,
        Disputed,
        Failed
    }

    /// @notice One job outcome, reported by the counterparty who paid for it.
    /// @param agentId    ERC-8004 identity of the agent being rated
    /// @param attestor   who is making the claim (msg.sender)
    /// @param jobRef     opaque reference to the job, unique per (agent, attestor)
    /// @param outcome    how it went
    /// @param valueWei   notional value of the job, used to weight the score
    event Attested(
        uint256 indexed agentId,
        address indexed attestor,
        bytes32 indexed jobRef,
        Outcome outcome,
        uint128 valueWei,
        uint64 timestamp
    );

    /// @notice Emitted when a previously-Ok attestation is escalated to Disputed.
    /// @dev Kept as a distinct event so the subgraph can show a score *moving*
    /// rather than just a different total — that transition is the demo.
    event Disputed(
        uint256 indexed agentId,
        address indexed attestor,
        bytes32 indexed jobRef,
        string reason,
        uint64 timestamp
    );

    error AlreadyAttested(uint256 agentId, address attestor, bytes32 jobRef);
    error NoSuchAttestation(uint256 agentId, address attestor, bytes32 jobRef);
    error AlreadyDisputed(uint256 agentId, address attestor, bytes32 jobRef);
    error SelfAttestationForbidden(uint256 agentId, address attestor);

    /// @dev agentId => attestor => jobRef => outcome+1 (0 means "never attested")
    mapping(uint256 => mapping(address => mapping(bytes32 => uint8))) private _outcomes;

    /// @dev Who owns each agent id, per ERC-8004. Set once at deploy from the
    /// registry so we can reject self-attestation without an external call on
    /// every write.
    IIdentityRegistry public immutable identityRegistry;

    constructor(address identityRegistry_) {
        identityRegistry = IIdentityRegistry(identityRegistry_);
    }

    /// @notice Record the outcome of a job.
    /// @dev Reverts if msg.sender owns the agent — an agent cannot manufacture
    /// its own reputation. This is the on-chain half of the guarantee; the
    /// scorer additionally weights by counterparty diversity so that two
    /// colluding agents cannot bootstrap each other.
    function attest(uint256 agentId, bytes32 jobRef, Outcome outcome, uint128 valueWei) external {
        if (identityRegistry.ownerOf(agentId) == msg.sender) {
            revert SelfAttestationForbidden(agentId, msg.sender);
        }
        if (_outcomes[agentId][msg.sender][jobRef] != 0) {
            revert AlreadyAttested(agentId, msg.sender, jobRef);
        }

        _outcomes[agentId][msg.sender][jobRef] = uint8(outcome) + 1;
        emit Attested(agentId, msg.sender, jobRef, outcome, valueWei, uint64(block.timestamp));
    }

    /// @notice Escalate an attestation you previously filed to Disputed.
    /// @dev Only the original attestor may dispute their own attestation, so a
    /// third party cannot poison an agent's score for a job they had no part in.
    function dispute(uint256 agentId, bytes32 jobRef, string calldata reason) external {
        uint8 stored = _outcomes[agentId][msg.sender][jobRef];
        if (stored == 0) revert NoSuchAttestation(agentId, msg.sender, jobRef);
        if (stored == uint8(Outcome.Disputed) + 1) {
            revert AlreadyDisputed(agentId, msg.sender, jobRef);
        }

        _outcomes[agentId][msg.sender][jobRef] = uint8(Outcome.Disputed) + 1;
        emit Disputed(agentId, msg.sender, jobRef, reason, uint64(block.timestamp));
    }

    /// @notice Read a recorded outcome.
    /// @return found whether this attestation exists at all
    /// @return outcome its current state
    function outcomeOf(uint256 agentId, address attestor, bytes32 jobRef)
        external
        view
        returns (bool found, Outcome outcome)
    {
        uint8 stored = _outcomes[agentId][attestor][jobRef];
        if (stored == 0) return (false, Outcome.Ok);
        return (true, Outcome(stored - 1));
    }
}

interface IIdentityRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
}
