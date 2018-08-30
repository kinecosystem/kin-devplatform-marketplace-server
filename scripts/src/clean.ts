import { getConfig } from "./public/config"; // must be the first import
getConfig();

import * as db from "./models/orders";
import { close as closeModels, init as initModels } from "./models";

initModels(true).then(async () => {
	await db.Order.updateUncompletedOrders();
	await closeModels();
});
