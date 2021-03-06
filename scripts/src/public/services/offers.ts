import { LoggerInstance } from "winston";

import * as metrics from "../../metrics";
import * as db from "../../models/offers";
import { ModelFilters } from "../../models/index";
import * as dbOrders from "../../models/orders";
import { Paging } from "./index";
import * as offerContents from "./offer_contents";
import { Application } from "../../models/applications";
import { ContentType, OfferType } from "../../models/offers";
import { getConfig } from "../config";
import { remainingDailyMarketplaceOffers } from "../routes/users";
import * as orderDb from "../../models/orders";

export interface PollAnswer {
	content_type: "PollAnswer";
	answers: { [key: string]: string };
}

export interface Offer {
	id: string;
	title: string;
	description: string;
	image: string;
	amount: number;
	blockchain_data: db.BlockchainData;
	content: string;
	content_type: ContentType;
	offer_type: OfferType;
}

export interface OfferList {
	offers: Offer[];
	paging: Paging;
}

function offerDbToApi(offer: db.Offer, content: db.OfferContent) {
	content.content = offerContents.replaceTemplateVars(offer, content.content);
	return {
		id: offer.id,
		title: offer.meta.title,
		description: offer.meta.description,
		image: offer.meta.image,
		amount: offer.amount,
		blockchain_data: offer.blockchainData,
		offer_type: offer.type,
		content: content.content,
		content_type: content.contentType,
	};
}

async function filterOffers(userId: string, app: Application | undefined, logger: LoggerInstance): Promise<Offer[]> {
	// TODO: this should be a temp fix!
	// the app should not be undefined as we used left join, figure it out
	if (!app) {
		return [];
	}

	const completedOrdersForUser = await orderDb.Order.getAll({
		"userId": userId,
		"origin": "marketplace",
		"status": "completed"
	});

	const filteredOffers = app.offers
		.filter(offer =>
			completedOrdersForUser.find(order => order.offerId === offer.id) === undefined
		);

	return (await Promise.all(
		filteredOffers
			.map(async offer => {
				const content = await offerContents.getOfferContent(offer.id, logger);

				if (!content) {
					return null;
				}

				return offerDbToApi(offer, content);
			})
	)).filter(offer => offer !== null) as Offer[];
}

export async function getOffers(userId: string, appId: string, filters: ModelFilters<db.Offer>, logger: LoggerInstance): Promise<OfferList> {
	let offers = [] as Offer[];

	const query = Application.createQueryBuilder("app")
		.where("app.id = :appId", { appId })
		.leftJoinAndSelect("app.offers", "offer");

	if (!filters.type || filters.type === "earn") {
		offers = offers.concat(
			await filterOffers(
				userId,
				await query
					.andWhere("offer.type = :type", { type: "earn" })
					.orderBy("offer.amount", "DESC")
					.addOrderBy("offer.id", "ASC")
					.getOne(),
				logger
			)
		);
		// global earn capping
		offers = await filterDailyCap(offers, userId);
	}

	if (!filters.type || filters.type === "spend") {
		offers = offers.concat(
			await filterOffers(
				userId,
				await query
					.andWhere("offer.type = :type", { type: "spend" })
					.orderBy("offer.amount", "ASC")
					.addOrderBy("offer.id", "ASC")
					.getOne(),
				logger
			)
		);
	}

	metrics.offersReturned(offers.length, appId);
	return { offers, paging: { cursors: {} } };
}

async function filterDailyCap(offers: Offer[], userId: string) {
	offers = offers.slice(0, Math.max(0, await remainingDailyMarketplaceOffers(userId)));
	return offers;
}
