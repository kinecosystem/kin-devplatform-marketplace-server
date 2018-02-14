import * as jsonwebtoken from "jsonwebtoken";
import * as db from "../models/users";
import { getLogger } from "../logging";

const logger = getLogger();

export type AuthToken = {
	token: string;
	activated: boolean;
};

type JWTClaims = {
	iss: string; // issuer
	exp: number; // expiration
	iat: number; // issued at
	sub: string; // subject
};

type JWTContent = {
	header: {
		typ: string;
		alg: string;
		key: string;
	};
	payload: JWTClaims & {
		// custom claims
		user_id: string;
	};
	signature: string;
};

function getApplicationPublicKey(applicationId: string, keyId: string) {
	// return the public key for the given application.
	// an application might have multiple keys. each key identified by key_id.

	const publicKeys = {
		fancy: { 1: "sdfnksdjfhlskjfhksdf", 2: "23423423423423" },
		kik: {one: "-----BEGIN PUBLIC KEY-----\n" +
			"MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDdlatRjRjogo3WojgGHFHYLugdUWAY9iR3fy4ar" +
			"WNA1KoS8kVw33cJibXr8bvwUAUparCwlvdbH6dvEOfou0/gCFQsHUfQrSDv+MuSUMAe8jzKE4qW+j" +
			"K+xQU9a03GUnKHkkle+Q0pX/g6jXZ7r1/xAK5Do2kQ+X5xK9cipRgEKwIDAQAB\n" +
			"-----END PUBLIC KEY-----"}};

	return publicKeys[applicationId][keyId];
}

function validateJWT(jwt: string): {userId: string, appId: string} {
	const decoded = jsonwebtoken.decode(jwt, { complete: true }) as JWTContent;
	const publicKey = getApplicationPublicKey(decoded.payload.iss, decoded.header.key);

	jsonwebtoken.verify(jwt, publicKey);

	return {
		userId: decoded.payload.user_id,
		appId: decoded.payload.iss,
	};
}

export async function getOrCreateUserCredentials(
	jwt: string,
	walletAddress: string,
	deviceId: string): Promise<AuthToken> {

	const { userId , appId } = validateJWT(jwt); // throws if JWT not valid // XXX test this case
	let user = await db.User.findOne( { appId, appUserId: userId });
	if (!user) {
		// new user
		user = new db.User();
		user.appId = appId;
		user.appUserId = userId;
		user.walletAddress = walletAddress;
		await user.save();
		// create wallet with lumens:
		// kin.sdk.createWallet(user.walletAddress);
		logger.info(`creating STELLAR wallet for new user ${user.id}`);
	} else {
		logger.info(`returning existing user ${user.id}`);
	}

	const authToken = await db.AuthToken.create({
		userId: user.id,
		deviceId,
	});

	return { token: authToken.token, activated: user.activated };
}

export async function activateUser(token: string): Promise<AuthToken> {
	let authToken = await db.AuthToken.findOne({ token });
	const user = await db.User.findOneById( authToken.userId );

	if (!user.activated) {
		user.activatedDate = new Date();
		// XXX use transaction
		await user.save();

		authToken = new db.AuthToken();
		authToken.userId = user.id;
		authToken.deviceId = authToken.deviceId;
		// XXX should implement some sort of authtoken scoping that will be encoded into the token:
		// authToken.scope = {tos: true}

		// XXX we want the auth token to be some sort of encoded payload so db access isn't needed to authenticate
		// create an order for Getting Started Invisible Offer
		// order = Offers.createOrder(GETTING_STARTED_OFFER_ID)
		// order.submitEarn(); which does:
		// tx_id = kin.sdk.payTo(public_address, order.id);
		logger.info(`funding user KIN ${user.id}`);

		const txId = null; // XXX should I return tx_id here?
		// XXX should the client make a separate call to create an order and submit it like the rest of the order flows?
	} else {
		logger.info(`existing user activated ${user.id}`);
	}

	return { token: authToken.token, activated: user.activated };
}
