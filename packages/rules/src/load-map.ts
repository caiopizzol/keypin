import { type MapResult, parseMap } from "@keypin/core";
import { destinations, issuers, pulls, vaults } from "@keypin/connectors/rules";

const own = {
  destinations: destinations.map((kind) => ({ ...kind })),
  issuers: issuers.map((kind) => ({ ...kind })),
  vaults: vaults.map((kind) => ({ ...kind })),
  pulls: pulls.map((kind) => ({ ...kind })),
};

export function loadMap(text: string, file = "keypin.toml"): MapResult {
  return parseMap(text, file, own.destinations, own.issuers, own.vaults, own.pulls);
}
