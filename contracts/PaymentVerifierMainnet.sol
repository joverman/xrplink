// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.25;

import {ContractRegistry} from "@flarenetwork/flare-periphery-contracts/flare/ContractRegistry.sol";
import {IFdcVerification} from "@flarenetwork/flare-periphery-contracts/flare/IFdcVerification.sol";
import {IXRPPayment} from "@flarenetwork/flare-periphery-contracts/flare/IXRPPayment.sol";

contract PaymentVerifierMainnet {
    struct VerifiedPayment {
        bytes32 transactionId;
        string sourceAddress;
        bytes32 receivingAddressHash;
        int256 receivedAmount;
        bytes firstMemoData;
        uint256 destinationTag;
    }

    VerifiedPayment[] public verifiedPayments;
    mapping(bytes32 => bool) public processedTransactions;

    event PaymentVerified(
        bytes32 indexed transactionId,
        string indexed sourceAddress,
        int256 receivedAmount,
        bytes firstMemoData
    );

    function processPaymentProof(IXRPPayment.Proof calldata _proof) external {
        require(isProofValid(_proof), "Invalid XRP payment proof");

        bytes32 transactionId = _proof.data.requestBody.transactionId;
        IXRPPayment.ResponseBody memory response = _proof.data.responseBody;

        require(response.status == 0, "Payment not successful");
        require(!processedTransactions[transactionId], "Already processed");

        processedTransactions[transactionId] = true;
        verifiedPayments.push(VerifiedPayment({
            transactionId: transactionId,
            sourceAddress: response.sourceAddress,
            receivingAddressHash: response.receivingAddressHash,
            receivedAmount: response.receivedAmount,
            firstMemoData: response.firstMemoData,
            destinationTag: response.destinationTag
        }));

        emit PaymentVerified(
            transactionId,
            response.sourceAddress,
            response.receivedAmount,
            response.firstMemoData
        );
    }

    function isProofValid(IXRPPayment.Proof memory _proof) public view returns (bool) {
        IFdcVerification fdc = ContractRegistry.getFdcVerification();
        return fdc.verifyXRPPayment(_proof);
    }

    function getVerifiedPayments() external view returns (VerifiedPayment[] memory) {
        return verifiedPayments;
    }

    function getPaymentCount() external view returns (uint256) {
        return verifiedPayments.length;
    }
}
