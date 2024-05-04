import { setupSingleCron } from "./cron.js";
import { setupServer } from "./server.js";

setupServer();
setupSingleCron();
// todo: setup cache clearning cron (every hour)
