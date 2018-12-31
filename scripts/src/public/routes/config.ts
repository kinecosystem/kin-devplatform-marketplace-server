import { KeyMap } from "../../utils";
import { getConfig } from "../config";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { BlockchainConfig, getBlockchainConfig } from "../services/payment";
import { getDefaultLogger } from "../../logging";
import { getJwtKeys } from "../services/internal_service";
import { getAppBlockchainVersion as getAppBlockchainVersionService } from "../services/applications";
import serveStatic = require("serve-static");
import { app } from "../app";

const CONFIG = getConfig();
let JWT_KEYS: KeyMap;
// one time get config from payment service
let BLOCKCHAIN: BlockchainConfig;

export async function init() {
	BLOCKCHAIN = await getBlockchainConfig("2", getDefaultLogger());
	JWT_KEYS = await getJwtKeys();
}

export type ConfigResponse = {
	jwt_keys: KeyMap,
	blockchain: BlockchainConfig;
	bi_service: string;
	webview: string;
	environment_name: string;
	ecosystem_service: string;
};

export const getConfigHandler = async function(req: Request, res: Response, next: NextFunction) {
	const data: ConfigResponse = {
		jwt_keys: await getJwtKeys(),
		blockchain: await getBlockchainConfig("2", getDefaultLogger()),
		bi_service: CONFIG.bi_service,
		webview: CONFIG.webview,
		environment_name: CONFIG.environment_name,
		ecosystem_service: CONFIG.ecosystem_service
	};
	res.status(200).send(data);
} as RequestHandler;

export type GetAppBlockchainVersionRequest = Request & {
	params: {
		app_id: string;
	};
};

export const getAppBlockchainVersion = async function(req: GetAppBlockchainVersionRequest, res: Response) {
	const app_id = req.params.app_id;
	const data: string = await getAppBlockchainVersionService(app_id);
	res.status(200).send(data);
} as any as RequestHandler;
