// wrapper for the payment service
// TODO: this is used by both public and internal so should move to shared dir
import axios from "axios";
const axiosRetry = require("axios-retry"); // TODO: nitzan this fails the tests: import axiosRetry from "axios-retry";
import { LoggerInstance } from "winston";
import { performance } from "perf_hooks";

import { getConfig } from "../config";
import * as db from "../../models/orders";
import { TransactionMismatch } from "../../errors";

const config = getConfig();
const webhook = `${config.internal_service}/v1/internal/webhook`;
const client = axios.create({ timeout: 1000 });
axiosRetry(client, { retries: 3 }); // retries on 5xx errors

interface PaymentRequest {
	amount: number;
	app_id: string;
	is_external: boolean;
	recipient_address: string;
	sender_address: string;
	id: string;
	callback: string;
}

export interface Payment {
	amount: number;
	app_id: string;
	recipient_address: string;
	id: string;
	transaction_id: string;
	sender_address: string;
	timestamp: string;
}

interface WalletRequest {
	id: string;
	app_id: string;
	wallet_address: string;
	callback: string;
}

export interface Wallet {
	wallet_address: string;
	kin_balance: number;
	native_balance: number;
}

export interface Watcher {
	wallet_addresses: string[];
	order_id: string;
	callback: string;
	service_id?: string;
}

export interface WatcherRemovalPayload {
	wallet_address: string;
	order_id: string;
}

const SERVICE_ID = "marketplace";

export async function payTo(
	blockchainVersion: string, walletAddress: string, sender_address: string, appId: string, amount: number, orderId: string, isExternal: boolean, logger: LoggerInstance) {
	logger.info(`paying ${amount} to ${walletAddress} with orderId ${orderId}`);
	const payload: PaymentRequest = {
		amount,
		app_id: appId,
		is_external: isExternal,
		recipient_address: walletAddress,
		sender_address,
		id: orderId,
		callback: webhook,
	};
	const t = performance.now();
	await client.post(`${getPaymentServiceUrl(blockchainVersion)}/payments`, payload);
	console.log("pay to took " + (performance.now() - t) + "ms");
}

export async function createWallet(blockchainVersion: string, walletAddress: string, appId: string, id: string, logger: LoggerInstance) {
	const payload: WalletRequest = {
		id,
		wallet_address: walletAddress,
		app_id: appId,
		callback: webhook,
	};
	const t = performance.now();
	await client.post(`${getPaymentServiceUrl(blockchainVersion)}/wallets`, payload);
	logger.info("wallet creation took " + (performance.now() - t) + "ms");
}

export async function getWalletData(blockchainVersion: string, walletAddress: string, logger?: LoggerInstance): Promise<Wallet> {
	const res = await client.get(`${getPaymentServiceUrl(blockchainVersion)}/wallets/${walletAddress}`);
	return res.data;
}

/* not used anywhere for now
export async function getPaymentData(orderId: string, logger: LoggerInstance): Promise<Payment> {
	const res = await client.get(`${getPaymentService(blockchainVersion)}/payments/${orderId}`);
	return res.data;
}
*/

export async function addWatcherEndpoint(blockchainVersion: string, addresses: string[], orderId: string): Promise<Watcher> {
	const payload: Watcher = { wallet_addresses: addresses, order_id: orderId, callback: webhook };
	const res = await client.post(`${getPaymentServiceUrl(blockchainVersion)}/watchers/${SERVICE_ID}`, payload);
	return res.data;
}

export async function removeWatcherEndpoint(blockchainVersion: string, addresse: string, orderId: string): Promise<Watcher> {
	const payload: WatcherRemovalPayload = { wallet_address: addresse, order_id: orderId };
	const res = await client.delete(`${getPaymentServiceUrl(blockchainVersion)}/watchers/${SERVICE_ID}`, { data: payload });
	return res.data;
}

export type BlockchainConfig = {
	horizon_url: string;
	network_passphrase: string;
	asset_issuer: string;
	asset_code: string;
};

export async function getBlockchainConfig(blockchainVersion: string, logger: LoggerInstance): Promise<BlockchainConfig> {
	const res = await client.get(`${getPaymentServiceUrl(blockchainVersion)}/config`);
	return res.data;
}

export interface WhitelistTransactionRequest {
	order_id: string;
	source: string;
	destination: string;
	amount: number;
	xdr: string;
	network_id: string;
	app_id: string;
}

export async function whitelistTransaction(
	order: db.Order,
	network_id: string,
	tx_envelope: string,
	app_id: string): Promise<string> {

	const payload: WhitelistTransactionRequest = {
		order_id: order.id,
		source: order.blockchainData.sender_address!,
		destination: order.blockchainData.recipient_address!,
		amount: order.amount, 
		xdr: tx_envelope,
		network_id,
		app_id
	};

	// whitelist is only for the new payment service
	const whitelist_response = (await client.post(`${config.new_payment_service}/whitelist`, payload));
	if (whitelist_response.status === 401) {
		throw TransactionMismatch();
	}
	return whitelist_response.data.tx_envelope;
}

function getPaymentServiceUrl(blockchainVersion: string): string {
	if (blockchainVersion === "3") {
		return config.new_payment_service;
	}
	return config.payment_service;
}
