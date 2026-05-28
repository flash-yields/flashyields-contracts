import type { UserConfig } from "rocketh/types";
import * as deployExtension from "@rocketh/deploy";
import * as readExecuteExtension from "@rocketh/read-execute";

export const config = {
  accounts: {
    deployer: {
      default: 0, // refer to privateKeyArr in hardhat.config.ts
    },
  },
  data: {},
} as const satisfies UserConfig;

const extensions = {
  ...deployExtension,
  ...readExecuteExtension,
};

type Extensions = typeof extensions;
type Accounts = typeof config.accounts;
type Data = typeof config.data;

export { extensions };
export type { Extensions, Accounts, Data };
