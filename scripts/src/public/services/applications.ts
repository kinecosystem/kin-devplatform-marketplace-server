import { LoggerInstance } from "winston";

import { verify as verifyJwt } from "../jwt";
import { InvalidApiKey, NoSuchApp } from "../../errors";
import { Application, AppWhitelists } from "../../models/applications";
import { BlockchainVersion } from "../../models/offers";

export type RegisterPayload = {
	user_id: string;
	api_key: string;
};
export type SignInContext = {
	appId: string;
	appUserId: string;
};

export async function validateRegisterJWT(jwt: string, logger: LoggerInstance): Promise<SignInContext> {
	const decoded = await verifyJwt<RegisterPayload, "register">(jwt, logger);
	const appId = decoded.payload.iss;
	const appUserId = decoded.payload.user_id;

	return { appUserId, appId };
}

export async function validateWhitelist(
	appUserId: string, apiKey: string, logger: LoggerInstance): Promise<SignInContext> {
	// check if apiKey matches appId
	const app = await Application.findOne({ apiKey });
	if (!app) {
		throw InvalidApiKey(apiKey);
	}

	// check if userId is whitelisted in app
	logger.info(`checking if ${ appUserId } is whitelisted for ${ app.id }`);
	const result = await AppWhitelists.findOne({ appUserId, appId: app.id });
	if (result) {
		return { appUserId, appId: app.id };
	}
	// XXX raise an exception
	logger.warn(`user ${appUserId} not found in whitelist for app ${ app.id }`);

	return { appUserId, appId: app.id };
}

export async function getAppBlockchainVersion(app_id: string): Promise<BlockchainVersion> {
	const app = await Application.findOneById(app_id);
	if (!app) {
		throw NoSuchApp(app_id);
	}
	return app.config.blockchain_version;
}

export async function setAppBlockchainVersion(app_id: string, blockchain_version: BlockchainVersion): Promise<void> {
	const app = await Application.findOneById(app_id);
	if (!app) {
		throw NoSuchApp(app_id);
	}

	app.config.blockchain_version = blockchain_version;
	app.save();
}
