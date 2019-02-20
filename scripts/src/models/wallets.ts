import { BaseEntity, Column, Entity, PrimaryColumn } from "typeorm";
import { register as Register } from "./index";

@Entity({ name: "wallets" })
@Register
export class Wallet extends BaseEntity {

	public static async doesExist(address: string, appId: string): Promise<boolean> {
		const query = Wallet.createQueryBuilder()
			.where("wallet_address = :address", { address })
			.andWhere("app_id = :appId", { appId });
		return query.getCount().then( count => count > 0);
	}

	public static add(address: string, appId: string): Promise<Wallet> {
		const wallet = Wallet.create();
		wallet.appId = appId;
		wallet.walletAddress = address;
		return wallet.save();
	}

	@PrimaryColumn({ name: "wallet_address" })
	public walletAddress!: string;

	@Column({ name: "app_id" })
	public appId!: string;
}
