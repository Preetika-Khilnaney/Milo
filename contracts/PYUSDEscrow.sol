// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title PYUSDEscrow
/// @notice Holds PYUSD for a purchase until delivery is verified.
///  - The buyer locks funds for a merchant.
///  - The arbiter (the platform's AI verification agent) releases funds to the
///    merchant on verified delivery, or refunds the buyer on verified failure.
///  - The buyer can release early or raise a dispute before the deadline.
///  - If nobody disputes before the deadline, anyone can release to the merchant,
///    so merchants are never stuck waiting forever.
contract PYUSDEscrow {
    enum Status { None, Funded, Disputed, Released, Refunded }

    struct Deal {
        address buyer;
        address merchant;
        uint256 amount;
        uint64 deadline;
        Status status;
        bytes32 orderRef;
    }

    IERC20 public immutable token;
    address public arbiter;
    address public admin;
    uint256 public nextId = 1;

    mapping(uint256 => Deal) public deals;

    event EscrowCreated(uint256 indexed id, address indexed buyer, address indexed merchant, uint256 amount, uint64 deadline, bytes32 orderRef);
    event Disputed(uint256 indexed id, address by);
    event Released(uint256 indexed id, address by);
    event Refunded(uint256 indexed id, address by);
    event ArbiterChanged(address arbiter);

    constructor(address token_, address arbiter_) {
        token = IERC20(token_);
        arbiter = arbiter_;
        admin = msg.sender;
    }

    function setArbiter(address arbiter_) external {
        require(msg.sender == admin, "not admin");
        arbiter = arbiter_;
        emit ArbiterChanged(arbiter_);
    }

    function createEscrow(address merchant, uint256 amount, uint64 durationSeconds, bytes32 orderRef)
        external
        returns (uint256 id)
    {
        require(merchant != address(0) && merchant != msg.sender, "bad merchant");
        require(amount > 0, "zero amount");
        require(durationSeconds >= 60, "duration too short");

        id = nextId++;
        uint64 deadline = uint64(block.timestamp) + durationSeconds;
        deals[id] = Deal(msg.sender, merchant, amount, deadline, Status.Funded, orderRef);

        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        emit EscrowCreated(id, msg.sender, merchant, amount, deadline, orderRef);
    }

    function dispute(uint256 id) external {
        Deal storage d = deals[id];
        require(d.status == Status.Funded, "not funded");
        require(msg.sender == d.buyer || msg.sender == arbiter, "not allowed");
        require(block.timestamp <= d.deadline, "deadline passed");
        d.status = Status.Disputed;
        emit Disputed(id, msg.sender);
    }

    function release(uint256 id) external {
        Deal storage d = deals[id];
        require(d.status == Status.Funded || d.status == Status.Disputed, "not open");
        bool timedOut = d.status == Status.Funded && block.timestamp > d.deadline;
        require(msg.sender == arbiter || (msg.sender == d.buyer) || timedOut, "not allowed");
        d.status = Status.Released;
        require(token.transfer(d.merchant, d.amount), "transfer failed");
        emit Released(id, msg.sender);
    }

    function refund(uint256 id) external {
        Deal storage d = deals[id];
        require(d.status == Status.Funded || d.status == Status.Disputed, "not open");
        require(msg.sender == arbiter || msg.sender == d.merchant, "not allowed");
        d.status = Status.Refunded;
        require(token.transfer(d.buyer, d.amount), "transfer failed");
        emit Refunded(id, msg.sender);
    }
}
