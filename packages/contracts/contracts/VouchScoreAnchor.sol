// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title VouchScoreAnchor
/// @notice The scorer publishes every score it writes, so scores have an
/// on-chain, indexable history rather than only a current value.
///
/// @dev Why this exists at all: the live score lives as an `agent:score` text
/// record on the agent's PermissionedResolver, which only ever holds the latest
/// value. Anchoring each computation here gives the subgraph a time series, lets
/// anyone audit that a published score matched the evidence available when it
/// was computed, and makes a score *moving* visible — which is the point of the
/// dispute demo.
contract VouchScoreAnchor {
    /// @param agentId       ERC-8004 identity
    /// @param score         0..1000
    /// @param evidenceRoot  merkle root over the attestations the score was derived from
    /// @param components    packed component breakdown, so the score is auditable, not a black box
    event ScoreAnchored(
        uint256 indexed agentId,
        uint16 score,
        bytes32 evidenceRoot,
        bytes components,
        uint64 timestamp
    );

    event ScorerChanged(address indexed previous, address indexed next);

    error NotScorer(address caller);
    error ScoreOutOfRange(uint16 score);
    error ZeroAddress();

    /// @notice The only address permitted to anchor scores.
    /// @dev Deliberately mirrors the ENS resolver grant: the same key holds
    /// `agent:score` write permission there and anchoring rights here. One
    /// principal, one authority, enforced in two places.
    address public scorer;

    /// @dev Latest anchored score per agent, for cheap reads without an indexer.
    mapping(uint256 => uint16) public latestScore;
    mapping(uint256 => uint64) public latestTimestamp;

    modifier onlyScorer() {
        if (msg.sender != scorer) revert NotScorer(msg.sender);
        _;
    }

    constructor(address scorer_) {
        if (scorer_ == address(0)) revert ZeroAddress();
        scorer = scorer_;
        emit ScorerChanged(address(0), scorer_);
    }

    /// @notice Publish a score computed off-chain from indexed evidence.
    function anchor(uint256 agentId, uint16 score, bytes32 evidenceRoot, bytes calldata components)
        external
        onlyScorer
    {
        if (score > 1000) revert ScoreOutOfRange(score);

        latestScore[agentId] = score;
        latestTimestamp[agentId] = uint64(block.timestamp);

        emit ScoreAnchored(agentId, score, evidenceRoot, components, uint64(block.timestamp));
    }

    /// @notice Anchor several agents in one transaction.
    /// @dev The indexer recomputes in batches; without this, a reindex after a
    /// busy block would be one transaction per agent.
    function anchorBatch(
        uint256[] calldata agentIds,
        uint16[] calldata scores,
        bytes32[] calldata evidenceRoots,
        bytes[] calldata components
    ) external onlyScorer {
        uint256 n = agentIds.length;
        require(
            scores.length == n && evidenceRoots.length == n && components.length == n,
            "length mismatch"
        );

        for (uint256 i = 0; i < n; ++i) {
            if (scores[i] > 1000) revert ScoreOutOfRange(scores[i]);
            latestScore[agentIds[i]] = scores[i];
            latestTimestamp[agentIds[i]] = uint64(block.timestamp);
            emit ScoreAnchored(
                agentIds[i], scores[i], evidenceRoots[i], components[i], uint64(block.timestamp)
            );
        }
    }

    /// @notice Rotate the scorer key.
    function setScorer(address next) external onlyScorer {
        if (next == address(0)) revert ZeroAddress();
        emit ScorerChanged(scorer, next);
        scorer = next;
    }
}
