import { getManager } from "typeorm";
import { LoggerInstance } from "winston";

import { User, AuthToken as DbAuthToken } from "../../models/users";
import * as db from "../../models/users";

import { MaxWalletsExceeded } from "../../errors";
import * as payment from "./payment";
import { pick } from "../../utils";
import * as metrics from "../../metrics";
import { Application } from "../../models/applications";

export type AuthToken = {
	token: string;
	activated: boolean;
	expiration_date: string;
	app_id: string;
	user_id: string;
	ecosystem_user_id: string;
};

function AuthTokenDbToApi(authToken: db.AuthToken, user: db.User, logger: LoggerInstance): AuthToken {
	return {
		token: authToken.id,
		activated: user.activated,
		app_id: user.appId,
		user_id: user.appUserId,
		ecosystem_user_id: user.id,
		expiration_date: authToken.expireDate.toISOString()
	};
}

export async function getOrCreateUserCredentials(
	app: Application,
	appUserId: string,
	appId: string,
	walletAddress: string,
	deviceId: string, logger: LoggerInstance): Promise<AuthToken> {

	async function handleExistingUser(existingUser: User) {
		logger.info("found existing user", { appId, appUserId, userId: existingUser.id });
		if (existingUser.walletAddress !== walletAddress) {
			logger.warn(`existing user registered with new wallet ${existingUser.walletAddress} !== ${walletAddress}`);
			if (!app.allowsNewWallet(existingUser.walletCount)) {
				metrics.maxWalletsExceeded();
				throw MaxWalletsExceeded();
			}
			existingUser.walletCount += 1;
			existingUser.walletAddress = walletAddress;
			await existingUser.save();
			await payment.createWallet(app.config.blockchain_version, existingUser.walletAddress, existingUser.appId, existingUser.id, logger);
			metrics.userRegister(false, true);
		} else {
			metrics.userRegister(false, false);
		}
		logger.info(`returning existing user ${existingUser.id}`);
	}

	let user = await User.findOne({ appId, appUserId });
	if (!user) {
		try {
			logger.info("creating a new user", { appId, appUserId });
			user = User.new({ appUserId, appId, walletAddress });
			await user.save();
			logger.info(`creating stellar wallet for new user ${user.id}: ${user.walletAddress}`);
			await payment.createWallet(app.config.blockchain_version, user.walletAddress, user.appId, user.id, logger);
			metrics.userRegister(true, true);
		} catch (e) {
			// maybe caught a "violates unique constraint" error, check by finding the user again
			user = await User.findOne({ appId, appUserId });
			if (user) {
				logger.warn("solved user registration race condition");
				await handleExistingUser(user);
			} else {
				throw e; // some other error
			}
		}
	} else {
		await handleExistingUser(user);
	}

	// XXX should be a scope object
	let authToken = await DbAuthToken.findOne({
		where: { userId: user.id, deviceId },
		order: { createdDate: "DESC" }
	});
	if (!authToken || authToken.isAboutToExpire()) {
		authToken = await (DbAuthToken.new({ userId: user.id, deviceId }).save());
	}

	return AuthTokenDbToApi(authToken, user, logger);
}

export async function activateUser(
	authToken: db.AuthToken, user: db.User, logger: LoggerInstance): Promise<AuthToken> {

	logger.info("activating user", { userId: user.id });
	if (!user.activated) {
		await getManager().transaction(async mgr => {
			user.activatedDate = new Date();
			await mgr.save(user);

			authToken = db.AuthToken.new(pick(authToken, "userId", "deviceId"));
			await mgr.save(authToken);
			// XXX should we deactivate old tokens?
		});

		// XXX should implement some sort of authtoken scoping that will be encoded into the token:
		// authToken.scope = {tos: true}
		logger.info(`new  activated user ${user.id}`);
		metrics.userActivate(true);
	} else {
		logger.info(`existing user already activated ${user.id}`);
		metrics.userActivate(false);
	}

	return AuthTokenDbToApi(authToken, user, logger);
}
