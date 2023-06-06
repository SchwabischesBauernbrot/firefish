import * as os from "node:os";
import si from "systeminformation";
import define from "../define.js";
import meilisearch from "../../../db/meilisearch.js";

export const meta = {
	requireCredential: false,
	requireCredentialPrivateMode: true,

	tags: ["meta"],
} as const;

export const paramDef = {
	type: "object",
	properties: {},
	required: [],
} as const;

export default define(meta, paramDef, async () => {
	const memStats = await si.mem();
	const fsStats = await si.fsSize();
	const meilisearchStats = await meilisearchStatus();

	return {
		machine: os.hostname(),
		cpu: {
			model: os.cpus()[0].model,
			cores: os.cpus().length,
		},
		mem: {
			total: memStats.total,
		},
		fs: {
			total: fsStats[0].size,
			used: fsStats[0].used,
		},
	};
});

async function meilisearchStatus() {
	if (meilisearch) {
		return meilisearch.serverStats();
	} else {
		return {
			health: "unconfigured",
			size: 0,
			indexed_count: 0,
		};
	}
}
