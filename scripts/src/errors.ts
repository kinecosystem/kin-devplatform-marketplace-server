import { initLogger } from "./logging";

export type ApiError = {
	code: number;
	error: string;
	message: string;
};
export type HeaderValue = number | string | string[];

/**
 * Code additions (/postfix) to be added to the http status code per error.
 * The concatenation is done in the MarketplaceError ctor.
 */
const CODES = {
	Unauthorized: {
		MissingToken: 1,
		InvalidToken: 2,
		InvalidApiKey: 3,
		TOSMissingOrOldToken: 4,
		RecipientMissingTOS: 5,
	},
	NotFound: {
		App: 1,
		Offer: 2,
		Order: 3,
		PublicKey: 4,
		OfferCapReached: 5,
		User: 6
	},
	RequestTimeout: {
		OpenOrderExpired: 1,
	},
	Conflict: {
		ExternalOrderAlreadyCompleted: 1,
		ExternalEarnOfferByDifferentUser: 2,
		CompletedOrderCantTransitionToFailed: 3,
		WhitelistTransactionByDifferentUser: 4,
		TransactionMismatch: 5
	},
	InternalServerError: {
		OpenedOrdersOnly: 1,
		OpenedOrdersUnreturnable: 2,
	},
	BadRequest: {
		UnknownSignInType: 1,
		WrongJwtAlgorithm: 2,
		InvalidPollAnswers: 3,
		InvalidExternalOrderJwt: 4,
		InvalidJwtSignature: 5,
		JwtKidMissing: 6,
		InvalidWalletAddress: 7,
		MissingJwt: 8,
		MaxWalletsExceeded: 9,
		WalletWasNotCreatedInThisApp: 10,
	},
	TransactionFailed: {
		WrongSender: 1,
		WrongRecipient: 2,
		WrongAmount: 3,
		AssetUnavailable: 4,
		BlockchainError: 5,
		TransactionTimeout: 6
	}
};

export class MarketplaceError extends Error {
	public readonly title: string;
	public readonly status: number; // http status code
	public readonly code: number; // our own internal codes
	public readonly headers: { [name: string]: HeaderValue };

	constructor(status: number, index: number, title: string, message: string) {
		super(message);
		this.code = Number(status + "" + index);
		this.title = title;
		this.status = status;
		this.headers = {};
	}

	public setHeader(name: string, value: HeaderValue) {
		this.headers[name] = value;
	}

	public toJson(): ApiError {
		return {
			code: this.code,
			error: this.title,
			message: this.message
		};
	}

	public toString(): string {
		return JSON.stringify(this.toJson());
	}
}

function UnauthorizedError(index: number, message: string) {
	return new MarketplaceError(401, index, "Unauthorized Request", message);
}

export function MissingToken() {
	return UnauthorizedError(CODES.Unauthorized.MissingToken, "Request missing token");
}

export function InvalidToken(token: string) {
	return UnauthorizedError(CODES.Unauthorized.InvalidToken, `Invalid token: ${token}`);
}

export function InvalidApiKey(apiKey: string) {
	return UnauthorizedError(CODES.Unauthorized.InvalidApiKey, `invalid api key: ${apiKey}`);
}

export function TOSMissingOrOldToken() {
	return UnauthorizedError(CODES.Unauthorized.TOSMissingOrOldToken, "user is not activated or using a pre activated token");
}

export function RecipientMissingTOS() {
	return UnauthorizedError(CODES.Unauthorized.RecipientMissingTOS, "recipient is not activated");
}

function NotFoundError(index: number, message: string) {
	return new MarketplaceError(404, index, "Not Found", message);
}

export function NoSuchApp(id: string) {
	return NotFoundError(CODES.NotFound.App, `No such app: ${id}`);
}

export function NoSuchOffer(id: string) {
	return NotFoundError(CODES.NotFound.Offer, `No such offer: ${id}`);
}

export function NoSuchOrder(id: string) {
	return NotFoundError(CODES.NotFound.Order, `No such order: ${id}`);
}

export function NoSuchPublicKey(appId: string, userId: string) {
	return NotFoundError(CODES.NotFound.App, `Key "${userId}" not found for iss "${appId}"`);
}

export function NoSuchUser(appId: string, keyid: string) {
	return NotFoundError(CODES.NotFound.User, `User "${keyid}" not found for iss "${appId}"`);
}

function RequestTimeoutError(index: number, message: string) {
	return new MarketplaceError(408, index, "Request Timeout", message);
}

export function OpenOrderExpired(orderId: string) {
	return RequestTimeoutError(CODES.RequestTimeout.OpenOrderExpired, `open order ${orderId} has expired`);
}

function ConflictError(index: number, message: string) {
	return new MarketplaceError(409, index, "Conflict", message);
}

export function ExternalOrderAlreadyCompleted(orderId: string) {
	const error = ConflictError(CODES.Conflict.ExternalOrderAlreadyCompleted, "User already completed offer, or has a pending order");
	error.setHeader("Location", `/v1/orders/${orderId}`);
	return error;
}

export function ExternalEarnOfferByDifferentUser(loggedInUser: string, payToUser: string) {
	const message = `Pay to user (${payToUser}) is not the logged in user (${loggedInUser})`;
	return ConflictError(CODES.Conflict.ExternalEarnOfferByDifferentUser, message);
}

export function WhitelistTransactionByDifferentUser(loggedInUserId: string) {
	const message = `Whitelisted order is not by the user (${loggedInUserId})`;
	return ConflictError(CODES.Conflict.WhitelistTransactionByDifferentUser, message);
}

export function TransactionMismatch() {
	const message = "Requested tx envelope did not match with the expected order";
	return ConflictError(CODES.Conflict.TransactionMismatch, message);
}

export function CompletedOrderCantTransitionToFailed() {
	const message = `cant set an error message to a completed order`;
	return ConflictError(CODES.Conflict.CompletedOrderCantTransitionToFailed, message);
}

export function OfferCapReached(id: string) {
	return NotFoundError(CODES.NotFound.OfferCapReached, `Cap reached for offer: ${id}`);
}

function InternalServerError(index: number, message: string) {
	return new MarketplaceError(500, index, "Internal Server Error", message);
}

export function OpenedOrdersOnly() {
	return InternalServerError(CODES.InternalServerError.OpenedOrdersOnly, "Only opened orders should be returned");
}

export function OpenedOrdersUnreturnable() {
	return InternalServerError(CODES.InternalServerError.OpenedOrdersUnreturnable, "Opened orders should not be returned");
}

function BadRequestError(index: number, message: string) {
	return new MarketplaceError(400, index, "Bad Request", message);
}

export function UnknownSignInType(type: string) {
	return BadRequestError(CODES.BadRequest.UnknownSignInType, `Unknown sign-in type: ${type}`);
}

export function InvalidJwtSignature() {
	return BadRequestError(CODES.BadRequest.InvalidJwtSignature, `the JWT failed to verify`);
}

export function MissingJwtSignature() {
	return BadRequestError(CODES.BadRequest.MissingJwt, `Key JWT is missing`);
}

export function InvalidPollAnswers() {
	return BadRequestError(CODES.BadRequest.InvalidPollAnswers, "submitted form is invalid");
}

export function InvalidExternalOrderJwt() {
	return BadRequestError(CODES.BadRequest.InvalidExternalOrderJwt, `subject can be either "earn" or "spend"`);
}

export function JwtKidMissing() {
	return BadRequestError(CODES.BadRequest.JwtKidMissing, "kid is missing from the JWT");
}

export function MaxWalletsExceeded() {
	return BadRequestError(CODES.BadRequest.MaxWalletsExceeded, "No more wallet creations allowed");
}

function TransactionFailed(index: number, message: string) {
	return new MarketplaceError(700, index, "Transaction Failed", message);
}

export function WrongSender() {
	return TransactionFailed(CODES.TransactionFailed.WrongSender, "wrong_sender");
}

export function WrongRecipient() {
	return TransactionFailed(CODES.TransactionFailed.WrongRecipient, "wrong_recipient");
}

export function WrongAmount() {
	return TransactionFailed(CODES.TransactionFailed.WrongAmount, "wrong_amount");
}

export function AssetUnavailable() {
	return TransactionFailed(CODES.TransactionFailed.AssetUnavailable, "unavailable_asset");
}

export function BlockchainError(message?: string) {
	message = message ? (": " + message) : "";
	return TransactionFailed(CODES.TransactionFailed.BlockchainError, "blockchain_error" + message);
}

export function TransactionTimeout() {
	return TransactionFailed(CODES.TransactionFailed.TransactionTimeout, "transaction_timeout");
}

export function InvalidWalletAddress(address: string) {
	return BadRequestError(CODES.BadRequest.InvalidWalletAddress, `Invalid (not 56 characters) wallet address: ${ address }`);
}

export function WalletWasNotCreatedInThisApp(address: string, appId: string) {
	return BadRequestError(CODES.BadRequest.WalletWasNotCreatedInThisApp, `Wallet wasn't created in this app. app id: ${ appId }, Wallet address: ${ address }`);
}
