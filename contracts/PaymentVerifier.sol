// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.25;

import {ContractRegistry} from "@flarenetwork/flare-periphery-contracts/coston2/ContractRegistry.sol";
import {IFdcVerification} from "@flarenetwork/flare-periphery-contracts/coston2/IFdcVerification.sol";
import {IXRPPayment} from "@flarenetwork/flare-periphery-contracts/coston2/IXRPPayment.sol";

/**
 * @title PaymentVerifier
 * @notice Verifies XRP payments attested through Flare's FDC.
 *         This is the core smart contract for the XRPLink product.
 */
contract PaymentVerifier {
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

    /**
     * @notice Verify an XRP payment proof from FDC and record it
     * @param _proof The FDC attestation proof containing the XRP payment data
     */
    function processPaymentProof(IXRPPayment.Proof calldata _proof) external {
        // 1. FDC Verification: Verify the proof's authenticity
        require(isProofValid(_proof), "Invalid XRP payment proof");

        // 2. Extract transaction details
        bytes32 transactionId = _proof.data.requestBody.transactionId;
        IXRPPayment.ResponseBody memory response = _proof.data.responseBody;

        // 3. Ensure payment was successful and not processed before
        require(response.status == 0, "Payment not successful");
        require(!processedTransactions[transactionId], "Already processed");

        // 4. Record the verified payment
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

    /**
     * @notice Verify a proof against Flare's FDC protocol
     * @param _proof The proof to verify
     * @return bool True if the proof is valid
     */
    function isProofValid(IXRPPayment.Proof memory _proof) public view virtual returns (bool) {
        IFdcVerification fdc = ContractRegistry.getFdcVerification();
        return fdc.verifyXRPPayment(_proof);
    }

    /**
     * @notice Get all verified payments
     */
    function getVerifiedPayments() external view returns (VerifiedPayment[] memory) {
        return verifiedPayments;
    }

    /**
     * @notice Get the count of verified payments
     */
    function getPaymentCount() external view returns (uint256) {
        return verifiedPayments.length;
    }
}
