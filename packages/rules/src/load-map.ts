import { type MapResult, readSecretspec, SECRETSPEC_FILE } from "@keypin/core";
import { destinations, issuers, pulls, vaults } from "@keypin/connectors/rules";

const own = {
  destinations: destinations.map((kind) => ({ ...kind })),
  issuers: issuers.map((kind) => ({ ...kind })),
  vaults: vaults.map((kind) => ({ ...kind })),
  pulls: pulls.map((kind) => ({ ...kind })),
};

export function loadMap(text: string, file = SECRETSPEC_FILE): MapResult {
  return readSecretspec(text, file, own.destinations, own.issuers, own.vaults, own.pulls);
}
