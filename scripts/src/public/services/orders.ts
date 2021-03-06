import { LoggerInstance } from "winston";

import { pick } from "../../utils";
import { lock } from "../../redis";
import * as metrics from "../../metrics";
import { User } from "../../models/users";
import * as db from "../../models/orders";
import * as offerDb from "../../models/offers";
import { OrderValue } from "../../models/offers";
import { Application } from "../../models/applications";
import { validateExternalOrderJWT } from "../services/native_offers";
import {
	ApiError,
	NoSuchApp,
	CompletedOrderCantTransitionToFailed,
	ExternalOrderAlreadyCompleted,
	InvalidPollAnswers, MarketplaceError,
	NoSuchOffer,
	NoSuchOrder,
	OfferCapReached,
	OpenedOrdersOnly,
	OpenedOrdersUnreturnable,
	OpenOrderExpired,
	TransactionTimeout,
	RecipientMissingTOS,
	NoSuchUser
} from "../../errors";

import { Paging } from "./index";
import * as payment from "./payment";
import { addWatcherEndpoint } from "./payment";
import * as offerContents from "./offer_contents";
import { ExternalEarnOrderJWT, ExternalSpendOrderJWT, ExternalPayToUserOrderJwt } from "./native_offers";
import {
	create as createEarnTransactionBroadcastToBlockchainSubmitted
} from "../../analytics/events/earn_transaction_broadcast_to_blockchain_submitted";
import { remainingDailyMarketplaceOffers } from "../routes/users";
import { getAppBlockchainVersion } from "./applications";

export interface OrderList {
	orders: Order[];
	paging: Paging;
}

export interface BaseOrder {
	id: string;
	offer_id: string;
	offer_type: offerDb.OfferType;
	title: string;
	description: string;
	amount: number;
	blockchain_data: offerDb.BlockchainData;
}

export interface OpenOrder extends BaseOrder {
	expiration_date: string;
}

export interface Order extends BaseOrder {
	error?: ApiError | null;
	content?: string; // json serialized payload of the coupon page
	status: db.OrderStatus;
	completion_date: string; // UTC ISO
	result?: OrderValue;
	call_to_action?: string;
	origin: db.OrderOrigin;
}

export async function getOrder(orderId: string, logger: LoggerInstance): Promise<Order> {
	const order = await db.Order.getOne(orderId, "!opened") as db.MarketplaceOrder | db.ExternalOrder;

	if (!order) {
		throw NoSuchOrder(orderId);
	}

	checkIfTimedOut(order); // no need to wait for the promise

	logger.debug("getOne returning", { orderId, status: order.status, offerId: order.offerId, userId: order.userId });
	return orderDbToApi(order);
}

export async function getOrderForWhitelisting(orderId: string): Promise<db.MarketplaceOrder| db.ExternalOrder> {
	// Get order, regardless of status
	const order = await db.Order.getOne(orderId) as db.MarketplaceOrder | db.ExternalOrder;

	if (!order) {
		throw NoSuchOrder(orderId);
	}
	return order;
}

export async function changeOrder(orderId: string, change: Partial<Order>, logger: LoggerInstance): Promise<Order> {
	const order = await db.Order.getOne(orderId, "!opened") as db.MarketplaceOrder | db.ExternalOrder;

	if (!order) {
		throw NoSuchOrder(orderId);
	}
	if (order.status === "completed") {
		throw CompletedOrderCantTransitionToFailed();
	}
	order.error = change.error;
	order.status = "failed";
	await order.save();

	logger.debug("order patched with error", { orderId, userId: order.userId, error: change.error });
	return orderDbToApi(order);
}

async function createOrder(offer: offerDb.Offer, user: User) {
	if (await remainingDailyMarketplaceOffers(user.id) === 0) {
		return undefined;
	}
	const app = await Application.findOneById(user.appId);
	if (!app) {
		throw NoSuchApp(user.appId);
	}
	const { senderAddress, recipientAddress } = await extractMarketplaceOrderWalletAddresses(user, offer, app);
	const order = db.MarketplaceOrder.new({
		userId: user.id,
		type: offer.type,
		status: "opened",
		offerId: offer.id,
		amount: offer.amount,
		// TODO if order meta content is a template:
		// replaceTemplateVars(offer, offer.meta.order_meta.content!)
		meta: offer.meta.order_meta,
		blockchainData: {
			sender_address: senderAddress,
			recipient_address: recipientAddress,
			blockchain_version: app.config.blockchain_version
		}
	});

	if (order.type === "spend" && recipientAddress) {
		await addWatcherEndpoint(order.blockchainData.blockchain_version!, [recipientAddress], order.id);
	}

	await order.save();
	metrics.createOrder("marketplace", offer.type, offer.id, user.appId);

	return order;
}

async function extractMarketplaceOrderWalletAddresses(user: User, offer: offerDb.Offer, app: Application) {
	const senderAddress = offer.type === "spend" ? user.walletAddress : await selectSenderAddress(app.config.blockchain_version, app.walletAddresses.sender, offer.amount);
	// spend marketplace offers shouldn't exists in production, and sending the funds to app wallet instead root wallet requires
	// client change, for now keep it like before (client pay to root wallet address)
	const recipientAddress = offer.type === "spend" ? offer.blockchainData.recipient_address : user.walletAddress;
	return { senderAddress, recipientAddress };
}

export async function createMarketplaceOrder(offerId: string, user: User, logger: LoggerInstance): Promise<OpenOrder> {
	logger.info("creating marketplace order for", { offerId, userId: user.id });
	const offer = await offerDb.Offer.findOneById(offerId);
	if (!offer) {
		throw NoSuchOffer(offerId);
	}

	const order = await lock(getLockResource("get", offerId, user.id), async () =>
		(await db.Order.getOpenOrder(offerId, user.id)) ||
		(await lock(getLockResource("create", offerId), () => createOrder(offer, user)))
	);

	if (!order) {
		throw OfferCapReached(offerId);
	}

	logger.info("created new open marketplace order", order);

	return openOrderDbToApi(order);
}

export async function createExternalOrder(jwt: string, user: User, logger: LoggerInstance): Promise<OpenOrder> {
	const payload = await validateExternalOrderJWT(jwt, user.appUserId, logger);

	let order = await db.Order.findOne({ userId: user.id, offerId: payload.offer.id });

	if (!order || order.status !== "opened") {
		const completedOrders = await db.Order.getCompletedOrder( user.id, payload.offer.id);
		if (order && completedOrders != null) {
			throw ExternalOrderAlreadyCompleted(order.id);
		} // else order.status === "failed" - act as if order didn't exist

		const app = await Application.findOneById(user.appId);
		if (!app) {
			throw NoSuchApp(user.appId);
		}

		let title: string;
		let description: string;
		let sender_address: string;
		let recipient_address: string;
		let requestPayload: ExternalPayToUserOrderJwt;
		let recipient_user: User | undefined;
		let recipient_title: string | undefined;
		let recipient_description: string | undefined;
		if (payload.sub === "earn") {
			title = (payload as ExternalEarnOrderJWT).recipient.title;
			description = (payload as ExternalEarnOrderJWT).recipient.description;
			sender_address = await selectSenderAddress(app.config.blockchain_version, app.walletAddresses.sender, (payload as ExternalEarnOrderJWT).offer.amount);
			recipient_address = user.walletAddress;
		} else if (payload.sub === "spend") {
			// spend or pay_to_user
			title = (payload as ExternalSpendOrderJWT).sender.title;
			description = (payload as ExternalSpendOrderJWT).sender.description;
			sender_address = user.walletAddress;
			recipient_address = app.walletAddresses.recipient;
		} else {
			// p2p
			requestPayload = (payload as ExternalPayToUserOrderJwt);
			title = requestPayload.sender.title;
			description = requestPayload.sender.description;
			sender_address = user.walletAddress;
			recipient_user = await User.findOne({ appId: app.id, appUserId: requestPayload.recipient.user_id });
			if (!recipient_user) {
				throw NoSuchUser(app.id, requestPayload.recipient.user_id);
			}
			if (!recipient_user.activated) {
				throw RecipientMissingTOS();
			}
			recipient_title = requestPayload.recipient.title;
			recipient_description = requestPayload.recipient.description;
			recipient_address = recipient_user.walletAddress;
		}

		order = db.ExternalOrder.new({
			userId: user.id,
			recipientId: recipient_user ? recipient_user.id : undefined,
			offerId: payload.offer.id,
			amount: payload.offer.amount,
			type: payload.sub,
			status: "opened",
			meta: {
				title,
				description
			},
			recipientMeta: recipient_title ? {
				title: recipient_title,
				description: recipient_description
			} : undefined,
			blockchainData: {
				sender_address,
				recipient_address,
				blockchain_version: app.config.blockchain_version
			}
		});

		if (order.type === "pay_to_user") {
			await addWatcherEndpoint(order.blockchainData.blockchain_version!, [recipient_address], order.id);
		} else if (order.type === "spend") {
			await addWatcherEndpoint(order.blockchainData.blockchain_version!, [app.walletAddresses.recipient], order.id);
		}

		await order.save();
		metrics.createOrder("external", payload.sub, payload.offer.id, user.appId);

		logger.info("created new open external order", {
			offerId: payload.offer.id,
			userId: user.id,
			orderId: order.id
		});
	}

	return openOrderDbToApi(order);
}

export async function submitOrder(
	orderId: string, form: string | undefined, walletAddress: string, appId: string, logger: LoggerInstance): Promise<Order> {

	const order = await db.Order.findOne({ id: orderId }) as db.MarketplaceOrder | db.ExternalOrder;
	if (!order) {
		throw NoSuchOrder(orderId);
	}
	if (order.status !== "opened") {
		return orderDbToApi(order);
	}
	if (order.isExpired()) {
		throw OpenOrderExpired(orderId);
	}

	if (order.isMarketplaceOrder()) {
		const offer = await offerDb.Offer.findOneById(order.offerId);
		if (!offer) {
			throw NoSuchOffer(order.offerId);
		}

		if (order.type === "earn") {
			const offerContent = (await offerContents.getOfferContent(order.offerId, logger))!;
			switch (offerContent.contentType) {
				// TODO this switch-case should be inside the offerContents module
				case "poll":
					// validate form
					if (!offerContents.isValid(offerContent, form)) {
						throw InvalidPollAnswers();
					}
					await offerContents.savePollAnswers(order.userId, order.offerId, orderId, form); // TODO should we also save quiz results?
					break;
				case "quiz":
					order.amount = offerContents.sumCorrectQuizAnswers(offerContent, form) || 1; // TODO remove || 1 - don't give idiots kin
					// should we replace order.meta.content
					break;
				case "tutorial":
					// nothing
					break;
				default:
					logger.warn(`unexpected content type ${offerContent.contentType}`);
			}

		}

	}

	order.setStatus("pending");
	order.blockchainData.blockchain_version = await getAppBlockchainVersion(appId);
	await order.save();
	logger.info("order changed to pending", { orderId });

	if (order.type === "earn") {
		await payment.payTo(order.blockchainData.blockchain_version!, walletAddress, order.blockchainData.sender_address!, appId, order.amount, order.id, true, logger);
		createEarnTransactionBroadcastToBlockchainSubmitted(order.userId, order.offerId, order.id).report();
	}

	metrics.submitOrder(order.type, order.offerId, appId);
	return orderDbToApi(order);
}

export async function cancelOrder(orderId: string, logger: LoggerInstance): Promise<void> {
	// you can only delete an open order - not a pending order
	const order = await db.Order.getOne(orderId, "opened");
	if (!order) {
		throw NoSuchOrder(orderId);
	}

	await order.remove();
}

export async function getOrderHistory(
	userId: string,
	filters: { origin?: db.OrderOrigin; offerId?: string; },
	logger: LoggerInstance,
	limit: number = 25,
	before?: string,
	after?: string): Promise<OrderList> {

	// XXX use the cursor input values
	const status: db.OrderStatusAndNegation = "!opened";
	const orders = await db.Order.getAll(
		Object.assign({}, filters, { userId, status }),
		limit
	) as Array<db.MarketplaceOrder | db.ExternalOrder>;

	return {
		orders: orders.map(order => {
			checkIfTimedOut(order); // no need to wait for the promise
			return orderDbToApi(order, userId);
		}),
		paging: {
			cursors: {
				after: "MTAxNTExOTQ1MjAwNzI5NDE",
				before: "NDMyNzQyODI3OTQw",
			},
			previous: "https://api.kinmarketplace.com/v1/orders?limit=25&before=NDMyNzQyODI3OTQw",
			next: "https://api.kinmarketplace.com/v1/orders?limit=25&after=MTAxNTExOTQ1MjAwNzI5NDE=",
		},
	};
}

function openOrderDbToApi(order: db.Order): OpenOrder {
	if (order.status !== "opened") {
		throw OpenedOrdersOnly();
	}
	return {
		id: order.id,
		offer_id: order.offerId,
		offer_type: order.type,
		amount: order.amount,
		title: order.meta.title,
		// make sure to return empty string in description instead on null
		description: order.meta.description == null ? "" : order.meta.description,
		blockchain_data: order.blockchainData,
		expiration_date: order.expirationDate!.toISOString()
	};
}

function orderDbToApi(order: db.Order, userId?: string): Order {
	if (order.status === "opened") {
		throw OpenedOrdersUnreturnable();
	}

	if (userId && order.recipientId === userId && order.recipientMeta) {
		order.meta = order.recipientMeta;
	}
	const apiOrder = Object.assign(
		pick(order, "id", "origin", "status", "amount"), {
			result: order.value,
			offer_type: order.type,
			offer_id: order.offerId,
			title: order.meta.title,
			error: order.error as ApiError,
			blockchain_data: order.blockchainData,
			completion_date: (order.currentStatusDate || order.createdDate).toISOString()
		}, pick(order.meta, "title", "description", "content", "call_to_action")) as Order;
	// make sure to return empty string in description instead on null
	if (apiOrder.description == null) {
		apiOrder.description = "";
	}
	return apiOrder;
}

export async function setFailedOrder(order: db.Order, error: MarketplaceError, failureDate?: Date): Promise<db.Order> {
	order.setStatus("failed");
	order.currentStatusDate = failureDate || order.currentStatusDate;
	order.error = error.toJson();
	const user = await User.findOneById(order.userId);
	metrics.orderFailed(order, user);
	return await order.save();
}

function checkIfTimedOut(order: db.Order): Promise<void> {
	// TODO This should be done in a cron that runs every 10 minutes and closes these orders
	if (order.status === "pending" && order.isExpired()) {
		return setFailedOrder(order, TransactionTimeout(), order.expirationDate) as any;
	}

	return Promise.resolve();
}

function getLockResource(type: "create" | "get", ...ids: string[]) {
	return `locks:orders:${type}:${ids.join(":")}`;
}

export async function selectSenderAddress(blockchainVersion: string, db_sender_address: string, amount: Number): Promise<string> {
	const our_wallet = db_sender_address.split(",")[0];
	const joined_wallet = db_sender_address.split(",")[1];

	const our_balance = (await payment.getWalletData(blockchainVersion, our_wallet)).kin_balance;
	if (our_balance > amount) {
		return our_wallet;
	}
	return joined_wallet;
}
