import { setupEnvironmentFromFiles } from "@rocketh/node";
import { setupHardhatDeploy } from "hardhat-deploy/helpers";
import { extensions, type Accounts, type Data, type Extensions } from "./config.js";

const { loadAndExecuteDeploymentsFromFiles } = setupEnvironmentFromFiles<Extensions, Accounts, Data>(extensions);
const { loadEnvironmentFromHardhat } = setupHardhatDeploy<Extensions, Accounts, Data>(extensions);

export { loadEnvironmentFromHardhat, loadAndExecuteDeploymentsFromFiles };
