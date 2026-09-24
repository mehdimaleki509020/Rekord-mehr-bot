import { spawnSync } from "node:child_process";
const result=spawnSync(process.execPath,["--test","test/bot.test.mjs"],{stdio:"inherit"});
process.exit(result.status??1);
