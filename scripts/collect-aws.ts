import { runAwsScan } from "../lib/collector/aws/run";

process.exit(runAwsScan(process.argv.slice(2)));
