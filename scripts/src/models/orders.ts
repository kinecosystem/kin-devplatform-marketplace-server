import * as moment from "moment";
import { DeepPartial } from "typeorm/common/DeepPartial";
import {
	Column,
	Entity,
	Brackets,
	ManyToOne,
	OneToMany,
	BaseEntity,
	PrimaryColumn,
	SelectQueryBuilder,
} from "typeorm";

import { ApiError } from "../errors";
import { generateId, IdPrefix } from "../utils";

import { User } from "./users";
import { BlockchainData, OfferType, OrderValue } from "./offers";
import { CreationDateModel, register as Register, initializer as Initializer } from "./index";
import { ObjectType } from "typeorm/common/ObjectType";

export interface OrderMeta {
	title: string;
	description: string;
	call_to_action?: string;
	content?: string;
}

export type OrderOrigin = "marketplace" | "external" | "p2p";
export type OrderStatus = "completed" | "failed" | "pending";
export type OpenOrderStatus = OrderStatus | "opened";
export type OrderStatusAndNegation = OpenOrderStatus | "!opened" | "!completed" | "!failed" | "!pending";

function updateQueryWithStatus(query: SelectQueryBuilder<any>, status?: OrderStatusAndNegation | null) {
	if (!status) {
		return;
	}

	if (status.startsWith("!")) {
		query.andWhere("status != :status", { status: status.substring(1) });
	} else {
		query.andWhere("status = :status", { status });
	}
}

function updateQueryWithFilter(query: SelectQueryBuilder<any>, name: string, value?: string | null) {
	if (!value) {
		return;
	}

	if (value.startsWith("!")) {
		query.andWhere(`${ name } != :value`, { value: value.substring(1) });
	} else {
		query.andWhere(`${ name } = :value`, { value });
	}
}

export type OrderStatic<T extends Order = Order> = {
	CLASS_ORIGIN: OrderOrigin | null;

	new(): T;
	createQueryBuilder(alias?: string): SelectQueryBuilder<BaseEntity>;
};

export type GetOrderFilters = {
	userId: string;
	offerId?: string;
	origin?: OrderOrigin;
	status?: OrderStatusAndNegation;
};

@Entity({ name: "orders" })
@Initializer("id", () => generateId(IdPrefix.Transaction))
@Initializer("expirationDate", () => moment().add(10, "minutes").toDate()) // opened expiration
@Register
export class Order extends CreationDateModel {
	/**
	 * count all offers that are completed, pending but expired, opened but not expired - i.e. not failed and not expired
	 */
	public static countByOffer(offerId: string, userId?: string): Promise<number> {
		let query = Order.createQueryBuilder("ordr"); // don't use 'order', it messed things up

		if (userId) {
			query = query
				.innerJoin("ordr.contexts", "context")
				// .where("context.user_id = :userId", { userId })
				.where("context.userId = :userId", { userId })
				// .andWhere("ordr.offer_id = :offerId", { offerId });
				.andWhere("ordr.offerId = :offerId", { offerId });
		} else {
			query = query
				// .where("ordr.offer_id = :offerId", { offerId });
				.where("ordr.offerId = :offerId", { offerId });
		}

		query = query
			.andWhere(new Brackets(qb => {
				qb.where("ordr.status = :status", { status: "completed" })
					.orWhere(
						new Brackets(qb2 => {
							qb2.where("ordr.status IN (:statuses)", { statuses: ["opened", "pending"] })
								.andWhere("ordr.expiration_date > :date", { date: new Date() });
						})
					);
			}));

		return query.getCount();
	}

	public static getOpenOrder<T extends Order>(offerId: string, userId: string): Promise<T | undefined> {
		// has at least 2 minutes to complete before expiration
		const latestExpiration = moment().add(2, "minutes").toDate();

		const query = Order.createQueryBuilder("ordr") // don't use 'order', it messed things up
			.leftJoinAndSelect("ordr.contexts", "context")
			.where("ordr.offer_id = :offerId", { offerId })
			.andWhere("ordr.status = :status", { status: "opened" })
			// .andWhere("context.user_id = :userId", { userId })
			.andWhere("context.userId = :userId", { userId })
			.andWhere("ordr.expiration_date > :date", { date: latestExpiration })
			.orderBy("ordr.expiration_date", "DESC"); // if there are a few, get the one with the most time left

		console.log("getOpenOrder QUERY: ", query.getQueryAndParameters());

		return query.getOne() as Promise<T | undefined>;
	}

	/**
	 * Returns one order with the id which was passed.
	 * If `status` is passed as well, the order will be returned only if the status matches.
	 *
	 * The status can be any one of the defined statuses or one of their negation, for example:
	 * get open order with id "id1": getOne("id1", "opened")
	 * get NOT open order: getOne("id1", "!opened")
	 */
	public static getOne<T extends Order>(this: OrderStatic<T> | Function, orderId: string, status?: OrderStatusAndNegation): Promise<T | undefined> {
		const query = (this as OrderStatic<T>).createQueryBuilder()
			.where("id = :orderId", { orderId });

		updateQueryWithStatus(query, status);

		if ((this as OrderStatic<T>).CLASS_ORIGIN) {
			query.andWhere("origin = :origin", { origin: (this as OrderStatic<T>).CLASS_ORIGIN });
		}

		return query.getOne() as Promise<T | undefined>;
	}

	public static getAll<T extends Order>(this: OrderStatic<T> | Function, filters: GetOrderFilters, limit?: number): Promise<T[]> {
		const query = (this as OrderStatic<T>).createQueryBuilder("ordr") // don't use 'order', it messed things up
			.innerJoin("ordr.contexts", "context")
			// .where("context.user_id = :userId", { userId: filters.userId })
			.where("context.userId = :userId", { userId: filters.userId })
			.orderBy("ordr.current_status_date", "DESC")
			.addOrderBy("id", "DESC");

		// updateQueryWithStatus(query, filters.status);
		updateQueryWithFilter(query, "ordr.status", filters.status);
		updateQueryWithFilter(query, "ordr.origin", filters.origin);
		updateQueryWithFilter(query, "ordr.offer_id", filters.offerId);

		/**
		 * In case `filters` doesn't contain the `origin`, include the origin of the extending class.
		 * So, when doing:
		 *  MarketplaceOrder.getAll({ userId: "..."})
		 * It will add `origin: "marketplace"` to the filters.
		 *
		 * When doing:
		 *  ExternalOrder.getAll({ userId: "..."})
		 * It will add `origin: "external"` to the filters.
		 *
		 * When doing:
		 *  Order.getAll({ userId: "..."})
		 * No origin is added
		 */
		if (!filters.origin && (this as OrderStatic<T>).CLASS_ORIGIN) {
			query.andWhere("ordr.origin = :origin", { origin: (this as OrderStatic<T>).CLASS_ORIGIN });
		}

		if (limit) {
			query.limit(limit);
		}

		return query.getMany() as Promise<T[]>;
	}

	@Column()
	public readonly origin!: OrderOrigin;

	@Column()
	public type!: OfferType;

	@Column("simple-json", { name: "blockchain_data", nullable: true })
	public blockchainData!: BlockchainData;

	@OneToMany(type => OrderContext, context => context.order)
	public contexts: OrderContext[] = [];

	@Column({ name: "offer_id" })
	public offerId!: string;

	@Column("simple-json", { nullable: true })
	public error?: ApiError| null;

	@Column()
	public amount!: number;

	@Column()
	public status!: OpenOrderStatus;

	@Column({ name: "current_status_date", nullable: true })
	public currentStatusDate?: Date;

	@Column("simple-json", { nullable: true })
	public value?: OrderValue;

	@Column({ name: "expiration_date", nullable: true })
	public expirationDate?: Date;

	public setStatus(status: OpenOrderStatus) {
		this.status = status;
		this.currentStatusDate = new Date();
		switch (this.status) {
			case "pending":
				this.expirationDate = moment(this.currentStatusDate).add(45, "seconds").toDate();
				break;
			case "opened":
				this.expirationDate = moment(this.currentStatusDate).add(10, "minutes").toDate();
				break;
			default:
				this.expirationDate = null as any;
		}
	}

	public isExpired(): boolean {
		if (this.expirationDate) {
			return this.expirationDate < new Date();
		}
		return false;
	}

	public isExternalOrder() {
		return this.origin === "external";
	}

	public isMarketplaceOrder() {
		return this.origin === "marketplace";
	}

	public get sender(): User | null {
		for (const context of this.contexts) {
			if (context.role === "sender") {
				return context.user;
			}
		}

		return null;
	}

	public get senderMeta(): OrderMeta | null {
		for (const context of this.contexts) {
			if (context.role === "sender") {
				return context.meta;
			}
		}

		return null;
	}

	public get recipient(): User | null {
		for (const context of this.contexts) {
			if (context.role === "recipient") {
				return context.user;
			}
		}

		return null;
	}

	public get recipientMeta(): OrderMeta | null {
		for (const context of this.contexts) {
			if (context.role === "recipient") {
				return context.meta;
			}
		}

		return null;
	}
}

@Entity({ name: "orders_contexts" })
@Register
export class OrderContext extends BaseEntity {
	public static new(this: ObjectType<OrderContext>, data?: DeepPartial<OrderContext>): OrderContext {
		return (this as typeof BaseEntity).create(data!) as OrderContext;
	}

	// @PrimaryColumn({ name: "order_id" })
	@PrimaryColumn()
	public readonly orderId!: string;

	// @PrimaryColumn({ name: "user_id" })
	@PrimaryColumn()
	public readonly userId!: string;

	@ManyToOne(type => Order, order => order.contexts)
	public readonly order!: Order;

	@ManyToOne(type => User, user => user.contexts)
	public readonly user!: User;

	@Column()
	public readonly role!: "sender" | "recipient";

	@Column("simple-json")
	public readonly meta!: OrderMeta;
}

export type MarketplaceOrder = Order;

export const MarketplaceOrder = {
	ORIGIN: "marketplace",
	"new"(data?: DeepPartial<Order>): MarketplaceOrder {
		const instance = Order.new(data) as MarketplaceOrder;
		(instance as any).origin = MarketplaceOrder.ORIGIN;
		return instance;
	}
};

export type ExternalOrder = Order;

export const ExternalOrder = {
	ORIGIN: "external",
	"new"(data?: DeepPartial<Order>): ExternalOrder {
		const instance = Order.new(data) as ExternalOrder;
		(instance as any).origin = ExternalOrder.ORIGIN;

		return instance;
	}
};
