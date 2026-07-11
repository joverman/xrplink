// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {PaymentVerifier} from "../PaymentVerifier.sol";
import {IFdcVerification} from "@flarenetwork/flare-periphery-contracts/coston2/IFdcVerification.sol";
import {IXRPPayment} from "@flarenetwork/flare-periphery-contracts/coston2/IXRPPayment.sol";

contract TestPaymentVerifier is PaymentVerifier {
    IFdcVerification public mockFdc;

    function setMockFdc(IFdcVerification _fdc) external {
        mockFdc = _fdc;
    }

    function isProofValid(IXRPPayment.Proof memory _proof) public view override returns (bool) {
        return mockFdc.verifyXRPPayment(_proof);
    }
}
