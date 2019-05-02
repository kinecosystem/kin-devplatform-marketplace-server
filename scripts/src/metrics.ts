import { StatsD } from "hot-shots";

import { getConfig } from "./config";
import { MarketplaceError } from "./errors";
import { Order } from "./models/orders";
import { User } from "./models/users";

// XXX can add general tags to the metrics (i.e. - public/ internal, machine name etc)
const statsd = new StatsD(Object.assign({ prefix: "marketplace_" }, getConfig().statsd));

export function userRegister(newUser: boolean, walletCreated: boolean, appId: string) {
	statsd.increment("user_register", 1, undefined, { new_user: newUser.toString(), app_id: appId });
}

export function userActivate(newUser: boolean) {
	statsd.increment("user_activate", 1, undefined, { new_user: "true" });
}

export function maxWalletsExceeded(appId: string) {
	statsd.increment("max_wallets_exceeded", 1, { app_id: appId });
}

export function timeRequest(time: number, method: string, path: string, appId: string) {
	statsd.timing("request", time, { method, path, app_id: appId });
}

export function createOrder(orderType: "marketplace" | "external", offerType: "earn" | "spend" | "pay_to_user", offerId: string, appId: string) {
	statsd.increment("create_order", 1, undefined, { order_type: orderType, offer_type: offerType, app_id: appId });
}

export function submitOrder(offerType: "earn" | "spend" | "pay_to_user", offerId: string, appId: string) {
	statsd.increment("submit_order", 1, undefined, { offer_type: offerType, app_id: appId  });
}

export function completeOrder(offerType: "earn" | "spend" | "pay_to_user", offerId: string, appId: string, prevStatus: string, time: number) {
	statsd.increment("complete_order", 1, undefined, { offer_type: offerType, app_id: appId });
	// time from last status
	statsd.timing("complete_order_time", time, undefined, { offer_type: offerType, prev_status: prevStatus });
}

export function offersReturned(numOffers: number, appId: string) {
	statsd.histogram("offers_returned", numOffers, { app_id: appId } );
}

export function reportClientError(error: MarketplaceError, headers: { [name: string]: string }, appId: string) {
	const data = Object.assign({ status: error.status.toString(), title: error.title, app_id: appId }, headers);
	statsd.increment("client_error", 1, undefined, data);
}

export function reportServerError(method: string, path: string, appId: string) {
	statsd.increment("server_error", 1, undefined, { method, path, app_id: appId });
}

export function walletAddressUpdate(appId: string) {
	statsd.increment("wallet_address_update_succeeded", 1, { app_id: appId });
}

export function orderFailed(order: Order, relatedUser?: User) {
	function safeString(str: string): string {
		return str.replace(/\W/g, " ");
	}

	const unknownError = { error: "unknown_error", message: "unknown error", code: -1 };
	const unknownUser = { id: "no_id", appId: "no_id", appUserId: "no_id", walletAddress: "no_wallet" };

	const error = order.error || unknownError;
	const user = relatedUser || unknownUser;

	const message = `
## Order <${order.id}> transitioned to failed state:
ID: <${order.id}> | Type: ${order.type} | Origin: ${order.origin}
UserId: ${user.id} | AppId: <${user.appId}> | UserAppId: ${user.appUserId}
Wallet: ${user.walletAddress}
Error: ${safeString(error.message)} | Code: ${error.code}
CreatedDate: ${order.createdDate.toISOString()} | LastDate: ${(order.currentStatusDate || order.createdDate).toISOString()}
`;
	const title = safeString(error.message);
	statsd.event(title, message,
		{ alert_type: "warning" },
		{
			order_type: order.type,
			app_id: user.appId,
			order_id: order.id,
			order_origin: order.origin,
			type: "failed_order"
		});
}
