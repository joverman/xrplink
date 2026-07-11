// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IXRPPayment} from "@flarenetwork/flare-periphery-contracts/coston2/IXRPPayment.sol";

contract MockFdcVerification {
    bool private _shouldVerify;

    function setShouldVerify(bool _v) external {
        _shouldVerify = _v;
    }

    function verifyXRPPayment(IXRPPayment.Proof calldata) external view returns (bool) {
        return _shouldVerify;
    }

    function fdcProtocolId() external pure returns (uint8) { return 0; }
    function relay() external view returns (address) { return address(0); }

    // Satisfy inherited interface requirements (not used in tests)
    function verifyAddressValidity(bytes32[] calldata, bytes32, bytes32, bytes32, uint64, uint64, bytes calldata) external pure returns (bool) { return true; }
    function verifyBalanceDecreasingTransaction(bytes32[] calldata, bytes32, bytes32, bytes32, uint64, uint64, bytes calldata) external pure returns (bool) { return true; }
    function verifyConfirmedBlockHeightExists(bytes32[] calldata, bytes32, bytes32, bytes32, uint64, uint64, bytes calldata) external pure returns (bool) { return true; }
    function verifyEVMTransaction(bytes32[] calldata, bytes32, bytes32, bytes32, uint64, uint64, bytes calldata) external pure returns (bool) { return true; }
    function verifyPayment(bytes32[] calldata, bytes32, bytes32, bytes32, uint64, uint64, bytes calldata) external pure returns (bool) { return true; }
    function verifyReferencedPaymentNonexistence(bytes32[] calldata, bytes32, bytes32, bytes32, uint64, uint64, bytes calldata) external pure returns (bool) { return true; }
    function verifyWeb2Json(bytes32[] calldata, bytes32, bytes32, bytes32, uint64, uint64, bytes calldata) external pure returns (bool) { return true; }
    function verifyXRPPaymentNonexistence(bytes32[] calldata, bytes32, bytes32, bytes32, uint64, uint64, bytes calldata) external pure returns (bool) { return true; }
}
