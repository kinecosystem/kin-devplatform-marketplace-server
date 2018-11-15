import { Request, Response, RequestHandler } from "express";
import { InvalidWalletAddress, NoSuchApp, UnknownSignInType } from "../../errors";

import {
	getOrCreateUserCredentials,
	activateUser as activateUserService
} from "../services/users";
import {
	SignInContext,
	validateRegisterJWT,
	validateWhitelist
} from "../services/applications";
import { Application, SignInType } from "../../models/applications";
import { getConfig } from "../config";
import * as dbOrders from "../../models/orders";
import * as metrics from "../../metrics";

export type WalletData = { wallet_address: string };

type CommonSignInData = {
	sign_in_type: "jwt" | "whitelist";
	device_id: string;
	wallet_address: string;
};

type JwtSignInData = CommonSignInData & {
	sign_in_type: "jwt";
	jwt: string;
};

type WhitelistSignInData = CommonSignInData & {
	sign_in_type: "whitelist";
	user_id: string;
	api_key: string;
};

type RegisterRequest = Request & { body: WhitelistSignInData | JwtSignInData };

/**
 * sign in a user,
 * allow either registration with JWT or plain userId to be checked against a whitelist from the given app
 */
export const signInUser = async function(req: RegisterRequest, res: Response) {
	let context: SignInContext;
	const data: WhitelistSignInData | JwtSignInData = req.body;

	req.logger.info("signing in user", { data });
	// XXX should also check which sign in types does the application allow
	if (data.sign_in_type === "jwt") {
		context = await validateRegisterJWT(data.jwt!, req.logger);
	} else if (data.sign_in_type === "whitelist") {
		context = await validateWhitelist(data.user_id, data.api_key, req.logger);
	} else {
		throw UnknownSignInType((data as any).sign_in_type);
	}

	const app = await Application.findOneById(context.appId);
	if (!app) {
		throw NoSuchApp(context.appId);
	}
	if (!app.supportsSignInType(data.sign_in_type, getConfig().sign_in_types as SignInType[])) {
		throw UnknownSignInType((data as any).sign_in_type);
	}

	const authToken = await getOrCreateUserCredentials(
		app,
		context.appUserId,
		context.appId,
		data.wallet_address,
		data.device_id,
		req.logger);

	res.status(200).send(authToken);
} as any as RequestHandler;

export type UpdateUserRequest = Request & { body: WalletData };

export const updateUser = async function(req: UpdateUserRequest, res: Response) {
	const context = 
	
	req.context;
	const walletAddress = req.body.wallet_address;
	const userId = context.user!.id;
	req.logger.info(`updating user ${ walletAddress }`, { walletAddress, userId });

	if (!walletAddress || walletAddress.length !== 56) {
		throw InvalidWalletAddress(walletAddress);
	}

	context.user!.walletAddress = walletAddress;
	await context.user!.save();

	metrics.walletAddressUpdate();
	res.status(204).send();
} as any as RequestHandler;

/**
 * user activates by approving TOS
 */
export const activateUser = async function(req: Request, res: Response) {
	const authToken = await activateUserService(req.context.token!, req.context.user!, req.logger);
	res.status(200).send(authToken);
} as any as RequestHandler;

export const remainingDailyOffers = async function(userId: string): Promise<number> {
	const max_daily_earn_offers = getConfig().max_daily_earn_offers;
	if (max_daily_earn_offers !== null) {
		return max_daily_earn_offers - await dbOrders.Order.countToday(userId, "earn");
	}
	return 0;
};
